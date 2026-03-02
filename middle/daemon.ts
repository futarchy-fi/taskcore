import * as fs from "node:fs";
import * as path from "node:path";
import { OrchestrationCore } from "../core/index.js";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http.js";
import { createDispatcher } from "./dispatcher.js";
import { exportState } from "./state-export.js";

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
        } catch {
          // Process not running — stale lock
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
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const config = loadConfig();
  console.log("[daemon] Starting taskcore daemon");
  console.log(`[daemon]   port=${config.port}`);
  console.log(`[daemon]   db=${config.dbPath}`);
  console.log(`[daemon]   workspace=${config.workspaceDir}`);
  console.log(`[daemon]   maxConcurrent=${config.maxConcurrent}`);

  // Ensure data directory exists
  const dbDir = path.dirname(config.dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Acquire lock
  acquireLock(config.lockFile);

  // Initialize core
  const core = new OrchestrationCore({
    dbPath: config.dbPath,
    invariantChecks: true,
    snapshotEvery: 50,
  });
  console.log(`[daemon] Core initialized. Tasks: ${Object.keys(core.getState().tasks).length}`);

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
