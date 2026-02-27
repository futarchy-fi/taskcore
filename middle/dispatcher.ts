import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Core } from "../core/index.js";
import type {
  AgentContext,
  AgentExited,
  AgentStarted,
  LeaseGranted,
  PhaseTransition,
  RetryScheduled,
  ReviewPolicyMet,
  ReviewVerdictSubmitted,
  StateRef,
  Task,
  TaskCompleted,
} from "../core/types.js";
import type { Config } from "./config.js";
import { autoAnalysis } from "./analysis.js";
import { buildPrompt } from "./prompt.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ActiveRun {
  taskId: string;
  runId: string;
  agentId: string;
  sessionId: string;
  phase: "analysis" | "execution" | "review";
  process: ChildProcess;
  startedAt: number;
  killTimer: ReturnType<typeof setTimeout> | null;
}

interface AgentRegistryEntry {
  id: string;
  role: string;
  assignable: boolean;
  reviewer: boolean;
  consulted: boolean;
}

export interface Dispatcher {
  runOnce(): void;
  stopAll(): void;
  getActiveRuns(): ActiveRun[];
}

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

const PRIORITY_ORDER: Record<string, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
  backlog: 4,
};

function taskPriority(task: Task): number {
  const p = task.metadata["priority"] as string | undefined;
  return PRIORITY_ORDER[p ?? "medium"] ?? 2;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

function loadRegistry(registryPath: string): AgentRegistryEntry[] {
  try {
    const data = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as {
      agents: AgentRegistryEntry[];
    };
    return data.agents ?? [];
  } catch {
    console.warn("[dispatcher] Could not load agent registry:", registryPath);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Auto-detect agent status from stdout
// ---------------------------------------------------------------------------

interface DetectedStatus {
  status: "done" | "pending";
  evidence: string;
}

/**
 * Parse agent stdout for review verdicts.
 *
 * Review agents output JSON (--json flag) with structure:
 *   { result: { payloads: [{ text: "..." }] } }
 *
 * The text contains a verdict line like:
 *   **Review verdict for T{id}:** **pending (changes requested)**.
 *   **Review verdict for T{id}:** **done (approved)**.
 *
 * We also check for the verdict embedded directly in the raw JSON string.
 */
function detectStatusFromOutput(
  stdout: string,
  _stderr: string,
  phase: "analysis" | "execution" | "review",
  _task: Task,
): DetectedStatus | null {
  // Only auto-detect for review phase — execution agents use task_update.py shim
  if (phase !== "review") return null;

  // Extract the text payload from agent JSON output
  let text = "";
  try {
    const data = JSON.parse(stdout);
    const payloads = data?.result?.payloads;
    if (Array.isArray(payloads) && payloads.length > 0) {
      text = payloads[0]?.text ?? "";
    }
  } catch {
    // If JSON parse fails, fall back to scanning raw stdout
    text = stdout;
  }

  if (!text) return null;

  const lower = text.toLowerCase();

  // Primary pattern: "review verdict for T{id}: **done" or "**pending"
  const verdictMatch = lower.match(/review\s+verdict\s+for\s+t\d+[:\s*]*\*{0,2}(done|approved|pending|changes[_ ]requested)/);
  if (verdictMatch) {
    const v = verdictMatch[1]!;
    if (v === "done" || v === "approved") {
      return { status: "done", evidence: extractEvidence(text, verdictMatch.index!) };
    }
    if (v === "pending" || v.startsWith("changes")) {
      return { status: "pending", evidence: extractEvidence(text, verdictMatch.index!) };
    }
  }

  // Fallback patterns for less structured output
  const approvePatterns = [
    /\bverdict[:\s]*\*{0,2}approv/,
    /\bmark(?:ing|ed)?\s+(?:as\s+)?(?:done|approved|complete)\b/,
    /\bstatus[:\s]*["']?done["']?\b/,
    /\ball\s+(?:criteria|requirements)\s+met\b/,
  ];

  const rejectPatterns = [
    /\bverdict[:\s]*\*{0,2}(?:pending|changes[_ ]requested)\b/,
    /\bmark(?:ing|ed)?\s+(?:as\s+)?(?:pending|changes[_ ]requested)\b/,
    /\bsend(?:ing)?\s+back\s+for\s+(?:changes|revision)\b/,
  ];

  for (const pat of approvePatterns) {
    if (pat.test(lower)) {
      const m = lower.match(pat);
      return { status: "done", evidence: extractEvidence(text, m?.index ?? 0) };
    }
  }

  for (const pat of rejectPatterns) {
    if (pat.test(lower)) {
      const m = lower.match(pat);
      return { status: "pending", evidence: extractEvidence(text, m?.index ?? 0) };
    }
  }

  return null;
}

function extractEvidence(text: string, matchIdx: number): string {
  const start = Math.max(0, matchIdx - 100);
  const end = Math.min(text.length, matchIdx + 300);
  const snippet = text.slice(start, end).trim();
  return snippet.slice(0, 500) || "Auto-detected from agent output";
}

/**
 * Apply an auto-detected review verdict directly via core events.
 * This avoids HTTP round-trips and async complexity.
 */
function applyAutoDetectedStatus(
  core: Core,
  task: Task,
  detected: DetectedStatus,
): void {
  const now = Date.now();
  const fenceToken = task.currentFenceToken;
  const ctx: AgentContext = {
    sessionId: "",
    agentId: "dispatcher-auto",
    memoryRef: null,
    contextTokens: null,
    modelId: "auto-detect",
  };

  if (task.phase !== "review" || task.condition !== "active") {
    console.warn(`[dispatcher] Auto-detect: T${task.id} not in review.active (${task.phase}.${task.condition}), skipping`);
    return;
  }

  const round = task.reviewState?.round ?? 1;

  if (detected.status === "done") {
    // Approve: ReviewVerdictSubmitted → ReviewPolicyMet → TaskCompleted
    const verdict: ReviewVerdictSubmitted = {
      type: "ReviewVerdictSubmitted",
      taskId: task.id,
      ts: now,
      fenceToken,
      reviewer: ctx.agentId,
      round,
      verdict: "approve",
      reasoning: detected.evidence,
      agentContext: ctx,
    };
    const r1 = core.submit(verdict);
    if (!r1.ok) {
      console.error(`[dispatcher] Auto-detect ReviewVerdict failed for T${task.id}: ${r1.error.message}`);
      return;
    }

    const policyMet: ReviewPolicyMet = {
      type: "ReviewPolicyMet",
      taskId: task.id,
      ts: now + 1,
      outcome: "approved",
      summary: detected.evidence,
      source: { type: "middle", id: "dispatcher-auto" },
    };
    const r2 = core.submit(policyMet);
    if (!r2.ok) {
      console.error(`[dispatcher] Auto-detect ReviewPolicyMet failed for T${task.id}: ${r2.error.message}`);
      return;
    }

    const stateRef: StateRef = { branch: "main", commit: "0000000", parentCommit: "0000000" };
    const completed: TaskCompleted = {
      type: "TaskCompleted",
      taskId: task.id,
      ts: now + 2,
      stateRef,
    };
    const r3 = core.submit(completed);
    if (!r3.ok) {
      console.error(`[dispatcher] Auto-detect TaskCompleted failed for T${task.id}: ${r3.error.message}`);
      return;
    }

    console.log(`[dispatcher] T${task.id} auto-completed via review verdict detection`);

  } else if (detected.status === "pending") {
    // Changes requested: ReviewVerdictSubmitted → ReviewPolicyMet → PhaseTransition
    const verdict: ReviewVerdictSubmitted = {
      type: "ReviewVerdictSubmitted",
      taskId: task.id,
      ts: now,
      fenceToken,
      reviewer: ctx.agentId,
      round,
      verdict: "changes_requested",
      reasoning: detected.evidence,
      agentContext: ctx,
    };
    const r1 = core.submit(verdict);
    if (!r1.ok) {
      console.error(`[dispatcher] Auto-detect ReviewVerdict failed for T${task.id}: ${r1.error.message}`);
      return;
    }

    const policyMet: ReviewPolicyMet = {
      type: "ReviewPolicyMet",
      taskId: task.id,
      ts: now + 1,
      outcome: "changes_requested",
      summary: detected.evidence,
      source: { type: "middle", id: "dispatcher-auto" },
    };
    const r2 = core.submit(policyMet);
    if (!r2.ok) {
      console.error(`[dispatcher] Auto-detect ReviewPolicyMet failed for T${task.id}: ${r2.error.message}`);
      return;
    }

    const transition: PhaseTransition = {
      type: "PhaseTransition",
      taskId: task.id,
      ts: now + 2,
      from: { phase: "review", condition: "active" },
      to: { phase: "execution", condition: "ready" },
      reasonCode: "changes_requested",
      reason: detected.evidence,
      fenceToken,
      agentContext: ctx,
    };
    const r3 = core.submit(transition);
    if (!r3.ok) {
      console.error(`[dispatcher] Auto-detect PhaseTransition failed for T${task.id}: ${r3.error.message}`);
      return;
    }

    console.log(`[dispatcher] T${task.id} sent back to execution via review verdict detection`);
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function createDispatcher(core: Core, config: Config): Dispatcher {
  const activeRuns = new Map<string, ActiveRun>();

  function runOnce(): void {
    const dispatchable = core.getDispatchable();
    if (dispatchable.length === 0) return;

    // Filter & sort
    const candidates = dispatchable
      .filter((t) => {
        const p = taskPriority(t);
        if (p >= 4) return false; // skip backlog
        return true;
      })
      .sort((a, b) => {
        const pa = taskPriority(a);
        const pb = taskPriority(b);
        if (pa !== pb) return pa - pb;
        return a.createdAt - b.createdAt;
      });

    if (candidates.length === 0) return;

    const slots = config.maxConcurrent - activeRuns.size;
    if (slots <= 0) return;

    for (let i = 0; i < Math.min(slots, candidates.length); i++) {
      const task = candidates[i]!;
      // Skip if already running
      if (activeRuns.has(task.id)) continue;

      try {
        dispatchTask(task);
      } catch (err) {
        console.error(`[dispatcher] Failed to dispatch ${task.id}:`, err);
      }
    }

    writeRuntimeFile();
  }

  function dispatchTask(task: Task): void {
    const phase = task.phase;
    if (!phase) return;

    // Handle analysis phase — auto-transition for assigned tasks
    if (phase === "analysis") {
      const autoTransitioned = autoAnalysis(core, task, config);
      if (autoTransitioned) {
        console.log(`[dispatcher] Auto-transitioned T${task.id} analysis → execution`);
        return; // Will be picked up next cycle as execution.ready
      }
    }

    // Determine agent
    const agentId = selectAgent(task, phase);
    if (!agentId) {
      console.warn(`[dispatcher] No agent for T${task.id} phase=${phase}`);
      return;
    }

    const now = Date.now();
    const sessionId = crypto.randomUUID();
    const fenceToken = task.currentFenceToken + 1;
    const runId = crypto.randomUUID();

    // 1. LeaseGranted
    const lease: LeaseGranted = {
      type: "LeaseGranted",
      taskId: task.id,
      ts: now,
      fenceToken,
      agentId,
      phase,
      leaseTimeout: config.leaseTimeoutMs,
      sessionId,
      sessionType: "fresh",
      contextBudget: task.contextBudget,
    };
    const leaseResult = core.submit(lease);
    if (!leaseResult.ok) {
      console.error(`[dispatcher] LeaseGranted failed for T${task.id}: ${leaseResult.error.message}`);
      return;
    }

    // 2. AgentStarted
    const agentContext: AgentContext = {
      sessionId,
      agentId,
      memoryRef: null,
      contextTokens: null,
      modelId: "claude-sonnet-4-6",
    };

    const started: AgentStarted = {
      type: "AgentStarted",
      taskId: task.id,
      ts: now + 1,
      fenceToken,
      agentContext,
    };
    const startResult = core.submit(started);
    if (!startResult.ok) {
      console.error(`[dispatcher] AgentStarted failed for T${task.id}: ${startResult.error.message}`);
      return;
    }

    // 3. Build prompt
    const runPhase = phase === "review" ? "review" : "work";
    const prompt = buildPrompt(core, task.id, runPhase, config);

    // 4. Spawn agent process
    const args = [
      "agent",
      "--agent", agentId,
      "--session-id", sessionId,
      "-m", prompt,
      "--json",
    ];

    console.log(`[dispatcher] Spawning ${agentId} for T${task.id} phase=${phase} run=${runId.slice(0, 8)}`);

    const child = spawn(config.agentCommand, args, {
      cwd: config.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TASK_ID: task.id,
        ORCHESTRATOR_PORT: String(config.port),
      },
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { stderr += d.toString(); });

    const run: ActiveRun = {
      taskId: task.id,
      runId,
      agentId,
      sessionId,
      phase: phase as ActiveRun["phase"],
      process: child,
      startedAt: now,
      killTimer: null,
    };

    // Set kill timer
    run.killTimer = setTimeout(() => {
      console.warn(`[dispatcher] T${task.id} agent timeout, sending SIGKILL`);
      child.kill("SIGKILL");
      appendLifecycle({
        event: "timeout_kill",
        runId,
        taskId: task.id,
        phase: runPhase,
        agentId,
        sessionId,
        outcome: "timeout_kill",
      });
    }, config.agentTimeoutMs);

    activeRuns.set(task.id, run);

    // Lifecycle event
    appendLifecycle({
      event: "dispatch_started",
      runId,
      taskId: task.id,
      phase: runPhase,
      agentId,
      sessionId,
      outcome: "started",
    });

    // Handle exit
    child.on("close", (exitCode, signal) => {
      handleChildExit(run, exitCode ?? -1, signal, stdout, stderr);
    });
  }

  function selectAgent(task: Task, phase: string): string | null {
    const assignee = task.metadata["assignee"] as string | undefined;
    const reviewer = task.metadata["reviewer"] as string | undefined;

    let agent: string | null = null;

    if (phase === "review") {
      agent = reviewer ?? null;
    } else if (phase === "analysis") {
      agent = assignee ?? "analyst";
    } else {
      agent = assignee ?? null;
    }

    // Apply routing override
    if (agent === config.disallowedAgent) {
      agent = config.disallowedAgentFallback;
    }

    return agent;
  }

  function handleChildExit(
    run: ActiveRun,
    exitCode: number,
    signal: string | null,
    stdout: string,
    stderr: string,
  ): void {
    const elapsed = Date.now() - run.startedAt;
    console.log(
      `[dispatcher] T${run.taskId} agent exited: code=${exitCode} signal=${signal} elapsed=${elapsed}ms`,
    );

    // Clear kill timer
    if (run.killTimer) {
      clearTimeout(run.killTimer);
    }

    // Auto-detect status from agent output (review agents may not call the status API)
    const task = core.getTask(run.taskId);
    if (task && !task.terminal && task.condition === "active" && exitCode === 0) {
      const autoStatus = detectStatusFromOutput(stdout, stderr, run.phase, task);
      if (autoStatus) {
        console.log(`[dispatcher] T${run.taskId} auto-detected status="${autoStatus.status}" from agent output`);
        applyAutoDetectedStatus(core, task, autoStatus);
      } else if (run.phase === "review") {
        console.log(`[dispatcher] T${run.taskId} review agent exited code=${exitCode} but no verdict detected (${stdout.length} bytes)`);
      }
    }

    // Submit AgentExited
    const taskAfter = core.getTask(run.taskId);
    if (taskAfter && !taskAfter.terminal && taskAfter.condition === "active") {
      const exited: AgentExited = {
        type: "AgentExited",
        taskId: run.taskId,
        ts: Date.now(),
        fenceToken: taskAfter.currentFenceToken,
        exitCode,
        reportedCost: 1,
        agentContext: {
          sessionId: run.sessionId,
          agentId: run.agentId,
          memoryRef: null,
          contextTokens: null,
          modelId: "claude-sonnet-4-6",
        },
      };
      const exitResult = core.submit(exited);
      if (!exitResult.ok) {
        console.error(`[dispatcher] AgentExited failed for T${run.taskId}: ${exitResult.error.message}`);
      }

      // If task still active after exit (agent didn't update status), schedule retry
      const updatedTask = core.getTask(run.taskId);
      if (updatedTask && !updatedTask.terminal && updatedTask.phase !== null) {
        // Determine backoff
        const phase = updatedTask.phase;
        const attemptUsed = updatedTask.attempts[phase].used;
        const isRateLimit = stderr.includes("rate_limit") || stderr.includes("429");
        const baseBackoff = 30_000; // 30s
        const cap = 480_000; // 8m
        const multiplier = isRateLimit ? 3 : 1;
        const backoff = Math.min(
          baseBackoff * Math.pow(2, attemptUsed - 1) * multiplier,
          cap,
        );

        const retry: RetryScheduled = {
          type: "RetryScheduled",
          taskId: run.taskId,
          ts: Date.now() + 1,
          fenceToken: updatedTask.currentFenceToken,
          reason: signal === "SIGKILL" ? "agent_timeout" : "agent_crashed",
          retryAfter: Date.now() + backoff,
          phase,
          attemptNumber: attemptUsed,
        };
        const retryResult = core.submit(retry);
        if (!retryResult.ok) {
          console.error(`[dispatcher] RetryScheduled failed for T${run.taskId}: ${retryResult.error.message}`);
        } else {
          console.log(`[dispatcher] T${run.taskId} retry scheduled in ${Math.round(backoff / 1000)}s`);
        }
      }
    }

    // Lifecycle event
    appendLifecycle({
      event: "exit",
      runId: run.runId,
      taskId: run.taskId,
      phase: run.phase === "review" ? "review" : "work",
      agentId: run.agentId,
      sessionId: run.sessionId,
      outcome: exitCode === 0 ? "success" : "nonzero_exit",
      exitCode,
      signal: signal ?? undefined,
      elapsedMs: Date.now() - run.startedAt,
    });

    // Remove from active runs
    activeRuns.delete(run.taskId);
    writeRuntimeFile();
  }

  function stopAll(): void {
    for (const [taskId, run] of activeRuns) {
      console.log(`[dispatcher] Stopping T${taskId} (${run.agentId})`);
      if (run.killTimer) clearTimeout(run.killTimer);
      run.process.kill("SIGTERM");
    }
  }

  // ---------------------------------------------------------------------------
  // Dashboard compatibility
  // ---------------------------------------------------------------------------

  function writeRuntimeFile(): void {
    if (!config.runtimeFile) return;
    try {
      const dir = path.dirname(config.runtimeFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      const runs = Array.from(activeRuns.values()).map((r) => ({
        taskId: r.taskId,
        runId: r.runId,
        agentId: r.agentId,
        phase: r.phase,
        startedAt: new Date(r.startedAt).toISOString(),
        elapsedMs: Date.now() - r.startedAt,
      }));

      const data = {
        pid: process.pid,
        startedAt: new Date().toISOString(),
        activeRuns: runs,
        maxConcurrent: config.maxConcurrent,
      };

      const tmp = config.runtimeFile + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
      fs.renameSync(tmp, config.runtimeFile);
    } catch (err) {
      console.error("[dispatcher] Failed to write runtime file:", err);
    }
  }

  function appendLifecycle(entry: Record<string, unknown>): void {
    if (!config.lifecycleFile) return;
    try {
      const dir = path.dirname(config.lifecycleFile);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      const line = JSON.stringify({ tsMs: Date.now(), ...entry }) + "\n";
      fs.appendFileSync(config.lifecycleFile, line);
    } catch {
      // Non-critical
    }
  }

  return {
    runOnce,
    stopAll,
    getActiveRuns: () => Array.from(activeRuns.values()),
  };
}
