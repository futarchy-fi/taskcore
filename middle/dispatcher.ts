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
import { loadRegistry as loadRegistryShared } from "./registry.js";
import {
  createTaskBranch,
  commitJournal,
  writeFailureSummary as writeJournalFailureSummary,
  mergeTaskBranch,
  getBranchRef,
  taskBranch,
} from "./journal.js";
import {
  createWorktree,
  removeWorktree,
  discardUncommitted,
  getWorktreePath,
} from "./worktree.js";

// ---------------------------------------------------------------------------
// Incident reporting — writes to data/incidents/YYYY-MM-DD.jsonl
// ---------------------------------------------------------------------------

type IncidentSeverity = "critical" | "error" | "warning" | "info";
type IncidentCategory =
  | "agent-crash"
  | "agent-timeout"
  | "agent-error"
  | "rate-limit"
  | "context-overflow"
  | "retry-exhausted"
  | "unexpected-behavior";

interface IncidentContext {
  taskId?: string | undefined;
  agentId?: string | undefined;
  sessionId?: string | undefined;
  modelId?: string | undefined;
  phase?: string | undefined;
  elapsedMs?: number | undefined;
  exitCode?: number | undefined;
  signal?: string | null | undefined;
  stdoutBytes?: number | undefined;
  stderrBytes?: number | undefined;
  stderrSnippet?: string | undefined;
  stdoutSnippet?: string | undefined;
  attempt?: number | undefined;
  [key: string]: unknown;
}

function appendIncident(
  config: Config,
  severity: IncidentSeverity,
  category: IncidentCategory,
  summary: string,
  detail?: string,
  context?: IncidentContext,
  tags?: string[],
): void {
  try {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10);
    const timeStr = now.toISOString().slice(11, 19).replace(/:/g, "");
    const rand = crypto.randomBytes(3).toString("hex").slice(0, 5);
    const incId = `inc_${dateStr.replace(/-/g, "")}_${timeStr}_${rand}`;

    const incDir = path.join(config.workspaceDir, "data", "incidents");
    if (!fs.existsSync(incDir)) {
      fs.mkdirSync(incDir, { recursive: true });
    }

    const record = {
      id: incId,
      ts: now.toISOString(),
      severity,
      category,
      source: "taskcore-dispatcher",
      detection: "auto",
      summary,
      detail: detail ?? null,
      context: context ?? null,
      chain_id: null,
      parent_id: null,
      tags: tags ?? [],
      resolved: false,
      resolved_at: null,
      resolved_by: null,
    };

    const line = JSON.stringify(record) + "\n";
    const filepath = path.join(incDir, `${dateStr}.jsonl`);
    fs.appendFileSync(filepath, line);
  } catch (err) {
    // Never block dispatcher on incident write failure
    console.error("[dispatcher] Failed to write incident:", err);
  }
}

/**
 * Classify an agent failure from stderr/stdout patterns.
 * Returns { category, severity, reason } or null for unclassifiable exits.
 */
function classifyAgentFailure(
  exitCode: number,
  signal: string | null,
  stderr: string,
  stdout: string,
): { category: IncidentCategory; severity: IncidentSeverity; reason: string } | null {
  const combined = (stderr + " " + stdout).toLowerCase();

  // Context overflow — the most important one to track
  if (
    combined.includes("context_length_exceeded") ||
    combined.includes("maximum context length") ||
    combined.includes("context window") ||
    combined.includes("token limit exceeded") ||
    combined.includes("prompt is too long")
  ) {
    return { category: "context-overflow", severity: "warning", reason: "context_length_exceeded" };
  }

  // Rate limiting
  if (
    combined.includes("rate_limit") ||
    combined.includes("429") ||
    combined.includes("too many requests") ||
    combined.includes("rate limit")
  ) {
    return { category: "rate-limit", severity: "warning", reason: "rate_limited" };
  }

  // Agent timeout (SIGKILL from our timer)
  if (signal === "SIGKILL") {
    return { category: "agent-timeout", severity: "warning", reason: "timeout_killed" };
  }

  // API errors (overloaded, server errors)
  if (
    combined.includes("overloaded") ||
    combined.includes("503") ||
    combined.includes("502") ||
    combined.includes("internal server error")
  ) {
    return { category: "agent-error", severity: "warning", reason: "api_error" };
  }

  // Non-zero exit (generic crash)
  if (exitCode !== 0) {
    return { category: "agent-crash", severity: "warning", reason: `exit_code_${exitCode}` };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Telegram notifications — batched digest
// ---------------------------------------------------------------------------

function sendTelegram(config: Config, msg: string): void {
  if (!config.telegramTarget) return;
  try {
    const child = spawn("openclaw", [
      "message", "send",
      "--channel", "telegram",
      "--target", config.telegramTarget,
      "--message", msg,
    ], { stdio: "ignore", detached: true });
    child.unref();
  } catch {
    // Never block dispatcher on notification failure
  }
}

// Urgent notifications go out immediately (failures, exhausted, blocked).
function notifyUrgent(config: Config, msg: string): void {
  sendTelegram(config, msg);
}

// Everything else accumulates in a digest buffer that flushes periodically.
interface DigestEntry {
  emoji: string;
  taskId: string;
  title: string;
  detail: string;
}

const digestBuffer: DigestEntry[] = [];
let digestTimer: ReturnType<typeof setTimeout> | null = null;
const DIGEST_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
let lastDigestConfig: Config | null = null;

function pushDigest(config: Config, entry: DigestEntry): void {
  lastDigestConfig = config;
  digestBuffer.push(entry);
  // Auto-flush if we haven't set a timer yet
  if (!digestTimer) {
    digestTimer = setTimeout(() => flushDigest(), DIGEST_INTERVAL_MS);
  }
}

function flushDigest(): void {
  digestTimer = null;
  if (digestBuffer.length === 0 || !lastDigestConfig) return;

  const entries = digestBuffer.splice(0);
  const done = entries.filter((e) => e.emoji === "✅");
  const changesReq = entries.filter((e) => e.emoji === "📝");
  const dispatched = entries.filter((e) => e.emoji === "🚀");
  const retries = entries.filter((e) => e.emoji === "🔄");
  const timeouts = entries.filter((e) => e.emoji === "⏰");

  const lines: string[] = [];
  lines.push(`📊 Pipeline digest (last ${Math.round(DIGEST_INTERVAL_MS / 60000)}min)`);

  if (done.length > 0) {
    lines.push(`\n✅ Completed: ${done.length}`);
    for (const d of done) lines.push(`  T${d.taskId} ${d.title}`);
  }
  if (changesReq.length > 0) {
    lines.push(`\n📝 Sent back: ${changesReq.length}`);
    for (const d of changesReq) lines.push(`  T${d.taskId} ${d.title}`);
  }
  if (dispatched.length > 0) {
    lines.push(`\n🚀 Dispatched: ${dispatched.length}`);
  }
  if (retries.length > 0) {
    lines.push(`🔄 Retries: ${retries.length}`);
  }
  if (timeouts.length > 0) {
    lines.push(`⏰ Timeouts: ${timeouts.length}`);
  }

  sendTelegram(lastDigestConfig, lines.join("\n"));
}

// Exported for daemon shutdown to flush any pending digest.
export function flushNotificationDigest(): void {
  flushDigest();
}

// ---------------------------------------------------------------------------
// Informed-target notifications (per-task, not digest)
// ---------------------------------------------------------------------------

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

function notifyInformed(task: Task, event: string, detail?: string): void {
  const informed = task.metadata["informed"];
  if (!informed || !Array.isArray(informed) || informed.length === 0) return;
  if (!TELEGRAM_BOT_TOKEN) {
    console.warn("[dispatcher] notifyInformed: TELEGRAM_BOT_TOKEN not set, skipping notification");
    return;
  }

  const msg = detail
    ? `${event} T${task.id}: ${task.title.slice(0, 60)}\n${detail}`
    : `${event} T${task.id}: ${task.title.slice(0, 60)}`;

  for (const target of informed) {
    const t = String(target).trim();
    if (!t || !t.startsWith("telegram:")) continue;
    const parts = t.slice("telegram:".length).split(":");
    const chatId = parts[parts.length - 1];
    if (!chatId) continue;
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: msg }),
    }).then(r => {
      if (!r.ok) console.warn(`[dispatcher] notifyInformed Telegram ${r.status} for chat=${chatId}`);
      else console.log(`[dispatcher] notifyInformed sent to chat=${chatId}`);
    }).catch(err => {
      console.warn(`[dispatcher] notifyInformed error: ${err.message}`);
    });
  }
}

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
  nudged?: boolean;
  /** Journal worktree path (if created) */
  journalWorktree?: string | undefined;
  /** Code worktree path (if created) */
  codeWorktree?: string | undefined;
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

  // Strip fenced code blocks to avoid matching on curl templates / JSON payloads
  // that the agent is quoting in its reasoning (not actual verdicts).
  const stripped = lower.replace(/```[\s\S]*?```/g, " [code-block] ");

  // Fallback patterns for less structured output (applied to stripped text only)
  const approvePatterns = [
    /\bverdict[:\s]*\*{0,2}approv/,
    /\bmark(?:ing|ed)?\s+(?:as\s+)?(?:done|approved|complete)\b/,
    /\ball\s+(?:criteria|requirements)\s+met\b/,
    /\bacceptable\b.*\bapprov/,
  ];

  const rejectPatterns = [
    /\bverdict[:\s]*\*{0,2}(?:pending|changes[_ ]requested|not acceptable)\b/,
    /\bmark(?:ing|ed)?\s+(?:as\s+)?(?:pending|changes[_ ]requested)\b/,
    /\bsend(?:ing)?\s+back\s+for\s+(?:changes|revision)\b/,
    /\bshould\s+be\s+\*{0,2}(?:requested\s+changes|pending|rejected)\b/,
    /\bnot\s+acceptable\b/,
    /\brequest(?:ed)?\s+changes\b/,
  ];

  for (const pat of approvePatterns) {
    if (pat.test(stripped)) {
      const m = lower.match(pat);
      return { status: "done", evidence: extractEvidence(text, m?.index ?? 0) };
    }
  }

  for (const pat of rejectPatterns) {
    if (pat.test(stripped)) {
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
  config: Config,
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

    const stateRef: StateRef = getBranchRef(config.journalRepoPath, taskBranch(task.id))
      ?? { branch: "main", commit: "0000000", parentCommit: "0000000" };
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

    // Merge journal branch on completion
    try {
      const parentId = (task.metadata["parentId"] as string) ?? null;
      mergeTaskBranch(config.journalRepoPath, task.id, parentId);
    } catch (err) {
      console.warn(`[dispatcher] T${task.id} journal merge failed (non-fatal):`, err);
    }

    pushDigest(config, { emoji: "✅", taskId: task.id, title: task.title.slice(0, 60), detail: "" });
    notifyInformed(task, "✅ Done");

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
    pushDigest(config, { emoji: "📝", taskId: task.id, title: task.title.slice(0, 60), detail: "" });
    notifyInformed(task, "📝 Changes requested");
  }
}

// ---------------------------------------------------------------------------
// Dispatcher
// ---------------------------------------------------------------------------

export function createDispatcher(core: Core, config: Config): Dispatcher {
  const activeRuns = new Map<string, ActiveRun>();
  const registry = loadRegistryShared(config.agentRegistry);

  function isHumanAssigned(task: Task, phase: string): boolean {
    const assignee = task.metadata["assignee"] as string | undefined;
    const reviewer = task.metadata["reviewer"] as string | undefined;
    const target = phase === "review" ? reviewer : assignee;
    return target != null && registry.memberIds.has(target);
  }

  function runOnce(): void {
    const dispatchable = core.getDispatchable();
    if (dispatchable.length === 0) return;

    // Filter & sort
    const candidates = dispatchable
      .filter((t) => {
        const p = taskPriority(t);
        if (p >= 4) return false; // skip backlog
        if (t.phase && isHumanAssigned(t, t.phase)) return false; // skip human-assigned
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
      contextBudget: task.contextBudget || config.defaultContextBudget,
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

    // 4. Set up worktrees (journal + optional code)
    let journalWorktreePath: string | undefined;
    let codeWorktreePath: string | undefined;

    try {
      // Journal worktree
      const jBranch = taskBranch(task.id);
      const jPath = getWorktreePath(config.worktreeBaseDir, task.id, "journal");
      const parentId = (task.metadata["parentId"] as string) ?? null;
      createTaskBranch(config.journalRepoPath, task.id, parentId);
      createWorktree(config.journalRepoPath, jPath, jBranch);
      journalWorktreePath = jPath;

      // Code worktree (only if task specifies a target repo)
      const targetRepo = task.metadata["repo"] as string | undefined;
      if (targetRepo) {
        const cPath = getWorktreePath(config.worktreeBaseDir, task.id, "code");
        const baseBranch = (task.metadata["base_branch"] as string) ?? "main";
        const codeBranch = `task/T${task.id}`;
        try {
          createWorktree(targetRepo, cPath, codeBranch, baseBranch);
          codeWorktreePath = cPath;
        } catch (err) {
          console.warn(`[dispatcher] T${task.id} code worktree failed:`, err);
        }
      }
    } catch (err) {
      console.warn(`[dispatcher] T${task.id} worktree setup failed (non-fatal):`, err);
    }

    // 5. Spawn agent process
    // Prepend "/new " to force a fresh session for each dispatch.
    // Without this, openclaw routes all dispatches to the same agent:coder-lite:main
    // session (--session-id is ignored when --agent is specified), causing tasks to
    // share context and the agent to just produce text summaries instead of working.
    const args = [
      "agent",
      "--agent", agentId,
      "--session-id", sessionId,
      "-m", `/new ${prompt}`,
      "--json",
    ];

    console.log(`[dispatcher] Spawning ${agentId} for T${task.id} phase=${phase} run=${runId.slice(0, 8)}`);

    const spawnEnv: Record<string, string | undefined> = {
      ...process.env,
      TASK_ID: task.id,
      ORCHESTRATOR_PORT: String(config.port),
    };
    if (journalWorktreePath) {
      spawnEnv["JOURNAL_PATH"] = `${journalWorktreePath}/tasks/T${task.id}/`;
    }
    if (codeWorktreePath) {
      spawnEnv["CODE_WORKTREE"] = codeWorktreePath;
    }

    const child = spawn(config.agentCommand, args, {
      cwd: config.workspaceDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: spawnEnv,
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
      journalWorktree: journalWorktreePath,
      codeWorktree: codeWorktreePath,
    };

    // Set kill timer
    run.killTimer = setTimeout(() => {
      console.warn(`[dispatcher] T${task.id} agent timeout, sending SIGKILL`);
      child.kill("SIGKILL");
      pushDigest(config, { emoji: "⏰", taskId: task.id, title: task.title.slice(0, 40), detail: `Agent: ${agentId}` });
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

    pushDigest(config, { emoji: "🚀", taskId: task.id, title: task.title.slice(0, 60), detail: `${agentId} ${phase}` });
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

    // Classify and report failure as incident
    const failure = (exitCode !== 0 || signal)
      ? classifyAgentFailure(exitCode, signal, stderr, stdout)
      : null;

    if (failure) {
      const incCtx: IncidentContext = {
        taskId: run.taskId,
        agentId: run.agentId,
        sessionId: run.sessionId,
        modelId: "claude-sonnet-4-6",
        phase: run.phase,
        elapsedMs: elapsed,
        exitCode,
        signal,
        stdoutBytes: stdout.length,
        stderrBytes: stderr.length,
        stderrSnippet: stderr.trim().slice(-1000) || undefined,
        stdoutSnippet: exitCode !== 0 ? stdout.trim().slice(-500) || undefined : undefined,
      };

      const task = core.getTask(run.taskId);
      if (task) {
        const phase = task.phase;
        if (phase) {
          (incCtx as Record<string, unknown>)["attempt"] = task.attempts[phase].used;
          (incCtx as Record<string, unknown>)["attemptMax"] = task.attempts[phase].max;
        }
      }

      appendIncident(
        config,
        failure.severity,
        failure.category,
        `T${run.taskId} ${run.agentId} ${failure.reason} (exit=${exitCode}, ${Math.round(elapsed / 1000)}s)`,
        failure.category === "context-overflow"
          ? `Context overflow in T${run.taskId} (${run.agentId}, phase=${run.phase}). ` +
            `This indicates the prompt + conversation exceeded the model's context window. ` +
            `stderr: ${stderr.trim().slice(-500)}`
          : undefined,
        incCtx,
        [run.agentId, run.phase, failure.reason],
      );
    }

    // Auto-detect status from agent output (review agents may not call the status API)
    const task = core.getTask(run.taskId);
    if (task && !task.terminal && task.condition === "active" && exitCode === 0) {
      const autoStatus = detectStatusFromOutput(stdout, stderr, run.phase, task);
      if (autoStatus) {
        console.log(`[dispatcher] T${run.taskId} auto-detected status="${autoStatus.status}" from agent output`);
        applyAutoDetectedStatus(config, core, task, autoStatus);
      } else if (run.phase === "review") {
        console.log(`[dispatcher] T${run.taskId} review agent exited code=${exitCode} but no verdict detected (${stdout.length} bytes)`);
      } else {
        // Execution/analysis agent exited without reporting status — log for diagnosis
        const stderrSnippet = stderr.trim().slice(-500);
        const stdoutSnippet = stdout.trim().slice(-500);
        console.warn(`[dispatcher] T${run.taskId} ${run.phase} agent exited code=${exitCode} without reporting status (stdout=${stdout.length}b, stderr=${stderr.length}b)`);
        if (stderrSnippet) console.warn(`[dispatcher] T${run.taskId} stderr tail: ${stderrSnippet}`);
        if (stdoutSnippet) console.warn(`[dispatcher] T${run.taskId} stdout tail: ${stdoutSnippet}`);
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

      // If task still active after exit (agent didn't update status)
      const updatedTask = core.getTask(run.taskId);
      if (updatedTask && !updatedTask.terminal && updatedTask.phase !== null) {
        // Try a status nudge first (one chance per run, only for clean exits)
        if (exitCode === 0 && !run.nudged) {
          console.log(`[dispatcher] T${run.taskId} agent forgot to report status — sending nudge to same session`);
          spawnStatusNudge(run, updatedTask);
          return; // Don't schedule retry yet — wait for nudge result
        }

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
          pushDigest(config, { emoji: "🔄", taskId: run.taskId, title: "", detail: `attempt ${attemptUsed}` });
        }

        // Check if task became exhausted or failed after retry scheduling
        const taskAfterRetry = core.getTask(run.taskId);
        if (taskAfterRetry?.terminal === "failed") {
          notifyUrgent(config, `❌ T${run.taskId} FAILED\n${taskAfterRetry.title.slice(0, 60)}`);
          notifyInformed(taskAfterRetry, "❌ Failed");
          appendIncident(
            config,
            "error",
            "retry-exhausted",
            `T${run.taskId} ${run.agentId} failed (retries exhausted)`,
            `Task "${taskAfterRetry.title}" exhausted all retry attempts. Last failure: ${failure?.reason ?? "unknown"}.`,
            { taskId: run.taskId, agentId: run.agentId, phase: run.phase },
            [run.agentId, "terminal-failure"],
          );
        } else if (taskAfterRetry?.condition === "exhausted") {
          notifyUrgent(config, `⏸ T${run.taskId} EXHAUSTED\n${taskAfterRetry.title.slice(0, 60)}`);
          notifyInformed(taskAfterRetry, "⏸ Exhausted");
          appendIncident(
            config,
            "warning",
            "retry-exhausted",
            `T${run.taskId} ${run.agentId} exhausted (budget depleted)`,
            `Task "${taskAfterRetry.title}" ran out of budget. Needs manual budget increase via POST /tasks/${run.taskId}/budget.`,
            { taskId: run.taskId, agentId: run.agentId, phase: run.phase },
            [run.agentId, "exhausted"],
          );
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

    // Journal & worktree cleanup
    cleanupWorktrees(run, exitCode, signal);

    // Remove from active runs
    activeRuns.delete(run.taskId);
    writeRuntimeFile();
  }

  /**
   * Handle journal commits and worktree cleanup after agent exit.
   *
   * Success: commit journal, populate StateRef, remove worktrees (branches preserved).
   * Failure: discard uncommitted, write failure summary, remove worktrees.
   */
  function cleanupWorktrees(run: ActiveRun, exitCode: number, signal: string | null): void {
    const taskAfterExit = core.getTask(run.taskId);

    try {
      if (run.journalWorktree) {
        if (exitCode === 0 && !signal) {
          // Success — commit any remaining journal entries
          commitJournal(run.journalWorktree, run.taskId, "agent session complete");
        } else {
          // Failure — discard uncommitted, write failure summary
          discardUncommitted(run.journalWorktree);
          const reason = signal === "SIGKILL" ? "timeout" : `exit_code_${exitCode}`;
          writeJournalFailureSummary(run.journalWorktree, run.taskId, {
            whatFailed: `Agent ${run.agentId} failed: ${reason}`,
            whatWasLearned: taskAfterExit?.failureSummaries.at(-1)?.whatWasLearned ?? "No learnings captured",
          });
        }

        // Populate StateRef from journal branch
        const ref = getBranchRef(config.journalRepoPath, taskBranch(run.taskId));
        if (ref && taskAfterExit) {
          // StateRef is captured but not submitted as an event here —
          // it flows through AgentExited / TaskCompleted events upstream
          console.log(`[dispatcher] T${run.taskId} journal ref: ${ref.commit.slice(0, 8)}`);
        }

        // Remove journal worktree (branch stays for reviewer / archive)
        removeWorktree(config.journalRepoPath, run.journalWorktree);
      }

      if (run.codeWorktree) {
        if (exitCode !== 0 || signal) {
          discardUncommitted(run.codeWorktree);
        }
        const targetRepo = taskAfterExit?.metadata["repo"] as string | undefined;
        if (targetRepo) {
          removeWorktree(targetRepo, run.codeWorktree);
        }
      }
    } catch (err) {
      console.warn(`[dispatcher] T${run.taskId} worktree cleanup error (non-fatal):`, err);
    }
  }

  /**
   * Send a follow-up message to the same session asking the agent to report status.
   * No `/new` prefix — continues the existing conversation so the agent has context.
   * This doesn't burn a retry attempt; if the nudge also fails, the normal retry flow kicks in.
   */
  function spawnStatusNudge(originalRun: ActiveRun, task: Task): void {
    const statusType = task.phase === "review" ? "done" : "review";
    const nudgeMessage = [
      `Run this exact command now. Do not do anything else — just run this command:`,
      ``,
      `curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/status \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '{"status": "${statusType}", "evidence": "Brief summary of what you did"}'`,
      ``,
      `Replace the evidence text with a short summary of what you actually did, then run it.`,
    ].join("\n");

    const args = [
      "agent",
      "--agent", originalRun.agentId,
      "--session-id", originalRun.sessionId,
      "-m", nudgeMessage,
      "--json",
    ];

    console.log(`[dispatcher] T${task.id} sending status nudge to session ${originalRun.sessionId.slice(0, 8)}`);

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

    // Reuse the run slot with nudged=true
    const nudgeRun: ActiveRun = {
      ...originalRun,
      process: child,
      startedAt: Date.now(),
      nudged: true,
      killTimer: null,
    };

    // 60s timeout for nudge (should be fast)
    nudgeRun.killTimer = setTimeout(() => {
      console.warn(`[dispatcher] T${task.id} nudge timeout, killing`);
      child.kill("SIGKILL");
    }, 60_000);

    activeRuns.set(task.id, nudgeRun);
    writeRuntimeFile();

    child.on("close", (code, sig) => {
      handleChildExit(nudgeRun, code ?? -1, sig, stdout, stderr);
    });
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
