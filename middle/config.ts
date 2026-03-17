import { DEFAULT_ATTEMPT_BUDGETS } from "../core/types.js";
import type { AttemptBudgetMaxInput } from "../core/types.js";

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export interface Config {
  /** HTTP listen port */
  port: number;
  /** SQLite database path (kept for migration / sqlite backend) */
  dbPath: string;
  /** JSONL event log directory */
  eventLogDir: string;
  /** Persistence backend: "jsonl" (default) or "sqlite" */
  persistenceBackend: "jsonl" | "sqlite";
  /** Agent registry JSON path */
  agentRegistry: string;
  /** Workspace root directory */
  workspaceDir: string;
  /** Legacy embedded-executor capacity (kept for runtime compat only) */
  maxConcurrent: number;
  /** Core tick interval (auto-events) */
  tickIntervalMs: number;
  /** Legacy embedded-executor interval (no longer used) */
  dispatchIntervalMs: number;
  /** Default agent lease timeout */
  leaseTimeoutMs: number;
  /** Lock file path */
  lockFile: string;
  /** Dashboard runtime JSON (executor_runtime.json compat) */
  runtimeFile: string;
  /** Legacy embedded-executor lifecycle JSONL (compat only) */
  lifecycleFile: string;
  /** Legacy embedded-executor command (no longer used) */
  agentCommand: string;
  /** Legacy embedded-executor notification target (no longer used) */
  telegramTarget: string;
  /** Default cost budget for new tasks */
  defaultCostBudget: number;
  /** Default context budget (passed to agent on lease) */
  defaultContextBudget: number;
  /** Default attempt budgets */
  defaultAttemptBudgets: AttemptBudgetMaxInput;
  /** Legacy embedded-executor timeout (no longer used) */
  agentTimeoutMs: number;
  /** Disallowed agent (rerouting) */
  disallowedAgent: string;
  /** Fallback agent for rerouting */
  disallowedAgentFallback: string;
  /** Journal git repo path (task branches + failure summaries) */
  journalRepoPath: string;
  /** Base directory for git worktrees (journal + code) */
  worktreeBaseDir: string;
}

export function loadConfig(): Config {
  const workspaceDir = envStr(
    "WORKSPACE_DIR",
    envStr("OPENCLAW_STATE_DIR", `${process.env["HOME"]}/.openclaw/workspace`),
  );

  const persistenceBackend = envStr("TASKCORE_BACKEND", "jsonl") as "jsonl" | "sqlite";

  return {
    port: envInt("ORCHESTRATOR_PORT", 18800),
    dbPath: envStr("ORCHESTRATOR_DB", `${workspaceDir}/data/taskcore.db`),
    eventLogDir: envStr("TASKCORE_EVENT_LOG_DIR", `${workspaceDir}/data/taskcore`),
    persistenceBackend,
    agentRegistry: envStr(
      "AGENT_REGISTRY",
      `${workspaceDir}/agents/registry.json`,
    ),
    workspaceDir,
    maxConcurrent: envInt("MAX_CONCURRENT", 1),
    tickIntervalMs: envInt("TICK_INTERVAL_MS", 2_000),
    dispatchIntervalMs: envInt("DISPATCH_INTERVAL_MS", 10_000),
    leaseTimeoutMs: envInt("LEASE_TIMEOUT_MS", 600_000),
    lockFile: envStr(
      "ORCHESTRATOR_LOCK",
      `${workspaceDir}/data/taskcore.lock`,
    ),
    runtimeFile: envStr(
      "RUNTIME_FILE",
      `${workspaceDir}/data/task-dashboard/executor_runtime.json`,
    ),
    lifecycleFile: envStr(
      "LIFECYCLE_FILE",
      `${workspaceDir}/data/task-dashboard/task_run_lifecycle.jsonl`,
    ),
    agentCommand: envStr("AGENT_COMMAND", "openclaw"),
    telegramTarget: envStr("TELEGRAM_TARGET", ""),
    defaultCostBudget: envInt("DEFAULT_COST_BUDGET", 100),
    defaultContextBudget: envInt("DEFAULT_CONTEXT_BUDGET", 200),
    defaultAttemptBudgets: DEFAULT_ATTEMPT_BUDGETS,
    agentTimeoutMs: envInt("AGENT_TIMEOUT_MS", 600_000),
    disallowedAgent: envStr("DISALLOWED_ROUTED_AGENT", "hermes"),
    disallowedAgentFallback: envStr("DISALLOWED_AGENT_FALLBACK", "overseer"),
    journalRepoPath: envStr(
      "JOURNAL_REPO_PATH",
      `${process.env["HOME"]}/.openclaw/journal`,
    ),
    worktreeBaseDir: envStr("WORKTREE_BASE_DIR", "/tmp/taskcore-worktrees"),
  };
}
