import * as http from "node:http";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import type { Core } from "../core/index.js";
import type {
  AgentContext,
  AttemptBudgetMaxInput,
  BudgetIncreased,
  CompletionVerificationRecorded,
  DecompositionChildSpec,
  DecompositionCreated,
  Dependency,
  Event,
  FailureSummary,
  LeaseGranted,
  LeaseReleased,
  MetadataUpdated,
  ReviewPolicyMet,
  ReviewVerdictSubmitted,
  PhaseTransition,
  StateRef,
  Task,
  TaskBlocked,
  TaskCanceled,
  TaskCompleted,
  TaskCreated,
  TaskFailed,
  TaskId,
  TaskReparented,
  TaskRevived,
  ValidationError,
} from "../core/types.js";
import { DEFAULT_ATTEMPT_BUDGETS } from "../core/types.js";
import type { Config } from "./config.js";
import { buildPrompt } from "./prompt.js";
import { commitJournal, createTaskBranch, getFailureSummaries, getJournalContent, mergeTaskBranch, taskBranch } from "./journal.js";
import { agentRole, loadRegistry, validateMetadataRoles, type Registry } from "./registry.js";
import { createWorktree, getWorktreePath } from "./worktree.js";
import { verifyArtifacts } from "./finalize.js";
import { createOrFindPr } from "./github.js";

// ---------------------------------------------------------------------------
// Auto-incident emitter
// ---------------------------------------------------------------------------

function appendIncident(
  config: Config,
  severity: "critical" | "error" | "warning" | "info",
  category: string,
  summary: string,
  detail?: string,
  tags?: string[],
): void {
  try {
    const now = new Date();
    const day = now.toISOString().slice(0, 10);
    const dir = path.join(config.workspaceDir, "data", "incidents");
    fs.mkdirSync(dir, { recursive: true });
    const ts = now.toISOString();
    const idSuffix = crypto.randomUUID().slice(0, 5);
    const id = `inc_${day.replace(/-/g, "")}_${ts.slice(11, 19).replace(/:/g, "")}_${idSuffix}`;
    const record = {
      id,
      ts,
      severity,
      category,
      source: "taskcore",
      detection: "auto",
      summary,
      detail: detail ?? null,
      context: null,
      chain_id: null,
      parent_id: null,
      tags: tags ?? [],
      resolved: false,
      resolved_at: null,
      resolved_by: null,
    };
    fs.appendFileSync(path.join(dir, `${day}.jsonl`), JSON.stringify(record) + "\n");
  } catch {
    // Non-fatal — don't break task operations for incident logging
  }
}

// Module-level config ref, set once in createHttpServer()
let _config: Config | null = null;

// ---------------------------------------------------------------------------
// Priority helpers
// ---------------------------------------------------------------------------

const PRIORITY_RANK: Record<string, number> = {
  critical: 0, high: 1, medium: 2, low: 3, backlog: 4,
};

/** Return the higher of two priorities (lower rank number = higher priority). */
function maxPriority(a: string, b: string): string {
  const ra = PRIORITY_RANK[a] ?? 2;
  const rb = PRIORITY_RANK[b] ?? 2;
  return ra <= rb ? a : b;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RouteMatch {
  handler: (
    req: http.IncomingMessage,
    params: Record<string, string>,
    body: unknown,
  ) => Promise<RouteResult>;
  params: Record<string, string>;
}

interface RouteResult {
  status: number;
  body: unknown;
}

interface StatusUpdateBody {
  status: "review" | "done" | "blocked" | "pending" | "execute" | "decompose" | "cancel" | "reject";
  evidence?: string;
  blocker?: string;
  stateRef?: StateRef;
  children?: Array<{
    title: string;
    description: string;
    costAllocation?: number;
    assignee?: string;
    reviewer?: string;
  }>;
}

interface ClaimBody {
  agentId?: string;
  agent?: string;
  leaseTimeout?: number;
  contextBudget?: number;
  modelId?: string;
  source?: string;
  force?: boolean;
}

interface TaskCreateBody {
  title: string;
  description: string;
  assignee?: string;
  reviewer?: string;
  consulted?: string;
  priority?: string;
  parentId?: string;
  informed?: string | string[];
  skipAnalysis?: boolean;
  costBudget?: number;
  dependsOn?: string | string[];
  repo?: string;
  baseBranch?: string;
  base_branch?: string;
}

interface DecomposeBody {
  children: Array<{
    title: string;
    description: string;
    costAllocation: number;
    skipAnalysis?: boolean;
    assignee?: string;
    reviewer?: string;
    dependsOnSiblings?: number[];
  }>;
  approach?: string;
  coordinationMode?: "sequential" | "parallel";
}

// ---------------------------------------------------------------------------
// Incremental decomposition (multi-step CLI)
// ---------------------------------------------------------------------------

interface PendingChild {
  title: string;
  description: string;
  costAllocation: number;
  skipAnalysis: boolean;
  assignee: string | undefined;
  reviewer: string | undefined;
  priority: string | undefined;
  dependsOnSiblings: number[];
}

interface PendingDecomposition {
  taskId: string;
  startedAt: number;
  approach: string;
  children: PendingChild[];
  checkpointIndices: number[];
}

const pendingDecompositions = new Map<string, PendingDecomposition>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf-8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function nextTaskId(core: Core): string {
  const state = core.getState();
  const ids = Object.keys(state.tasks).map((id) => parseInt(id, 10)).filter((n) => !Number.isNaN(n));
  const max = ids.length > 0 ? Math.max(...ids) : 0;
  return String(max + 1);
}

function agentContextFor(task: Task): AgentContext {
  return {
    sessionId: task.currentSessionId ?? "daemon",
    agentId: task.leasedTo ?? "daemon",
    memoryRef: null,
    contextTokens: null,
    modelId: "daemon",
  };
}

function daemonAgentContext(): AgentContext {
  return {
    sessionId: "daemon",
    agentId: "daemon",
    memoryRef: null,
    contextTokens: null,
    modelId: "daemon",
  };
}

// ---------------------------------------------------------------------------
// Status broadcast — sends to Status Updates (Bots) group on transitions
// ---------------------------------------------------------------------------

const STATUS_GROUP_CHAT_ID = process.env["STATUS_GROUP_CHAT_ID"] || "";

const EVENT_EMOJI: Record<string, string> = {
  TaskCreated: "📝",
  LeaseGranted: "🤖",
  LeaseReleased: "🔓",
  PhaseTransition: "➡️",
  DecompositionCreated: "🔀",
  ReviewVerdictSubmitted: "📋",
  ReviewPolicyMet: "✅",
  TaskCompleted: "✅",
  TaskFailed: "❌",
  TaskExhausted: "💤",
  TaskBlocked: "🚫",
  TaskCanceled: "🗑️",
  TaskRevived: "🔄",
  BudgetIncreased: "💰",
};

// Events that are too noisy or internal to broadcast
const SILENT_EVENTS = new Set([
  "LeaseExpired", "LeaseExtended", "AgentStarted", "AgentExited",
  "CostReported", "WaitRequested", "WaitResolved", "DependencySatisfied",
  "RetryScheduled", "BackoffExpired", "ChildCostRecovered",
  "CheckpointTriggered", "CheckpointCreated", "StateReverted",
  "MetadataUpdated", "TaskReparented",
]);

function broadcastTransition(core: Core, event: Event): void {
  if (!STATUS_GROUP_CHAT_ID || !TELEGRAM_BOT_TOKEN) return;
  if (SILENT_EVENTS.has(event.type)) return;

  const task = core.getTask(event.taskId);
  const title = task ? task.title.slice(0, 60) : `T${event.taskId}`;
  const tid = `T${event.taskId}`;

  let msg = "";
  switch (event.type) {
    case "TaskCreated":
      msg = `📝 ${tid} created (${escapeHtml(title)})`;
      break;
    case "LeaseGranted": {
      const lg = event as LeaseGranted;
      const phase = task?.phase ?? lg.phase;
      const verb = phase === "review" ? "will review" : phase === "analysis" ? "will analyze" : "claimed";
      msg = `🤖 <b>${escapeHtml(lg.agentId)}</b> ${verb} ${tid} (${escapeHtml(title)})`;
      break;
    }
    case "LeaseReleased": {
      const lr = event as LeaseReleased;
      msg = `🔓 ${tid} released: ${escapeHtml(lr.reason)} (${escapeHtml(title)})`;
      break;
    }
    case "PhaseTransition": {
      const pt = event as PhaseTransition;
      msg = `➡️ ${tid} → ${pt.to.phase}.${pt.to.condition} (${escapeHtml(title)})`;
      break;
    }
    case "DecompositionCreated": {
      const dc = event as DecompositionCreated;
      msg = `🔀 ${tid} decomposed into ${dc.children.length} children (${escapeHtml(title)})`;
      break;
    }
    case "ReviewVerdictSubmitted": {
      const rv = event as ReviewVerdictSubmitted;
      msg = `📋 ${tid} review: ${rv.verdict} by ${escapeHtml(rv.reviewer)} (${escapeHtml(title)})`;
      break;
    }
    case "ReviewPolicyMet":
      msg = `✅ ${tid} review passed (${escapeHtml(title)})`;
      break;
    case "TaskCompleted":
      msg = `✅ ${tid} completed (${escapeHtml(title)})`;
      break;
    case "TaskFailed": {
      const tf = event as TaskFailed;
      msg = `❌ ${tid} failed: ${escapeHtml(tf.reason.slice(0, 80))} (${escapeHtml(title)})`;
      break;
    }
    case "TaskExhausted":
      msg = `💤 ${tid} exhausted budget (${escapeHtml(title)})`;
      break;
    case "TaskBlocked": {
      const tb = event as TaskBlocked;
      msg = `🚫 ${tid} blocked: ${escapeHtml(tb.reason.slice(0, 80))} (${escapeHtml(title)})`;
      break;
    }
    case "TaskCanceled":
      msg = `🗑️ ${tid} canceled (${escapeHtml(title)})`;
      break;
    case "TaskRevived":
      msg = `🔄 ${tid} revived (${escapeHtml(title)})`;
      break;
    case "BudgetIncreased":
      msg = `💰 ${tid} budget increased (${escapeHtml(title)})`;
      break;
    default:
      msg = `📌 ${tid} ${event.type} (${escapeHtml(title)})`;
      break;
  }

  fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: STATUS_GROUP_CHAT_ID, text: msg, parse_mode: "HTML" }),
  }).catch(() => {});
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function submitOrError(core: Core, event: Event): RouteResult | null {
  const result = core.submit(event);
  if (!result.ok) {
    return {
      status: 422,
      body: { error: result.error.code, message: result.error.message },
    };
  }
  broadcastTransition(core, event);
  emitAutoIncident(core, event);
  return null;
}

/** Emit incidents for terminal/blocked events automatically. */
function emitAutoIncident(core: Core, event: Event): void {
  if (!_config) return;
  const task = core.getTask(event.taskId);
  const title = task ? task.title.slice(0, 80) : `T${event.taskId}`;
  const tid = `T${event.taskId}`;

  switch (event.type) {
    case "TaskFailed": {
      const tf = event as TaskFailed;
      appendIncident(_config, "error", "task-failure",
        `${tid} failed: ${tf.reason}`,
        `Task: ${title}. ${tf.summary?.whatFailed ?? ""}`.trim(),
        ["task-failed", `task-${event.taskId}`],
      );
      break;
    }
    case "TaskBlocked": {
      const tb = event as TaskBlocked;
      appendIncident(_config, "warning", "task-blocked",
        `${tid} blocked: ${tb.reason.slice(0, 100)}`,
        `Task: ${title}. ${tb.reason}`,
        ["task-blocked", `task-${event.taskId}`],
      );
      break;
    }
    case "TaskExhausted": {
      appendIncident(_config, "warning", "task-exhausted",
        `${tid} exhausted budget`,
        `Task: ${title}. All attempt budgets consumed.`,
        ["task-exhausted", `task-${event.taskId}`],
      );
      break;
    }
    default:
      break;
  }
}

function defaultStateRef(): StateRef {
  return { branch: "main", commit: "0000000", parentCommit: "0000000" };
}

function truncateText(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}\n... (truncated, ${input.length - maxChars} chars omitted)`;
}

function loadWorkspaceConventions(config: Config): string | null {
  const agentsPath = path.join(config.workspaceDir, "AGENTS.md");
  try {
    return fs.readFileSync(agentsPath, "utf-8");
  } catch {
    return null;
  }
}

function ensureTaskWorkspaces(config: Config, task: Task): {
  journalWorktree: string | null;
  journalPath: string | null;
  codeWorktree: string | null;
  warnings: string[];
} {
  const warnings: string[] = [];
  let journalWorktree: string | null = null;
  let journalPath: string | null = null;
  let codeWorktree: string | null = null;

  try {
    const jBranch = taskBranch(task.id);
    const jPath = getWorktreePath(config.worktreeBaseDir, task.id, "journal");
    createTaskBranch(config.journalRepoPath, task.id, task.parentId);
    if (!fs.existsSync(jPath)) {
      createWorktree(config.journalRepoPath, jPath, jBranch);
    }
    journalWorktree = jPath;
    journalPath = `${path.join(jPath, "tasks", `T${task.id}`)}${path.sep}`;
  } catch (err) {
    warnings.push(`journal worktree setup failed: ${String(err)}`);
  }

  const targetRepo = (task.metadata["repo"] as string | undefined) || config.defaultCodeRepo || undefined;
  if (targetRepo) {
    try {
      const cPath = getWorktreePath(config.worktreeBaseDir, task.id, "code");
      const codeBranch = `task/T${task.id}`;
      // Child tasks inherit parent's code branch; root tasks fork from base_branch/main
      const parentCodeBranch = task.parentId ? `task/T${task.parentId}` : null;
      const baseBranch = parentCodeBranch
        ?? (task.metadata["base_branch"] as string | undefined)
        ?? "main";
      if (!fs.existsSync(cPath)) {
        createWorktree(targetRepo, cPath, codeBranch, baseBranch);
      }
      codeWorktree = cPath;
    } catch (err) {
      warnings.push(`code worktree setup failed: ${String(err)}`);
    }
  }

  return { journalWorktree, journalPath, codeWorktree, warnings };
}

function ensureJournalWorktreeForTask(config: Config, task: Task): {
  journalWorktree: string;
  taskDir: string;
} {
  const workspaces = ensureTaskWorkspaces(config, task);
  if (!workspaces.journalWorktree) {
    throw new Error(`No journal worktree available for T${task.id}`);
  }
  const taskDir = path.join(workspaces.journalWorktree, "tasks", `T${task.id}`);
  fs.mkdirSync(taskDir, { recursive: true });
  return { journalWorktree: workspaces.journalWorktree, taskDir };
}

function appendJournalEntry(config: Config, task: Task, entry: string): {
  journalPath: string;
  committed: boolean;
} {
  const { journalWorktree, taskDir } = ensureJournalWorktreeForTask(config, task);
  const journalFile = path.join(taskDir, "journal.md");

  if (!fs.existsSync(journalFile)) {
    fs.writeFileSync(journalFile, `# T${task.id} Journal\n`, "utf-8");
  }

  const trimmed = entry.trim();
  const stamp = new Date().toISOString();
  const block = `\n\n## ${stamp}\n${trimmed}\n`;
  fs.appendFileSync(journalFile, block, "utf-8");
  commitJournal(journalWorktree, task.id, "journal update");

  return { journalPath: `${taskDir}${path.sep}`, committed: true };
}

function writeJournalArtifact(config: Config, task: Task, name: string, content: string): {
  journalPath: string;
  filePath: string;
} {
  const { journalWorktree, taskDir } = ensureJournalWorktreeForTask(config, task);
  const safeName = path.basename(name);
  if (!safeName || safeName === "." || safeName === "..") {
    throw new Error("Invalid file name");
  }
  const filePath = path.join(taskDir, safeName);
  fs.writeFileSync(filePath, content, "utf-8");
  commitJournal(journalWorktree, task.id, `journal artifact ${safeName}`);
  return { journalPath: `${taskDir}${path.sep}`, filePath };
}

// ---------------------------------------------------------------------------
// Route table builder
// ---------------------------------------------------------------------------

type Method = "GET" | "POST" | "PATCH";

interface RouteDef {
  method: Method;
  pattern: string; // e.g. "/tasks/:id/status"
  handler: (
    req: http.IncomingMessage,
    params: Record<string, string>,
    body: unknown,
  ) => Promise<RouteResult>;
}

function matchRoute(
  method: string,
  url: string,
  routes: RouteDef[],
): RouteMatch | null {
  for (const route of routes) {
    if (route.method !== method) continue;
    const params = matchPattern(route.pattern, url);
    if (params !== null) {
      return { handler: route.handler, params };
    }
  }
  return null;
}

function matchPattern(
  pattern: string,
  url: string,
): Record<string, string> | null {
  const patternParts = pattern.split("/");
  const urlParts = url.split("?")[0]!.split("/");

  if (patternParts.length !== urlParts.length) return null;

  const params: Record<string, string> = {};
  for (let i = 0; i < patternParts.length; i++) {
    const pp = patternParts[i]!;
    const up = urlParts[i]!;
    if (pp.startsWith(":")) {
      params[pp.slice(1)] = decodeURIComponent(up);
    } else if (pp !== up) {
      return null;
    }
  }
  return params;
}

function parseQuery(url: string): Record<string, string> {
  const qs = url.split("?")[1];
  if (!qs) return {};
  const params: Record<string, string> = {};
  for (const pair of qs.split("&")) {
    const [k, v] = pair.split("=");
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? "");
  }
  return params;
}

// ---------------------------------------------------------------------------
// HTTP Server
// ---------------------------------------------------------------------------

export function createHttpServer(
  core: Core,
  config: Config,
): http.Server {
  _config = config;
  const registry = loadRegistry(config.agentRegistry);
  const routes = buildRoutes(core, config, registry);

  const server = http.createServer(async (req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";

    // CORS (for local dev)
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");

    if (method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const match = matchRoute(method, url, routes);
    if (!match) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "not_found", message: `No route for ${method} ${url}` }));
      return;
    }

    try {
      const body = (method === "POST" || method === "PATCH") ? await parseBody(req) : {};
      const result = await match.handler(req, match.params, body);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(result.body));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "bad_request", message }));
    }
  });

  return server;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

function buildRoutes(core: Core, config: Config, registry: Registry): RouteDef[] {
  return [
    { method: "GET", pattern: "/health", handler: handleHealth(core) },
    { method: "GET", pattern: "/tasks", handler: handleListTasks(core) },
    { method: "GET", pattern: "/tasks/:id", handler: handleGetTask(core) },
    { method: "GET", pattern: "/tasks/:id/events", handler: handleGetTaskEvents(core) },
    { method: "GET", pattern: "/tasks/:id/journal", handler: handleGetTaskJournal(core, config) },
    { method: "POST", pattern: "/tasks/:id/journal", handler: handleAppendTaskJournal(core, config) },
    { method: "POST", pattern: "/tasks/:id/journal/file", handler: handleWriteTaskJournalFile(core, config) },
    { method: "GET", pattern: "/tasks/:id/review/context", handler: handleReviewContext(core, config) },
    { method: "POST", pattern: "/tasks/:id/review/note", handler: handleReviewNote(core) },
    { method: "GET", pattern: "/dispatchable", handler: handleDispatchable(core) },
    { method: "POST", pattern: "/tasks", handler: handleCreateTask(core, config, registry) },
    { method: "POST", pattern: "/tasks/:id/events", handler: handleSubmitEvent(core) },
    { method: "POST", pattern: "/tasks/:id/claim", handler: handleClaimTask(core, config) },
    { method: "POST", pattern: "/tasks/:id/release", handler: handleReleaseTask(core) },
    { method: "POST", pattern: "/tasks/:id/status", handler: handleStatusUpdate(core, config) },
    { method: "POST", pattern: "/tasks/:id/reparent", handler: handleReparent(core) },
    { method: "POST", pattern: "/tasks/:id/revive", handler: handleRevive(core) },
    { method: "POST", pattern: "/tasks/:id/budget", handler: handleBudgetIncrease(core) },
    { method: "POST", pattern: "/tasks/:id/decompose/start", handler: handleDecomposeStart(core) },
    { method: "POST", pattern: "/tasks/:id/decompose/add-child", handler: handleDecomposeAddChild(core) },
    { method: "POST", pattern: "/tasks/:id/decompose/checkpoint", handler: handleDecomposeCheckpoint() },
    { method: "POST", pattern: "/tasks/:id/decompose/commit", handler: handleDecomposeCommit(core, config) },
    { method: "POST", pattern: "/tasks/:id/decompose/cancel", handler: handleDecomposeCancel(core) },
    { method: "POST", pattern: "/tasks/:id/decompose", handler: handleDecompose(core, config) },
    { method: "PATCH", pattern: "/tasks/:id/metadata", handler: handleMetadataUpdate(core, registry) },
    { method: "GET", pattern: "/attention", handler: handleAttention(core) },
    { method: "GET", pattern: "/attention/telegram", handler: handleAttentionTelegram(core) },
  ];
}

function nowIso(): string {
  return new Date().toISOString();
}

// POST /tasks/:id/claim — atomically lease+start+mark claim metadata
function handleClaimTask(
  core: Core,
  config: Config,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const b = body as ClaimBody;

    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }
    if (task.terminal) {
      return { status: 409, body: { error: "terminal", message: `Task ${taskId} is already ${task.terminal}` } };
    }
    if (task.condition !== "ready") {
      return {
        status: 409,
        body: {
          error: "not_claimable",
          message: `Task ${taskId} must be ready to claim, got ${task.phase}.${task.condition}`,
        },
      };
    }
    if (!task.phase) {
      return { status: 409, body: { error: "terminal_task", message: `Task ${taskId} is terminal` } };
    }

    const requestedAgentId = typeof b.agentId === "string"
      ? b.agentId
      : typeof b.agent === "string"
      ? b.agent
      : null;
    if (requestedAgentId !== null && requestedAgentId.trim().length === 0) {
      return { status: 400, body: { error: "invalid_agent_id", message: "agentId must be non-empty." } };
    }
    const agentId = requestedAgentId?.trim() || "unknown";

    const fenceToken = task.currentFenceToken + 1;
    const sessionId = crypto.randomUUID();
    const leaseTimeout = Number.isFinite(b.leaseTimeout ?? NaN)
      ? Number(b.leaseTimeout)
      : config.leaseTimeoutMs;
    const contextBudget = Number.isFinite(b.contextBudget ?? NaN)
      ? Number(b.contextBudget)
      : config.defaultContextBudget;
    const modelId = typeof b.modelId === "string" && b.modelId.trim().length > 0
      ? b.modelId.trim()
      : "self-directed";
    const claimSource = typeof b.source === "string" && b.source.trim().length > 0 ? b.source.trim() : "http-api";

    if (!Number.isInteger(leaseTimeout) || leaseTimeout <= 0) {
      return { status: 400, body: { error: "invalid_lease_timeout", message: "leaseTimeout must be a positive integer." } };
    }
    if (!Number.isInteger(contextBudget) || contextBudget <= 0) {
      return { status: 400, body: { error: "invalid_context_budget", message: "contextBudget must be a positive integer." } };
    }

    // Role enforcement: reject mismatched agents unless --force
    const force = b.force === true;
    if (!force) {
      const claimRole = agentRole(agentId);
      if (task.phase === "review") {
        const reviewer = task.metadata["reviewer"] as string | undefined;
        if (reviewer && agentRole(reviewer) !== claimRole) {
          return { status: 403, body: { error: "role_mismatch", message: `Task ${taskId} is assigned to a different agent for review. Use --force to override.` } };
        }
      } else {
        const assignee = task.metadata["assignee"] as string | undefined;
        if (assignee && agentRole(assignee) !== claimRole) {
          return { status: 403, body: { error: "role_mismatch", message: `Task ${taskId} is assigned to a different agent. Use --force to override.` } };
        }
      }
    }

    const now = Date.now();
    const agentContext: AgentContext = {
      sessionId,
      agentId,
      memoryRef: null,
      contextTokens: null,
      modelId,
    };
    const lg: LeaseGranted = {
      type: "LeaseGranted",
      taskId,
      ts: now,
      fenceToken,
      agentId,
      phase: task.phase,
      leaseTimeout,
      sessionId,
      sessionType: "fresh",
      contextBudget,
      agentContext,
    };
    let err = submitOrError(core, lg);
    if (err) return err;

    // Auto-set reviewer metadata when claiming in review phase
    const reviewerPatch = task.phase === "review" && !task.metadata["reviewer"]
      ? { reviewer: agentId }
      : {};

    const metadataUpdated: MetadataUpdated = {
      type: "MetadataUpdated",
      taskId,
      ts: now + 1,
      patch: {
        claimedAt: nowIso(),
        claimedBy: agentId,
        claimSessionId: sessionId,
        claimSessionKey: null,
        claimSource,
        ...reviewerPatch,
      },
      reason: "agent claimed task",
      source: { type: "agent", id: agentId },
    };
    err = submitOrError(core, metadataUpdated);
    if (err) return err;

    const updated = core.getTask(taskId);
    if (!updated) {
      return { status: 500, body: { error: "missing_task", message: `Task ${taskId} disappeared after claim` } };
    }

    // The daemon owns worktree creation so the CLI can stay a pure HTTP client.
    const workspace = ensureTaskWorkspaces(config, updated);
    const parentJournal = updated.parentId
      ? getJournalContent(config.journalRepoPath, updated.parentId)
      : null;
    const siblingFailures = getFailureSummaries(config.journalRepoPath, updated.id).map((entry) => ({
      taskId: entry.taskId,
      content: truncateText(entry.content, 500),
    }));
    const workspaceConventions = loadWorkspaceConventions(config);

    return {
      status: 200,
      body: {
        claimed: true,
        taskId,
        sessionId,
        fenceToken,
        leaseTimeout,
        task: {
          id: updated.id,
          title: updated.title,
          description: updated.description,
          phase: updated.phase,
          priority: updated.metadata["priority"] ?? "medium",
          assignee: updated.metadata["assignee"] ?? null,
          reviewer: updated.metadata["reviewer"] ?? null,
          consulted: updated.metadata["consulted"] ?? null,
          parentId: updated.parentId,
          failureSummaries: updated.failureSummaries,
          reviewState: updated.reviewState,
        },
        workspace,
        parentJournal: parentJournal ? truncateText(parentJournal, 3000) : null,
        siblingFailures,
        workspaceConventions,
        reviewContext: updated.phase === "review" ? buildPrompt(core, updated.id, "review", config) : null,
        warnings: workspace.warnings,
        guidance: "Start a fresh context (/new) unless this task is tightly coupled to your previous context.",
      },
    };
  };
}

// POST /tasks/:id/release — gracefully release a lease
function handleReleaseTask(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const b = body as { fenceToken?: number; reason?: string; workPerformed?: boolean };

    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }
    if (task.terminal) {
      return { status: 409, body: { error: "terminal", message: `Task ${taskId} is already ${task.terminal}` } };
    }
    if (task.condition !== "active") {
      return {
        status: 409,
        body: { error: "not_active", message: `Task ${taskId} must be active to release, got ${task.phase}.${task.condition}` },
      };
    }
    if (!task.phase) {
      return { status: 409, body: { error: "no_phase", message: `Task ${taskId} has no phase` } };
    }

    const fenceToken = typeof b.fenceToken === "number" ? b.fenceToken : task.currentFenceToken;
    const reason = typeof b.reason === "string" && b.reason.trim().length > 0
      ? b.reason.trim()
      : "Agent released task";
    const workPerformed = b.workPerformed === true;

    const event: LeaseReleased = {
      type: "LeaseReleased",
      taskId,
      ts: Date.now(),
      fenceToken,
      reason,
      phase: task.phase,
      workPerformed,
      source: { type: "agent", id: task.leasedTo ?? "unknown" },
    };

    const err = submitOrError(core, event);
    if (err) return err;

    const updated = core.getTask(taskId);
    return {
      status: 200,
      body: {
        released: true,
        taskId,
        phase: updated?.phase,
        condition: updated?.condition,
        workPerformed,
        message: workPerformed
          ? `Task ${taskId} released (attempt consumed — work was performed)`
          : `Task ${taskId} released (no attempt consumed)`,
      },
    };
  };
}

// GET /health
function handleHealth(
  core: Core,
): RouteDef["handler"] {
  return async () => {
    const state = core.getState();
    const taskCount = Object.keys(state.tasks).length;
    const dispatchable = core.getDispatchable().length;
    return {
      status: 200,
      body: {
        status: "ok",
        taskCount,
        dispatchable,
        sequence: state.sequence,
        uptime: process.uptime(),
      },
    };
  };
}

// GET /tasks?phase=X&condition=Y&terminal=Z
function handleListTasks(
  core: Core,
): RouteDef["handler"] {
  return async (req) => {
    const query = parseQuery(req.url ?? "");
    const state = core.getState();
    let tasks = Object.values(state.tasks);

    if (query["phase"]) {
      tasks = tasks.filter((t) => t.phase === query["phase"]);
    }
    if (query["condition"]) {
      tasks = tasks.filter((t) => t.condition === query["condition"]);
    }
    if (query["terminal"]) {
      tasks = tasks.filter((t) => t.terminal === query["terminal"]);
    }
    if (query["parentId"]) {
      tasks = tasks.filter((t) => t.parentId === query["parentId"]);
    }

    // full=true returns complete task objects; default returns summaries
    if (query["full"] === "true") {
      return { status: 200, body: { tasks } };
    }

    const summaries = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      phase: t.phase,
      condition: t.condition,
      terminal: t.terminal,
      parentId: t.parentId,
      assignee: t.metadata["assignee"] ?? null,
      reviewer: t.metadata["reviewer"] ?? null,
      priority: t.metadata["priority"] ?? "medium",
      activeAgent: t.leasedTo,
      leaseExpiresAt: t.leaseExpiresAt,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
      updatedAtMs: t.updatedAt,
    }));

    return { status: 200, body: { tasks: summaries } };
  };
}

// GET /tasks/:id
function handleGetTask(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params) => {
    const task = core.getTask(params["id"]!);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${params["id"]} not found` } };
    }
    return { status: 200, body: { task } };
  };
}

// GET /tasks/:id/events
function handleGetTaskEvents(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params) => {
    const taskId = params["id"]!;
    const events = core.getEvents(taskId);

    if (events.length === 0) {
      const task = core.getTask(taskId);
      if (!task) {
        return { status: 404, body: { error: "not_found", message: "Task " + taskId + " not found" } };
      }
    }

    return { status: 200, body: { events } };
  };
}

// GET /tasks/:id/journal
function handleGetTaskJournal(
  core: Core,
  config: Config,
): RouteDef["handler"] {
  return async (_req, params) => {
    const taskId = params["id"]!;
    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    const fromBranch = getJournalContent(config.journalRepoPath, taskId);
    if (fromBranch !== null) {
      return { status: 200, body: { taskId, content: fromBranch, hasJournal: true } };
    }

    const journalWorktree = getWorktreePath(config.worktreeBaseDir, taskId, "journal");
    const journalFile = path.join(journalWorktree, "tasks", `T${taskId}`, "journal.md");
    if (fs.existsSync(journalFile)) {
      return { status: 200, body: { taskId, content: fs.readFileSync(journalFile, "utf-8"), hasJournal: true } };
    }

    return { status: 200, body: { taskId, content: "", hasJournal: false } };
  };
}

// POST /tasks/:id/journal
function handleAppendTaskJournal(
  core: Core,
  config: Config,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    const payload = body as { entry?: string };
    const entry = typeof payload.entry === "string" ? payload.entry.trim() : "";
    if (!entry) {
      return { status: 400, body: { error: "missing_entry", message: "entry is required" } };
    }

    try {
      const result = appendJournalEntry(config, task, entry);
      return {
        status: 200,
        body: {
          ok: true,
          taskId,
          journalPath: result.journalPath,
          committed: result.committed,
        },
      };
    } catch (err) {
      return { status: 500, body: { error: "journal_write_failed", message: String(err) } };
    }
  };
}

// POST /tasks/:id/journal/file
function handleWriteTaskJournalFile(
  core: Core,
  config: Config,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    const payload = body as { name?: string; content?: string };
    const name = typeof payload.name === "string" ? payload.name.trim() : "";
    if (!name) {
      return { status: 400, body: { error: "missing_name", message: "name is required" } };
    }
    if (typeof payload.content !== "string") {
      return { status: 400, body: { error: "missing_content", message: "content is required" } };
    }

    try {
      const result = writeJournalArtifact(config, task, name, payload.content);
      return {
        status: 200,
        body: {
          ok: true,
          taskId,
          journalPath: result.journalPath,
          filePath: result.filePath,
        },
      };
    } catch (err) {
      return { status: 500, body: { error: "journal_file_write_failed", message: String(err) } };
    }
  };
}

// GET /tasks/:id/review/context
function handleReviewContext(
  core: Core,
  config: Config,
): RouteDef["handler"] {
  return async (_req, params) => {
    const taskId = params["id"]!;
    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    // Assignee evidence from PhaseTransition to review
    const events = core.getEvents(taskId);
    let assigneeEvidence: string | null = null;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i] as unknown as Record<string, unknown>;
      if (ev["type"] === "PhaseTransition") {
        const to = ev["to"] as { phase: string } | undefined;
        if (to?.phase === "review" && typeof ev["reason"] === "string") {
          assigneeEvidence = ev["reason"] as string;
          break;
        }
      }
    }
    if (!assigneeEvidence) {
      assigneeEvidence = (task.metadata["evidence"] as string | undefined) ?? null;
    }

    // Journal content
    const journalContent = getJournalContent(config.journalRepoPath, taskId);

    // Code diff
    const targetRepo = task.metadata["repo"] as string | undefined;
    let codeDiff: string | null = null;
    const repoDir = targetRepo || config.workspaceDir;
    try {
      const branch = `task/T${taskId}`;
      const diff = execSync(
        `git diff main...${branch} -- . 2>/dev/null || git log --oneline --all --grep="^T${taskId}" --format="%H" 2>/dev/null | head -1`,
        { cwd: repoDir, encoding: "utf-8", timeout: 10_000 },
      ).trim();
      if (diff) codeDiff = diff;
    } catch { /* no diff available */ }

    // Previous review rounds
    const reviewState = task.reviewState ?? null;
    const previousVerdicts = reviewState?.verdicts ?? [];

    // Failure summaries from siblings
    const failureSummaries = getFailureSummaries(config.journalRepoPath, taskId);

    return {
      status: 200,
      body: {
        taskId,
        title: task.title,
        description: task.description,
        priority: task.metadata["priority"],
        assignee: task.metadata["assignee"],
        reviewer: task.metadata["reviewer"],
        phase: task.phase,
        condition: task.condition,
        assigneeEvidence,
        journalContent,
        codeDiff: codeDiff ? (codeDiff.length > 10000 ? codeDiff.slice(0, 10000) + "\n... (truncated)" : codeDiff) : null,
        reviewState: {
          round: reviewState?.round ?? 0,
          status: reviewState?.status ?? "none",
          verdicts: previousVerdicts,
        },
        reviewConfig: task.reviewConfig,
        siblingFailures: failureSummaries.slice(0, 20),
      },
    };
  };
}

// POST /tasks/:id/review/note
function handleReviewNote(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    const payload = body as { note?: string };
    const note = typeof payload.note === "string" ? payload.note.trim() : "";
    if (!note) {
      return { status: 400, body: { error: "missing_note", message: "note is required" } };
    }

    const existing = Array.isArray(task.metadata["review_notes"])
      ? task.metadata["review_notes"].map((entry) => String(entry))
      : [];
    const notes = [...existing, note];

    const event: MetadataUpdated = {
      type: "MetadataUpdated",
      taskId,
      ts: Date.now(),
      patch: { review_notes: notes },
      reason: "review note added via API",
      source: { type: "middle", id: "daemon" },
    };

    const err = submitOrError(core, event);
    if (err) return err;

    return { status: 200, body: { ok: true, taskId, notes } };
  };
}

// GET /dispatchable
function handleDispatchable(
  core: Core,
): RouteDef["handler"] {
  return async () => {
    const tasks = core.getDispatchable();
    const summaries = tasks.map((t) => ({
      id: t.id,
      title: t.title,
      phase: t.phase,
      condition: t.condition,
      assignee: t.metadata["assignee"] ?? null,
      priority: t.metadata["priority"] ?? "medium",
      createdAt: t.createdAt,
    }));
    return { status: 200, body: { tasks: summaries } };
  };
}

// POST /tasks
function handleCreateTask(
  core: Core,
  config: Config,
  registry: Registry,
): RouteDef["handler"] {
  return async (_req, _params, body) => {
    const b = body as TaskCreateBody;
    if (!b.title || !b.description) {
      return { status: 400, body: { error: "missing_fields", message: "title and description required" } };
    }

    // Validate role fields against registry
    const roleErr = validateMetadataRoles(registry, {
      assignee: b.assignee ?? null,
      reviewer: b.reviewer ?? null,
      consulted: b.consulted ?? null,
    });
    if (roleErr) {
      return { status: 422, body: { error: "invalid_role", message: roleErr } };
    }

    const taskId = nextTaskId(core);
    let parentId: TaskId | null = b.parentId ?? null;
    let rootId = taskId;

    if (parentId) {
      const parent = core.getTask(parentId);
      if (parent) {
        rootId = parent.rootId;
      }
    }

    // Apply routing overrides
    let assignee = b.assignee ?? null;
    let reviewer = b.reviewer ?? null;
    if (assignee === config.disallowedAgent) {
      assignee = config.disallowedAgentFallback;
    }
    if (reviewer === config.disallowedAgent) {
      reviewer = config.disallowedAgentFallback;
    }

    // Build dependencies from dependsOn
    const depIds = b.dependsOn
      ? (Array.isArray(b.dependsOn) ? b.dependsOn : [b.dependsOn])
      : [];

    const dependencies: Dependency[] = [];
    for (const depId of depIds) {
      const depTask = core.getTask(String(depId));
      if (!depTask) {
        return { status: 422, body: { error: "invalid_dependency", message: `Dependency target task ${depId} not found` } };
      }
      dependencies.push({
        id: `dep-${taskId}-on-${depId}`,
        type: "task",
        target: String(depId),
        blocking: true,
        timing: "before_start",
        status: depTask.terminal === "done" ? "fulfilled" : "pending",
      });
    }

    const hasPendingDeps = dependencies.some((d) => d.status === "pending");

    const event: TaskCreated = {
      type: "TaskCreated",
      taskId,
      ts: Date.now(),
      title: b.title,
      description: b.description,
      parentId,
      rootId,
      initialPhase: "analysis",
      initialCondition: hasPendingDeps ? "waiting" : "ready",
      attemptBudgets: config.defaultAttemptBudgets,
      costBudget: b.costBudget ?? config.defaultCostBudget,
      dependencies,
      reviewConfig: reviewer
        ? { required: true, attemptBudget: 3, isolationRules: [] }
        : null,
      skipAnalysis: b.skipAnalysis ?? false,
      metadata: {
        assignee,
        reviewer,
        consulted: b.consulted ?? null,
        priority: b.priority ?? "medium",
        informed: b.informed ?? null,
        repo: b.repo ?? null,
        base_branch: b.baseBranch ?? b.base_branch ?? null,
        createdBy: "http-api",
        createdAt: new Date().toISOString(),
        // Phase 3 guardrail: auto-set planRequired for high/critical tasks
        // unless explicitly opted out with planRequired: false
        ...((b.priority === "critical" || b.priority === "high") &&
          (b as unknown as Record<string, unknown>).planRequired !== false
          ? { planRequired: true }
          : {}),
      },
      source: { type: "middle", id: "daemon" },
    };

    const err = submitOrError(core, event);
    if (err) return err;

    return {
      status: 201,
      body: {
        taskId,
        status: "created",
        phase: b.skipAnalysis ? "execution" : "analysis",
        assignee,
        priority: b.priority ?? "medium",
        parentId,
        dependsOn: depIds.length > 0 ? depIds : undefined,
        condition: hasPendingDeps ? "waiting" : "ready",
        message: `Task ${taskId} created: ${b.title}`,
      },
    };
  };
}

// POST /tasks/:id/events — raw event submission (fenced)
function handleSubmitEvent(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const event = body as Event;
    if (!event.type) {
      return { status: 400, body: { error: "missing_type", message: "Event type required" } };
    }
    // Override taskId from URL
    (event as { taskId: string }).taskId = params["id"]!;

    const err = submitOrError(core, event);
    if (err) return err;

    return { status: 200, body: { ok: true, taskId: params["id"] } };
  };
}

// POST /tasks/:id/status — agent-friendly status update
function handleStatusUpdate(
  core: Core,
  config: Config,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const b = body as StatusUpdateBody;
    const task = core.getTask(taskId);

    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }
    if (task.terminal) {
      return { status: 409, body: { error: "terminal", message: `Task ${taskId} is already ${task.terminal}` } };
    }

    const now = Date.now();
    const fenceToken = task.currentFenceToken;
    const ctx = agentContextFor(task);

    switch (b.status) {
      case "review":
        return applyReviewTransition(core, task, fenceToken, ctx, now, b.evidence);

      case "done":
        return applyDoneTransition(core, config, task, fenceToken, ctx, now, b.evidence, b.stateRef);

      case "reject":
        return applyRejectTransition(core, task, fenceToken, ctx, now, b.evidence);

      case "blocked":
        return applyBlockedTransition(core, task, now, b.blocker ?? b.evidence ?? "No reason provided", ctx);

      case "pending":
        return applyChangesRequestedTransition(core, task, fenceToken, ctx, now, b.evidence);

      case "execute":
        return applyExecuteTransition(core, task, fenceToken, ctx, now);

      case "decompose":
        return applyDecomposeTransition(core, task, fenceToken, ctx, now);

      case "cancel":
        return applyCancelTransition(core, task, now, b.evidence, ctx);

      default:
        return { status: 400, body: { error: "unknown_status", message: `Unknown status: ${b.status}` } };
    }
  };
}

// POST /tasks/:id/reparent
function handleReparent(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const b = body as { newParentId?: string };

    if (!b.newParentId) {
      return { status: 400, body: { error: "missing_fields", message: "newParentId required" } };
    }

    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    const newParent = core.getTask(b.newParentId);
    if (!newParent) {
      return { status: 404, body: { error: "not_found", message: `New parent task ${b.newParentId} not found` } };
    }

    const event: TaskReparented = {
      type: "TaskReparented",
      taskId,
      ts: Date.now(),
      oldParentId: task.parentId,
      newParentId: b.newParentId,
      oldRootId: task.rootId,
      newRootId: newParent.rootId,
      source: { type: "middle", id: "daemon" },
    };

    const err = submitOrError(core, event);
    if (err) return err;

    return {
      status: 200,
      body: { ok: true, taskId, newParentId: b.newParentId, newRootId: newParent.rootId },
    };
  };
}

// POST /tasks/:id/revive — revive a failed/blocked task
function handleRevive(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const b = body as { phase?: string; resetAttempts?: string[]; reason?: string };

    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    if (!task.terminal || (task.terminal !== "failed" && task.terminal !== "blocked")) {
      return { status: 409, body: { error: "not_terminal", message: `Task ${taskId} is not failed or blocked (terminal=${task.terminal})` } };
    }

    // Default: revive to the phase where it failed, reset that phase's attempts
    const phase = (b.phase ?? task.failureSummaries[0]?.approach?.match(/(\w+) phase/)?.[1] ?? "execution") as "analysis" | "execution" | "review";
    const resetAttempts = (b.resetAttempts ?? [phase]) as ("analysis" | "execution" | "review")[];
    const reason = b.reason ?? "manual revive";

    const event: TaskRevived = {
      type: "TaskRevived",
      taskId,
      ts: Date.now(),
      phase,
      resetAttempts,
      reason,
      source: { type: "middle", id: "daemon" },
    };

    const err = submitOrError(core, event);
    if (err) return err;

    return {
      status: 200,
      body: { ok: true, taskId, phase, resetAttempts, reason },
    };
  };
}

// POST /tasks/:id/budget — increase budget for an exhausted or active task
function handleBudgetIncrease(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const b = body as {
      attemptBudgetIncrease?: Partial<AttemptBudgetMaxInput>;
      costBudgetIncrease?: number;
      reason?: string;
    };

    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    if (task.terminal) {
      return { status: 409, body: { error: "terminal", message: `Task ${taskId} is already ${task.terminal}` } };
    }

    const reason = b.reason ?? "budget increase via API";
    if (!reason.trim()) {
      return { status: 400, body: { error: "missing_reason", message: "reason is required" } };
    }

    const event: BudgetIncreased = {
      type: "BudgetIncreased",
      taskId,
      ts: Date.now(),
      attemptBudgetIncrease: b.attemptBudgetIncrease ?? null,
      costBudgetIncrease: b.costBudgetIncrease ?? 0,
      reason,
      source: { type: "middle", id: "daemon" },
    };

    const err = submitOrError(core, event);
    if (err) return err;

    const updated = core.getTask(taskId);
    return {
      status: 200,
      body: {
        ok: true,
        taskId,
        condition: updated?.condition ?? null,
        message: `Budget increased for T${taskId}`,
      },
    };
  };
}

// PATCH /tasks/:id/metadata — update task metadata (priority, assignee, etc.)
function handleMetadataUpdate(
  core: Core,
  registry: Registry,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const b = body as Record<string, unknown>;

    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    // Validate role fields against registry
    const roleErr = validateMetadataRoles(registry, b);
    if (roleErr) {
      return { status: 422, body: { error: "invalid_role", message: roleErr } };
    }

    // Extract reason (defaults to "metadata update via API"), everything else is the patch
    const reason = typeof b["reason"] === "string" && b["reason"].trim()
      ? b["reason"] as string
      : "metadata update via API";

    const patch: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(b)) {
      if (key === "reason") continue;
      patch[key] = value;
    }

    if (Object.keys(patch).length === 0) {
      return { status: 400, body: { error: "empty_patch", message: "No metadata fields to update (provide fields other than reason)" } };
    }

    const event: MetadataUpdated = {
      type: "MetadataUpdated",
      taskId,
      ts: Date.now(),
      patch,
      reason,
      source: { type: "middle", id: "daemon" },
    };

    const err = submitOrError(core, event);
    if (err) return err;

    const updated = core.getTask(taskId);
    return {
      status: 200,
      body: {
        ok: true,
        taskId,
        metadata: updated?.metadata ?? null,
        message: `Metadata updated for T${taskId}`,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Status transition implementations
// ---------------------------------------------------------------------------

/** review: execution.active → review.ready */
function applyReviewTransition(
  core: Core,
  task: Task,
  fenceToken: number,
  ctx: AgentContext,
  ts: number,
  evidence?: string,
): RouteResult {
  if (task.phase !== "execution" || task.condition !== "active") {
    return {
      status: 409,
      body: {
        error: "invalid_state",
        message: `Task must be in execution.active, got ${task.phase}.${task.condition}`,
      },
    };
  }

  // Update metadata with evidence
  if (evidence) {
    const metaEvent: Event = {
      type: "AgentExited",
      taskId: task.id,
      ts,
      fenceToken,
      exitCode: 0,
      reportedCost: 1,
      agentContext: ctx,
    };
    const err = submitOrError(core, metaEvent);
    if (err) return err;
  }

  const transition: PhaseTransition = {
    type: "PhaseTransition",
    taskId: task.id,
    ts: ts + 1,
    from: { phase: "execution", condition: "active" },
    to: { phase: "review", condition: "ready" },
    reasonCode: "work_complete",
    reason: evidence ?? "Work complete",
    fenceToken,
    agentContext: ctx,
  };

  const err = submitOrError(core, transition);
  if (err) return err;

  return {
    status: 200,
    body: { ok: true, taskId: task.id, transition: "execution.active → review.ready" },
  };
}

/** done: review.active → completed (via ReviewVerdict + ReviewPolicyMet + TaskCompleted) */
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";

function notifyInformed(task: Task, event: string, detail?: string): void {
  const informed = task.metadata["informed"];
  if (!informed || !Array.isArray(informed) || informed.length === 0) return;
  if (!TELEGRAM_BOT_TOKEN) return;
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
    }).catch(() => {});
  }
}

function mergeCodeBranch(config: Config, task: Task): void {
  const targetRepo = (task.metadata["repo"] as string | undefined) || config.defaultCodeRepo || undefined;
  if (!targetRepo) return;
  const parentId = task.parentId ?? (task.metadata["parentId"] as string | undefined) ?? null;
  try {
    mergeTaskBranch(targetRepo, task.id, parentId);
  } catch (err) {
    console.warn(`[http] T${task.id} code branch merge failed (non-fatal):`, err);
  }
}

/**
 * For root-level code tasks (no parent or parent has no repo),
 * create a GitHub PR from task/T{id} → baseBranch.
 * Stores PR URL in task metadata via a side-effect log (non-blocking).
 */
function maybeCreatePr(config: Config, task: Task, core: Core): void {
  const targetRepo = (task.metadata["repo"] as string | undefined) || config.defaultCodeRepo || undefined;
  if (!targetRepo) return;

  // Only create PR for root code tasks (no parent, or parent without repo)
  if (task.parentId) {
    const parent = core.getState().tasks[task.parentId];
    if (parent) {
      const parentRepo = (parent.metadata["repo"] as string | undefined) || config.defaultCodeRepo || undefined;
      if (parentRepo) return; // parent also has a repo — child merges locally, parent creates PR
    }
  }

  const branch = taskBranch(task.id);
  const baseBranch = (task.metadata["baseBranch"] as string | undefined) || "main";
  const title = `T${task.id}: ${task.title}`;
  const body = [
    `## Task ${task.id}`,
    "",
    task.title,
    "",
    `Branch: \`${branch}\` → \`${baseBranch}\``,
  ].join("\n");

  try {
    const result = createOrFindPr(targetRepo, branch, baseBranch, title, body);
    if (result.url) {
      console.log(`[http] T${task.id} PR ${result.created ? "created" : "found"}: ${result.url}`);
    } else if (result.error) {
      console.warn(`[http] T${task.id} PR creation failed (non-fatal): ${result.error}`);
    }
  } catch (err) {
    console.warn(`[http] T${task.id} PR creation failed (non-fatal):`, err);
  }
}

function applyDoneTransition(
  core: Core,
  config: Config,
  task: Task,
  fenceToken: number,
  ctx: AgentContext,
  ts: number,
  evidence?: string,
  stateRef?: StateRef,
): RouteResult {
  if (task.phase === "execution" && task.condition === "active" && task.reviewConfig === null) {
    // Verify artifacts before allowing completion
    const verification = verifyArtifacts(task, config);
    const verificationEvent: CompletionVerificationRecorded = {
      type: "CompletionVerificationRecorded",
      taskId: task.id,
      ts,
      verification,
    };
    submitOrError(core, verificationEvent);

    if (!verification.passed) {
      console.warn(`[http] T${task.id} completion verification failed: ${verification.reason}`);
      return {
        status: 422,
        body: {
          error: "verification_failed",
          message: verification.reason,
          verification,
        },
      };
    }

    const completed: TaskCompleted = {
      type: "TaskCompleted",
      taskId: task.id,
      ts: ts + 1,
      stateRef: stateRef ?? defaultStateRef(),
      source: { type: "agent", id: ctx.agentId },
    };
    const err = submitOrError(core, completed);
    if (err) return err;

    notifyInformed(task, "✅ Done");
    mergeCodeBranch(config, task);
    maybeCreatePr(config, task, core);

    return {
      status: 200,
      body: { ok: true, taskId: task.id, transition: "execution.active → done", verification },
    };
  }

  if (task.phase !== "review" || task.condition !== "active") {
    return {
      status: 409,
      body: {
        error: "invalid_state",
        message: `Task must be in review.active for done (or execution.active without reviewer), got ${task.phase}.${task.condition}`,
      },
    };
  }

  // Verify artifacts before allowing completion (review path)
  const verification = verifyArtifacts(task, config);
  const verificationEvent: CompletionVerificationRecorded = {
    type: "CompletionVerificationRecorded",
    taskId: task.id,
    ts,
    verification,
  };
  submitOrError(core, verificationEvent);

  if (!verification.passed) {
    console.warn(`[http] T${task.id} completion verification failed: ${verification.reason}`);
    return {
      status: 422,
      body: {
        error: "verification_failed",
        message: verification.reason,
        verification,
      },
    };
  }

  const round = task.reviewState?.round ?? 1;

  // 1. ReviewVerdictSubmitted
  const verdict: ReviewVerdictSubmitted = {
    type: "ReviewVerdictSubmitted",
    taskId: task.id,
    ts,
    fenceToken,
    reviewer: ctx.agentId,
    round,
    verdict: "approve",
    reasoning: evidence ?? "Approved",
    agentContext: ctx,
  };
  let err = submitOrError(core, verdict);
  if (err) return err;

  // 2. ReviewPolicyMet
  const policyMet: ReviewPolicyMet = {
    type: "ReviewPolicyMet",
    taskId: task.id,
    ts: ts + 1,
    outcome: "approved",
    summary: evidence ?? "Review approved",
    source: { type: "middle", id: "daemon" },
  };
  err = submitOrError(core, policyMet);
  if (err) return err;

  // 3. TaskCompleted
  const completed: TaskCompleted = {
    type: "TaskCompleted",
    taskId: task.id,
    ts: ts + 2,
    stateRef: stateRef ?? defaultStateRef(),
    source: { type: "agent", id: ctx.agentId },
  };
  err = submitOrError(core, completed);
  if (err) return err;

  notifyInformed(task, "✅ Done");
  mergeCodeBranch(config, task);
  maybeCreatePr(config, task, core);

  return {
    status: 200,
    body: { ok: true, taskId: task.id, transition: "review.active → done" },
  };
}

/** reject: review.active → failed */
function applyRejectTransition(
  core: Core,
  task: Task,
  fenceToken: number,
  ctx: AgentContext,
  ts: number,
  evidence?: string,
): RouteResult {
  if (task.phase !== "review" || task.condition !== "active") {
    return {
      status: 409,
      body: {
        error: "invalid_state",
        message: `Task must be in review.active for reject, got ${task.phase}.${task.condition}`,
      },
    };
  }

  const round = task.reviewState?.round ?? 1;

  const verdict: ReviewVerdictSubmitted = {
    type: "ReviewVerdictSubmitted",
    taskId: task.id,
    ts,
    fenceToken,
    reviewer: ctx.agentId,
    round,
    verdict: "reject",
    reasoning: evidence ?? "Rejected",
    agentContext: ctx,
  };
  let err = submitOrError(core, verdict);
  if (err) return err;

  // Check if review attempts remain — if so, send back to execution for revision
  const reviewUsed = task.attempts.review.used;
  const reviewMax = task.attempts.review.max;
  const canRetry = reviewUsed < reviewMax;

  if (canRetry) {
    const policyMet: ReviewPolicyMet = {
      type: "ReviewPolicyMet",
      taskId: task.id,
      ts: ts + 1,
      outcome: "changes_requested",
      summary: evidence ?? "Rejected by reviewer — sending back for revision",
      source: { type: "middle", id: "daemon" },
    };
    err = submitOrError(core, policyMet);
    if (err) return err;

    const transition: PhaseTransition = {
      type: "PhaseTransition",
      taskId: task.id,
      ts: ts + 2,
      from: { phase: "review", condition: "active" },
      to: { phase: "execution", condition: "ready" },
      reasonCode: "changes_requested",
      reason: evidence ?? "Rejected by reviewer — revision needed",
      fenceToken,
      agentContext: ctx,
    };
    err = submitOrError(core, transition);
    if (err) return err;

    notifyInformed(task, "🔄 Changes requested", evidence ?? "Rejected by reviewer — sent back for revision");

    return {
      status: 200,
      body: { ok: true, taskId: task.id, transition: "review.active → execution.ready (changes requested)" },
    };
  }

  // No review attempts left — terminal failure
  const policyMet: ReviewPolicyMet = {
    type: "ReviewPolicyMet",
    taskId: task.id,
    ts: ts + 1,
    outcome: "escalated",
    summary: evidence ?? "Rejected by reviewer — no review attempts remaining",
    source: { type: "middle", id: "daemon" },
  };
  err = submitOrError(core, policyMet);
  if (err) return err;

  const failed: TaskFailed = {
    type: "TaskFailed",
    taskId: task.id,
    ts: ts + 2,
    reason: "review_rejected",
    phase: "review",
    summary: {
      childId: null,
      approach: "review phase",
      whatFailed: evidence ?? "Rejected by reviewer",
      whatWasLearned: "Reviewer rejected the submission. All review attempts exhausted.",
      artifactRef: null,
    },
    source: { type: "agent", id: ctx.agentId },
  };
  err = submitOrError(core, failed);
  if (err) return err;

  notifyInformed(task, "❌ Rejected (final)", evidence ?? "Rejected by reviewer — all attempts exhausted");

  return {
    status: 200,
    body: { ok: true, taskId: task.id, transition: "review.active → failed (review budget exhausted)" },
  };
}

/** blocked: any active state → TaskBlocked */
function applyBlockedTransition(
  core: Core,
  task: Task,
  ts: number,
  blocker: string,
  ctx?: AgentContext,
): RouteResult {
  const summary: FailureSummary = {
    childId: null,
    approach: task.phase ?? "unknown",
    whatFailed: blocker,
    whatWasLearned: "Agent reported blocked — awaiting resolution.",
    artifactRef: null,
  };

  const agentId = ctx?.agentId ?? task.leasedTo;
  const blocked: TaskBlocked = {
    type: "TaskBlocked",
    taskId: task.id,
    ts,
    reason: blocker,
    reasonCode: "agent_reported_blocked",
    summary,
    source: agentId ? { type: "agent", id: agentId } : { type: "middle", id: "daemon" },
  };

  const err = submitOrError(core, blocked);
  if (err) return err;

  notifyInformed(task, "🚫 Blocked", blocker);

  return {
    status: 200,
    body: { ok: true, taskId: task.id, transition: `${task.phase}.${task.condition} → blocked` },
  };
}



/** cancel: any non-terminal state -> TaskCanceled */
function applyCancelTransition(
  core: Core,
  task: Task,
  ts: number,
  evidence?: string,
  ctx?: AgentContext,
): RouteResult {
  const agentId = ctx?.agentId ?? task.leasedTo;
  const canceled: TaskCanceled = {
    type: "TaskCanceled",
    taskId: task.id,
    ts,
    reason: "manual",
    source: agentId ? { type: "agent", id: agentId } : { type: "middle", id: "daemon" },
  };

  const err = submitOrError(core, canceled);
  if (err) return err;

  return {
    status: 200,
    body: {
      ok: true,
      taskId: task.id,
      transition: `${task.phase ?? "null"}.${task.condition ?? "null"} -> canceled`,
      note: evidence ?? null,
    },
  };
}
/** pending (changes_requested): review.active → execution.ready */
function applyChangesRequestedTransition(
  core: Core,
  task: Task,
  fenceToken: number,
  ctx: AgentContext,
  ts: number,
  evidence?: string,
): RouteResult {
  if (task.phase !== "review" || task.condition !== "active") {
    return {
      status: 409,
      body: {
        error: "invalid_state",
        message: `Task must be in review.active for changes_requested, got ${task.phase}.${task.condition}`,
      },
    };
  }

  const round = task.reviewState?.round ?? 1;

  // 1. ReviewVerdictSubmitted (changes_requested)
  const verdict: ReviewVerdictSubmitted = {
    type: "ReviewVerdictSubmitted",
    taskId: task.id,
    ts,
    fenceToken,
    reviewer: ctx.agentId,
    round,
    verdict: "changes_requested",
    reasoning: evidence ?? "Changes requested",
    agentContext: ctx,
  };
  let err = submitOrError(core, verdict);
  if (err) return err;

  // 2. ReviewPolicyMet (changes_requested)
  const policyMet: ReviewPolicyMet = {
    type: "ReviewPolicyMet",
    taskId: task.id,
    ts: ts + 1,
    outcome: "changes_requested",
    summary: evidence ?? "Changes requested",
    source: { type: "middle", id: "daemon" },
  };
  err = submitOrError(core, policyMet);
  if (err) return err;

  // 3. PhaseTransition review.active → execution.ready
  const transition: PhaseTransition = {
    type: "PhaseTransition",
    taskId: task.id,
    ts: ts + 2,
    from: { phase: "review", condition: "active" },
    to: { phase: "execution", condition: "ready" },
    reasonCode: "changes_requested",
    reason: evidence ?? "Changes requested by reviewer",
    fenceToken,
    agentContext: ctx,
  };
  err = submitOrError(core, transition);
  if (err) return err;

  return {
    status: 200,
    body: { ok: true, taskId: task.id, transition: "review.active → execution.ready" },
  };
}

/** execute: analysis.active → execution.ready */
function applyExecuteTransition(
  core: Core,
  task: Task,
  fenceToken: number,
  ctx: AgentContext,
  ts: number,
): RouteResult {
  if (task.phase !== "analysis" || task.condition !== "active") {
    return {
      status: 409,
      body: {
        error: "invalid_state",
        message: `Task must be in analysis.active for execute, got ${task.phase}.${task.condition}`,
      },
    };
  }

  const transition: PhaseTransition = {
    type: "PhaseTransition",
    taskId: task.id,
    ts,
    from: { phase: "analysis", condition: "active" },
    to: { phase: "execution", condition: "ready" },
    reasonCode: "decision_execute",
    reason: "Analysis complete, proceeding to execution",
    fenceToken,
    agentContext: ctx,
  };

  const err = submitOrError(core, transition);
  if (err) return err;

  return {
    status: 200,
    body: { ok: true, taskId: task.id, transition: "analysis.active → execution.ready" },
  };
}

function applyDecomposeTransition(
  core: Core,
  task: Task,
  fenceToken: number,
  ctx: AgentContext,
  ts: number,
): RouteResult {
  if (task.phase !== "analysis" || task.condition !== "active") {
    return {
      status: 409,
      body: {
        error: "invalid_state",
        message: `Task must be in analysis.active for decompose, got ${task.phase}.${task.condition}`,
      },
    };
  }

  const transition: PhaseTransition = {
    type: "PhaseTransition",
    taskId: task.id,
    ts,
    from: { phase: "analysis", condition: "active" },
    to: { phase: "decomposition", condition: "ready" },
    reasonCode: "decision_decompose",
    reason: "Analysis complete, decomposing into subtasks",
    fenceToken,
    agentContext: ctx,
  };

  const err = submitOrError(core, transition);
  if (err) return err;

  return {
    status: 200,
    body: { ok: true, taskId: task.id, transition: "analysis.active → decomposition.ready" },
  };
}

// ---------------------------------------------------------------------------
// POST /tasks/:id/decompose/start — begin incremental decomposition session
// ---------------------------------------------------------------------------

function handleDecomposeStart(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params, _body) => {
    const taskId = params["id"]!;
    const task = core.getTask(taskId);

    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }
    if (task.terminal) {
      return { status: 409, body: { error: "terminal", message: `Task ${taskId} is already ${task.terminal}` } };
    }

    // Accept from analysis.active or decomposition.active
    if (
      !((task.phase === "analysis" && task.condition === "active") ||
        (task.phase === "decomposition" && task.condition === "active"))
    ) {
      return {
        status: 409,
        body: {
          error: "invalid_state",
          message: `Task must be in analysis.active or decomposition.active, got ${task.phase}.${task.condition}`,
        },
      };
    }

    // Idempotent: return existing session if one exists
    const existing = pendingDecompositions.get(taskId);
    if (existing) {
      const costRemaining = computeCostRemaining(task);
      const usedCost = existing.children.reduce((s, c) => s + c.costAllocation, 0);
      return {
        status: 200,
        body: {
          ok: true,
          taskId,
          session: "resumed",
          budget: costRemaining,
          budgetRemaining: costRemaining - usedCost,
          childrenSoFar: existing.children.length,
          decompositionVersion: task.decompositionVersion + 1,
          guidance: buildAddChildGuidance(taskId),
        },
      };
    }

    const costRemaining = computeCostRemaining(task);

    pendingDecompositions.set(taskId, {
      taskId,
      startedAt: Date.now(),
      approach: "",
      children: [],
      checkpointIndices: [],
    });

    return {
      status: 200,
      body: {
        ok: true,
        taskId,
        session: "created",
        budget: costRemaining,
        budgetRemaining: costRemaining,
        decompositionVersion: task.decompositionVersion + 1,
        guidance: buildAddChildGuidance(taskId),
      },
    };
  };
}

// POST /tasks/:id/decompose/add-child — add one child to pending session
function handleDecomposeAddChild(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const pending = pendingDecompositions.get(taskId);

    if (!pending) {
      return {
        status: 409,
        body: { error: "no_session", message: `No pending decomposition session for T${taskId}. Call POST /tasks/${taskId}/decompose/start first.` },
      };
    }

    const task = core.getTask(taskId);
    if (!task) {
      pendingDecompositions.delete(taskId);
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    const b = body as {
      title?: string;
      description?: string;
      costAllocation?: number;
      skipAnalysis?: boolean;
      assignee?: string;
      reviewer?: string;
      priority?: string;
      dependsOnSiblings?: number[];
    };

    // Validate required fields
    if (!b.title || !b.title.trim()) {
      return { status: 400, body: { error: "missing_title", message: "title is required" } };
    }
    if (!b.description || !b.description.trim()) {
      return { status: 400, body: { error: "missing_description", message: "description is required" } };
    }
    if (b.costAllocation == null || b.costAllocation <= 0) {
      return { status: 400, body: { error: "invalid_cost", message: "costAllocation must be > 0" } };
    }

    // Validate sibling indices
    if (b.dependsOnSiblings) {
      for (const idx of b.dependsOnSiblings) {
        if (idx < 0 || idx >= pending.children.length) {
          return {
            status: 400,
            body: { error: "invalid_sibling_index", message: `dependsOnSiblings index ${idx} is out of range (0..${pending.children.length - 1})` },
          };
        }
      }
    }

    // Validate cumulative cost
    const costRemaining = computeCostRemaining(task);
    const usedCost = pending.children.reduce((s, c) => s + c.costAllocation, 0);
    const newTotal = usedCost + b.costAllocation;
    if (newTotal > costRemaining) {
      return {
        status: 422,
        body: {
          error: "cost_exceeded",
          message: `Adding ${b.costAllocation} would bring total to ${newTotal}, exceeding budget ${costRemaining}`,
        },
      };
    }

    const childIndex = pending.children.length;
    pending.children.push({
      title: b.title.trim(),
      description: b.description.trim(),
      costAllocation: b.costAllocation,
      skipAnalysis: b.skipAnalysis ?? false,
      assignee: b.assignee,
      reviewer: b.reviewer,
      priority: b.priority,
      dependsOnSiblings: b.dependsOnSiblings ?? [],
    });

    const childrenSummary = pending.children.map((c, i) => ({
      index: i,
      title: c.title,
      costAllocation: c.costAllocation,
    }));

    return {
      status: 200,
      body: {
        ok: true,
        childIndex,
        childrenSoFar: pending.children.length,
        budgetRemaining: costRemaining - newTotal,
        children: childrenSummary,
        guidance: `Child ${childIndex} added ("${b.title.trim()}"). Add another child or commit the decomposition:\n` +
          `  curl -s -X POST http://127.0.0.1:18800/tasks/${taskId}/decompose/add-child -H 'Content-Type: application/json' -d '{...}'\n` +
          `  curl -s -X POST http://127.0.0.1:18800/tasks/${taskId}/decompose/commit -H 'Content-Type: application/json' -d '{"approach": "your strategy"}'`,
      },
    };
  };
}

// POST /tasks/:id/decompose/checkpoint — set checkpoint children
function handleDecomposeCheckpoint(): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const pending = pendingDecompositions.get(taskId);
    if (!pending) {
      return {
        status: 409,
        body: { error: "no_session", message: `No pending decomposition session for T${taskId}. Call POST /tasks/${taskId}/decompose/start first.` },
      };
    }

    const b = body as { indices?: number[] };
    const indices = b.indices ?? [];
    for (const idx of indices) {
      if (!Number.isInteger(idx) || idx < 0 || idx >= pending.children.length) {
        return {
          status: 400,
          body: { error: "invalid_index", message: `Child index ${idx} is out of range (0-${pending.children.length - 1})` },
        };
      }
    }

    pending.checkpointIndices = indices;

    return {
      status: 200,
      body: {
        ok: true,
        taskId,
        checkpointIndices: indices,
        children: pending.children.map((c, i) => ({
          index: i,
          title: c.title,
          isCheckpoint: indices.includes(i),
        })),
      },
    };
  };
}

// POST /tasks/:id/decompose/commit — finalize decomposition
function handleDecomposeCommit(
  core: Core,
  config: Config,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const pending = pendingDecompositions.get(taskId);

    if (!pending) {
      return {
        status: 409,
        body: { error: "no_session", message: `No pending decomposition session for T${taskId}. Call POST /tasks/${taskId}/decompose/start first.` },
      };
    }

    if (pending.children.length === 0) {
      return {
        status: 400,
        body: { error: "no_children", message: "At least one child must be added before committing" },
      };
    }

    const b = body as { approach?: string; coordinationMode?: string };
    const approach = b.approach ?? (pending.approach || "Decomposed via incremental CLI");

    // Delegate to the one-shot handler logic by constructing a DecomposeBody
    // and reusing handleDecompose's internals. Instead, we directly inline the
    // same logic to avoid coupling, since we already have the pending state.

    let task = core.getTask(taskId);
    if (!task) {
      pendingDecompositions.delete(taskId);
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }
    if (task.terminal) {
      pendingDecompositions.delete(taskId);
      return { status: 409, body: { error: "terminal", message: `Task ${taskId} is already ${task.terminal}` } };
    }

    const now = Date.now();

    // Transition from analysis.active if needed (same logic as handleDecompose)
    if (task.phase === "analysis" && task.condition === "active") {
      const fenceToken = task.currentFenceToken;
      const ctx = agentContextFor(task);

      const pt: PhaseTransition = {
        type: "PhaseTransition", taskId, ts: now,
        from: { phase: "analysis", condition: "active" },
        to: { phase: "decomposition", condition: "ready" },
        reasonCode: "decision_decompose",
        reason: approach,
        fenceToken, agentContext: ctx,
      };
      let err = submitOrError(core, pt);
      if (err) { pendingDecompositions.delete(taskId); return err; }

      const newFence = fenceToken + 1;
      const lg: LeaseGranted = {
        type: "LeaseGranted", taskId, ts: now + 1,
        fenceToken: newFence,
        agentId: ctx.agentId,
        phase: "decomposition",
        leaseTimeout: 300_000,
        sessionId: ctx.sessionId,
        sessionType: "fresh",
        contextBudget: config.defaultContextBudget,
        agentContext: ctx,
      };
      err = submitOrError(core, lg);
      if (err) { pendingDecompositions.delete(taskId); return err; }

      task = core.getTask(taskId)!;
    } else if (task.phase !== "decomposition" || task.condition !== "active") {
      pendingDecompositions.delete(taskId);
      return {
        status: 409,
        body: {
          error: "invalid_state",
          message: `Task must be in analysis.active or decomposition.active, got ${task.phase}.${task.condition}`,
        },
      };
    }

    // Task is now in decomposition.active — create children
    const fenceToken = task.currentFenceToken;
    const ctx = agentContextFor(task);
    const version = task.decompositionVersion + 1;

    // Validate total cost doesn't exceed remaining budget
    const costRemaining = computeCostRemaining(task);
    const totalChildCost = pending.children.reduce((s, c) => s + c.costAllocation, 0);
    if (totalChildCost > costRemaining) {
      pendingDecompositions.delete(taskId);
      return {
        status: 422,
        body: {
          error: "cost_exceeded",
          message: `Total child cost (${totalChildCost}) exceeds parent remaining budget (${costRemaining})`,
        },
      };
    }

    // Generate unique child IDs
    const baseId = parseInt(nextTaskId(core), 10);
    const childIdMap: Record<number, string> = {};
    const childSpecs: DecompositionChildSpec[] = [];

    for (let i = 0; i < pending.children.length; i++) {
      const childId = String(baseId + i);
      childIdMap[i] = childId;
      const child = pending.children[i]!;

      const deps: Dependency[] = [];
      for (const sibIdx of child.dependsOnSiblings) {
        const depTargetId = childIdMap[sibIdx];
        if (depTargetId) {
          deps.push({
            id: `dep-${childId}-on-${depTargetId}`,
            type: "task",
            target: depTargetId,
            blocking: true,
            timing: "before_start",
            status: "pending",
          });
        }
      }

      const parentPriority = (task.metadata["priority"] as string | undefined) ?? "medium";
      const metadata: Record<string, unknown> = {};
      if (child.assignee) metadata["assignee"] = child.assignee;
      if (child.reviewer) metadata["reviewer"] = child.reviewer;
      const childPriority = ("priority" in child ? (child as { priority?: string }).priority : undefined) ?? "medium";
      metadata["priority"] = maxPriority(parentPriority, childPriority);

      childSpecs.push({
        taskId: childId,
        title: child.title,
        description: child.description,
        costAllocation: child.costAllocation,
        skipAnalysis: child.skipAnalysis,
        dependencies: deps,
        metadata,
      });
    }

    // Map checkpoint indices to child task IDs
    const checkpointTaskIds: string[] = (pending.checkpointIndices ?? [])
      .map((idx) => childIdMap[idx])
      .filter((id): id is string => id !== undefined);

    // Submit DecompositionCreated
    // Default to sequential_children for new decompositions; pass "parallel" to opt out
    const coordMode = b.coordinationMode === "parallel" ? null : { mode: "sequential_children" as const, reviewBetweenChildren: false };

    const decomp: DecompositionCreated = {
      type: "DecompositionCreated",
      taskId, ts: now + 3,
      fenceToken,
      version,
      children: childSpecs,
      checkpoints: checkpointTaskIds,
      completionRule: "and",
      agentContext: ctx,
      coordinationMode: coordMode,
    };

    let err = submitOrError(core, decomp);
    if (err) { pendingDecompositions.delete(taskId); return err; }

    // Transition parent to analysis.waiting (blocked on children)
    const waitTransition: PhaseTransition = {
      type: "PhaseTransition",
      taskId, ts: now + 4,
      from: { phase: "decomposition", condition: "active" },
      to: { phase: "analysis", condition: "waiting" },
      reasonCode: "children_created",
      reason: `Decomposed into ${pending.children.length} subtasks`,
      fenceToken,
      agentContext: ctx,
    };

    err = submitOrError(core, waitTransition);
    if (err) { pendingDecompositions.delete(taskId); return err; }

    // Clean up pending session
    pendingDecompositions.delete(taskId);

    return {
      status: 200,
      body: {
        ok: true,
        taskId,
        children: childSpecs.map(c => ({ id: c.taskId, title: c.title, costAllocation: c.costAllocation })),
        decompositionVersion: version,
        transition: "→ analysis.waiting",
      },
    };
  };
}

// POST /tasks/:id/decompose/cancel — discard pending decomposition session
function handleDecomposeCancel(
  core: Core,
): RouteDef["handler"] {
  return async (_req, params) => {
    const taskId = params["id"]!;
    const task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }

    const existed = pendingDecompositions.delete(taskId);
    return {
      status: 200,
      body: {
        ok: true,
        taskId,
        canceled: existed,
      },
    };
  };
}

// Helpers for incremental decomposition
export function cleanupPendingDecompositions(core: Core): void {
  for (const [taskId] of pendingDecompositions) {
    const task = core.getTask(taskId);
    if (
      !task ||
      task.terminal !== null ||
      (task.phase !== "analysis" && task.phase !== "decomposition")
    ) {
      pendingDecompositions.delete(taskId);
    }
  }
}

function computeCostRemaining(task: Task): number {
  return task.cost.allocated - task.cost.consumed - task.cost.childAllocated + task.cost.childRecovered;
}

function buildAddChildGuidance(taskId: string): string {
  return `Add children one at a time:\n` +
    `  curl -s -X POST http://127.0.0.1:18800/tasks/${taskId}/decompose/add-child \\\n` +
    `    -H 'Content-Type: application/json' \\\n` +
    `    -d '{"title": "...", "description": "...", "costAllocation": 10}'\n\n` +
    `Optional fields: assignee, reviewer, dependsOnSiblings (array of sibling indices, 0-based), skipAnalysis (default false — only set true for trivial tasks).\n` +
    `When done adding children, commit:\n` +
    `  curl -s -X POST http://127.0.0.1:18800/tasks/${taskId}/decompose/commit \\\n` +
    `    -H 'Content-Type: application/json' \\\n` +
    `    -d '{"approach": "brief description of decomposition strategy"}'`;
}

// ---------------------------------------------------------------------------
// POST /tasks/:id/decompose — one-shot decomposition endpoint (kept for compatibility)
// ---------------------------------------------------------------------------

function handleDecompose(
  core: Core,
  config: Config,
): RouteDef["handler"] {
  return async (_req, params, body) => {
    const taskId = params["id"]!;
    const b = body as DecomposeBody;

    if (!b.children || !Array.isArray(b.children) || b.children.length === 0) {
      return { status: 400, body: { error: "missing_children", message: "children array required with at least one child" } };
    }

    let task = core.getTask(taskId);
    if (!task) {
      return { status: 404, body: { error: "not_found", message: `Task ${taskId} not found` } };
    }
    if (task.terminal) {
      return { status: 409, body: { error: "terminal", message: `Task ${taskId} is already ${task.terminal}` } };
    }

    const now = Date.now();

    // Accept from analysis.active or decomposition.active
    if (task.phase === "analysis" && task.condition === "active") {
      // Chain internal events: analysis.active → decomposition.ready → leased → active
      const fenceToken = task.currentFenceToken;
      const ctx = agentContextFor(task);

      // 1. PhaseTransition to decomposition.ready
      const pt: PhaseTransition = {
        type: "PhaseTransition", taskId, ts: now,
        from: { phase: "analysis", condition: "active" },
        to: { phase: "decomposition", condition: "ready" },
        reasonCode: "decision_decompose",
        reason: b.approach ?? "Decomposing into subtasks",
        fenceToken, agentContext: ctx,
      };
      let err = submitOrError(core, pt);
      if (err) return err;

      // 2. LeaseGranted for decomposition phase
      const newFence = fenceToken + 1;
      const lg: LeaseGranted = {
        type: "LeaseGranted", taskId, ts: now + 1,
        fenceToken: newFence,
        agentId: ctx.agentId,
        phase: "decomposition",
        leaseTimeout: 300_000,
        sessionId: ctx.sessionId,
        sessionType: "fresh",
        contextBudget: config.defaultContextBudget,
        agentContext: ctx,
      };
      err = submitOrError(core, lg);
      if (err) return err;

      // Re-fetch task after state changes
      task = core.getTask(taskId)!;
    } else if (task.phase !== "decomposition" || task.condition !== "active") {
      return {
        status: 409,
        body: {
          error: "invalid_state",
          message: `Task must be in analysis.active or decomposition.active, got ${task.phase}.${task.condition}`,
        },
      };
    }

    // Task is now in decomposition.active — create children
    const fenceToken = task.currentFenceToken;
    const ctx = agentContextFor(task);
    const version = task.decompositionVersion + 1;

    // Validate total cost doesn't exceed remaining budget
    const costRemaining = task.cost.allocated - task.cost.consumed - task.cost.childAllocated + task.cost.childRecovered;
    const totalChildCost = b.children.reduce((sum, c) => sum + c.costAllocation, 0);
    if (totalChildCost > costRemaining) {
      return {
        status: 422,
        body: {
          error: "cost_exceeded",
          message: `Total child cost (${totalChildCost}) exceeds parent remaining budget (${costRemaining})`,
        },
      };
    }

    // Generate unique child IDs (sequential from next available)
    const baseId = parseInt(nextTaskId(core), 10);
    const childIdMap: Record<number, string> = {};
    const childSpecs: DecompositionChildSpec[] = [];

    for (let i = 0; i < b.children.length; i++) {
      const childId = String(baseId + i);
      childIdMap[i] = childId;
      const child = b.children[i]!;

      // Build dependencies from sibling indices
      const deps: Dependency[] = [];
      if (child.dependsOnSiblings) {
        for (const sibIdx of child.dependsOnSiblings) {
          const depTargetId = childIdMap[sibIdx];
          if (depTargetId) {
            deps.push({
              id: `dep-${childId}-on-${depTargetId}`,
              type: "task",
              target: depTargetId,
              blocking: true,
              timing: "before_start",
              status: "pending",
            });
          }
        }
      }

      const parentPriority = (task.metadata["priority"] as string | undefined) ?? "medium";
      const metadata: Record<string, unknown> = {};
      if (child.assignee) metadata["assignee"] = child.assignee;
      if (child.reviewer) metadata["reviewer"] = child.reviewer;
      const childPriority = ("priority" in child ? (child as { priority?: string }).priority : undefined) ?? "medium";
      metadata["priority"] = maxPriority(parentPriority, childPriority);

      childSpecs.push({
        taskId: childId,
        title: child.title,
        description: child.description,
        costAllocation: child.costAllocation,
        skipAnalysis: child.skipAnalysis ?? false,
        dependencies: deps,
        metadata,
      });
    }

    // Submit DecompositionCreated
    // Default to sequential_children for new decompositions; pass "parallel" to opt out
    const coordMode2 = b.coordinationMode === "parallel" ? null : { mode: "sequential_children" as const, reviewBetweenChildren: false };

    const decomp: DecompositionCreated = {
      type: "DecompositionCreated",
      taskId, ts: now + 3,
      fenceToken,
      version,
      children: childSpecs,
      checkpoints: [],
      completionRule: "and",
      agentContext: ctx,
      coordinationMode: coordMode2,
    };

    let err = submitOrError(core, decomp);
    if (err) return err;

    // Transition parent to analysis.waiting (blocked on children)
    const waitTransition: PhaseTransition = {
      type: "PhaseTransition",
      taskId, ts: now + 4,
      from: { phase: "decomposition", condition: "active" },
      to: { phase: "analysis", condition: "waiting" },
      reasonCode: "children_created",
      reason: `Decomposed into ${b.children.length} subtasks`,
      fenceToken,
      agentContext: ctx,
    };

    err = submitOrError(core, waitTransition);
    if (err) return err;

    return {
      status: 200,
      body: {
        ok: true,
        taskId,
        children: childSpecs.map(c => ({ id: c.taskId, title: c.title, costAllocation: c.costAllocation })),
        decompositionVersion: version,
        transition: "→ analysis.waiting",
      },
    };
  };
}

// ---------------------------------------------------------------------------
// Attention endpoints
// ---------------------------------------------------------------------------

interface AttentionTask {
  id: string;
  title: string;
  terminal: string | null;
  phase: string | null;
  condition: string | null;
  priority: string;
  assignee: string | null;
  reason: string | null;
  updatedAt: number;
  reviewRound: number | null;
}

function collectAttentionTasks(core: Core): {
  blocked: AttentionTask[];
  failed: AttentionTask[];
  overdue: AttentionTask[];
  exhausted: AttentionTask[];
} {
  const state = core.getState();
  const allTasks = Object.values(state.tasks);
  const now = Date.now();

  const toSummary = (t: Task): AttentionTask => ({
    id: t.id,
    title: t.title,
    terminal: t.terminal,
    phase: t.phase,
    condition: t.condition,
    priority: (t.metadata["priority"] as string | undefined) ?? "medium",
    assignee: (t.metadata["assignee"] as string | undefined) ?? null,
    reason: t.terminalSummary?.whatFailed ?? null,
    updatedAt: t.updatedAt,
    reviewRound: t.reviewState?.round ?? null,
  });

  const blocked = allTasks
    .filter((t) => t.terminal === "blocked")
    .map(toSummary);

  const failed = allTasks
    .filter((t) => t.terminal === "failed")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 20)
    .map(toSummary);

  // Tasks whose lease has expired but haven't transitioned yet
  const overdue = allTasks
    .filter(
      (t) =>
        !t.terminal &&
        t.condition === "active" &&
        (
          t.leaseExpiresAt === null ||
          (typeof t.leasedTo !== "string" || t.leasedTo.trim().length === 0) ||
          t.leaseExpiresAt <= now
        ),
    )
    .map(toSummary);

  const exhausted = allTasks
    .filter((t) => t.condition === "exhausted")
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map(toSummary);

  return { blocked, failed, overdue, exhausted };
}

// GET /attention
function handleAttention(
  core: Core,
): RouteDef["handler"] {
  return async () => {
    const { blocked, failed, overdue, exhausted } = collectAttentionTasks(core);
    return {
      status: 200,
      body: {
        blocked: blocked.length,
        failed: failed.length,
        stalled: overdue.length,
        exhausted: exhausted.length,
        tasks: { blocked, failed, stalled: overdue, exhausted },
      },
    };
  };
}

// GET /attention/telegram
function handleAttentionTelegram(
  core: Core,
): RouteDef["handler"] {
  return async () => {
    const { blocked, failed, overdue, exhausted } = collectAttentionTasks(core);
    const total = blocked.length + failed.length + overdue.length + exhausted.length;

    if (total === 0) {
      return { status: 200, body: { text: "✅ No tasks need attention." } };
    }

    const lines: string[] = [`🚨 Attention needed (${total} tasks)`];

    if (blocked.length > 0) {
      lines.push("");
      lines.push(`BLOCKED (${blocked.length}):`);
      for (const t of blocked) {
        const pri = t.priority.toUpperCase().slice(0, 4);
        lines.push(`• T${t.id} [${pri}] ${t.title.slice(0, 50)}`);
        if (t.reason) lines.push(`  Reason: ${t.reason.slice(0, 80)}`);
      }
    }

    if (failed.length > 0) {
      lines.push("");
      lines.push(`FAILED (${failed.length}):`);
      for (const t of failed) {
        const pri = t.priority.toUpperCase().slice(0, 4);
        lines.push(`• T${t.id} [${pri}] ${t.title.slice(0, 50)}`);
        if (t.reason) lines.push(`  ${t.reason.slice(0, 80)}`);
      }
    }

    if (exhausted.length > 0) {
      lines.push("");
      lines.push(`EXHAUSTED (${exhausted.length}):`);
      for (const t of exhausted) {
        const pri = t.priority.toUpperCase().slice(0, 4);
        lines.push(`• T${t.id} [${pri}] ${t.title.slice(0, 50)}`);
        lines.push(`  Budget exhausted in ${t.phase} phase`);
      }
    }

    if (overdue.length > 0) {
      lines.push("");
      lines.push(`LEASE OVERDUE (${overdue.length}):`);
      for (const t of overdue) {
        const pri = t.priority.toUpperCase().slice(0, 4);
        lines.push(`• T${t.id} [${pri}] ${t.condition}, lease expired`);
      }
    }

    return { status: 200, body: { text: lines.join("\n") } };
  };
}
