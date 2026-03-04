import * as fs from "node:fs";
import * as path from "node:path";
import { OrchestrationCore } from "../core/index.js";
import type { RetryScheduled } from "../core/types.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createDispatcher, flushNotificationDigest } from "./dispatcher.js";
import { exportState } from "./state-export.js";
import { initJournalRepo } from "./journal.js";
import { cleanupStaleWorktrees } from "./worktree.js";

// ---------------------------------------------------------------------------
// Lock file
// ---------------------------------------------------------------------------

function acquireLock(lockPath: string): void {
  const dir = path.dirname(lockPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Check for stale lock
  if (fs.existsSync(lockPath)) {
    try {
      const pidStr = fs.readFileSync(lockPath, "utf-8").trim();
      const pid = parseInt(pidStr, 10);
      if (!Number.isNaN(pid)) {
        try {
          process.kill(pid, 0); // Check if process is alive
          console.error(`[daemon] Another instance is running (PID ${pid}). Exiting.`);
          process.exit(1);
        } catch (err: unknown) {
          const code = (err as NodeJS.ErrnoException).code;
          if (code === "EPERM") {
            // Process IS running but owned by a different user — not stale
            console.error(`[daemon] Another instance is running as a different user (PID ${pid}). Exiting.`);
            process.exit(1);
          }
          // ESRCH — process not running, stale lock
          console.log(`[daemon] Removing stale lock file (PID ${pid})`);
        }
      }
    } catch {
      // Can't read lock file, remove it
    }
  }

  fs.writeFileSync(lockPath, String(process.pid) + "\n");
}

function releaseLock(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Ignore — shutdown
  }
}

// ---------------------------------------------------------------------------
// Startup reconciliation
// ---------------------------------------------------------------------------

/**
 * On daemon restart, the in-memory activeRuns map is lost. Tasks that were
 * "active" when the previous daemon died will stay active forever because
 * AgentExited was never submitted (so lastAgentExitAt is null and the clock
 * reaper can't fire). This function detects those orphans and moves them to
 * retryWait so they can be re-dispatched.
 */
function reconcileOrphanedTasks(core: OrchestrationCore): void {
  const state = core.getState();
  const now = Date.now();
  let reconciled = 0;

  for (const task of Object.values(state.tasks)) {
    if (task.terminal !== null) continue;
    if (task.condition !== "active" && task.condition !== "leased") continue;
    if (task.phase === null) continue;

    const event: RetryScheduled = {
      type: "RetryScheduled",
      taskId: task.id,
      ts: now,
      fenceToken: task.currentFenceToken,
      reason: "orphaned_on_restart",
      retryAfter: now + 1_000,
      phase: task.phase,
      attemptNumber: Math.max(1, task.attempts[task.phase].used),
    };

    const result = core.submit(event);
    if (result.ok) {
      reconciled++;
    } else {
      console.warn(`[daemon] Could not reconcile T${task.id}: ${result.error.message}`);
    }
  }

  if (reconciled > 0) {
    console.log(`[daemon] Reconciled ${reconciled} orphaned task(s) from previous run`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  console.log("[daemon] Starting taskcore daemon");
  console.log(`[daemon]   port=${config.port}`);
  console.log(`[daemon]   backend=${config.persistenceBackend}`);
  console.log(`[daemon]   db=${config.dbPath}`);
  console.log(`[daemon]   eventLogDir=${config.eventLogDir}`);
  console.log(`[daemon]   workspace=${config.workspaceDir}`);
  console.log(`[daemon]   maxConcurrent=${config.maxConcurrent}`);

  // Ensure data directories exist
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }
  if (config.persistenceBackend === "jsonl") {
    fs.mkdirSync(config.eventLogDir, { recursive: true });
    fs.mkdirSync(path.join(config.eventLogDir, "snapshots"), { recursive: true });
  }

  // Acquire lock
  acquireLock(config.lockFile);

  // Initialize core
  const core = new OrchestrationCore({
    dbPath: config.dbPath,
    eventLogDir: config.eventLogDir,
    persistenceBackend: config.persistenceBackend,
    invariantChecks: true,
    snapshotEvery: 50,
  });
  console.log(`[daemon] Core initialized. Tasks: ${Object.keys(core.getState().tasks).length}`);

  // Reconcile orphaned active tasks from previous daemon lifetime
  reconcileOrphanedTasks(core);

  // Initialize journal repo
  try {
    initJournalRepo(config.journalRepoPath);
    console.log(`[daemon] Journal repo ready at ${config.journalRepoPath}`);
  } catch (err) {
    console.error("[daemon] Journal repo init failed (non-fatal):", err);
  }

  // Cleanup stale worktrees from previous crashes
  try {
    const cleaned = cleanupStaleWorktrees(config.worktreeBaseDir);
    if (cleaned > 0) {
      console.log(`[daemon] Cleaned up ${cleaned} stale worktree(s)`);
    }
  } catch (err) {
    console.error("[daemon] Worktree cleanup failed (non-fatal):", err);
  }

  // Create dispatcher
  const dispatcher = createDispatcher(core, config);

  // Start HTTP server
  const server = createHttpServer(core, config);
  await new Promise<void>((resolve) => {
    server.listen(config.port, "127.0.0.1", () => {
      console.log(`[daemon] HTTP server listening on 127.0.0.1:${config.port}`);
      resolve();
    });
  });

  // Tick loop — auto-events (lease expiry, backoff, cost recovery, etc.)
  const tickInterval = setInterval(() => {
    try {
      const result = core.tick(Date.now());
      if (!result.ok) {
        console.error(`[daemon] Tick error: ${result.error.message} (task=${result.error.taskId ?? "?"}, event=${result.error.eventType ?? "?"})`);
      } else if (result.value > 0) {
        console.log(`[daemon] Tick processed ${result.value} auto-event(s)`);
      }
    } catch (err) {
      console.error("[daemon] Tick exception:", err);
    }
  }, config.tickIntervalMs);

  // Dispatch loop
  const dispatchInterval = setInterval(() => {
    try {
      dispatcher.runOnce();
    } catch (err) {
      console.error("[daemon] Dispatch exception:", err);
    }
  }, config.dispatchIntervalMs);

  // State export loop (dashboard compatibility)
  try {
    exportState(core, config);
    console.log("[daemon] Initial state export complete");
  } catch (err) {
    console.error("[daemon] Initial state export error:", err);
  }

  const exportInterval = setInterval(() => {
    try {
      exportState(core, config);
    } catch (err) {
      console.error("[daemon] State export error:", err);
    }
  }, 30_000);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[daemon] Received ${signal}, shutting down...`);

    clearInterval(tickInterval);
    clearInterval(dispatchInterval);
    clearInterval(exportInterval);

    // Stop accepting new connections
    server.close();

    // Flush any pending notification digest
    flushNotificationDigest();

    // Kill active agents
    dispatcher.stopAll();

    // Final tick to process any pending events
    try {
      core.tick(Date.now());
    } catch {
      // Ignore
    }

    // Close core (saves snapshot)
    core.close();
    console.log("[daemon] Core closed, snapshot saved");

    releaseLock(config.lockFile);
    console.log("[daemon] Shutdown complete");
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));

  console.log("[daemon] Ready. Tick every %dms, dispatch every %dms",
    config.tickIntervalMs,
    config.dispatchIntervalMs,
  );
}

main().catch((err) => {
  console.error("[daemon] Fatal error:", err);
  process.exit(1);
});
