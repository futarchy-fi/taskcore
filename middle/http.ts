import * as http from "node:http";
import type { Core } from "../core/index.js";
import type {
  AgentContext,
  AttemptBudgetMaxInput,
  BudgetIncreased,
  Dependency,
  Event,
  FailureSummary,
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
  TaskId,
  TaskReparented,
  TaskRevived,
  ValidationError,
} from "../core/types.js";
import { DEFAULT_ATTEMPT_BUDGETS } from "../core/types.js";
import type { Config } from "./config.js";
import { loadRegistry, validateMetadataRoles, type Registry } from "./registry.js";

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
  status: "review" | "done" | "blocked" | "pending" | "execute" | "decompose" | "cancel";
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
}

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

function submitOrError(core: Core, event: Event): RouteResult | null {
  const result = core.submit(event);
  if (!result.ok) {
    return {
      status: 422,
      body: { error: result.error.code, message: result.error.message },
    };
  }
  return null;
}

function defaultStateRef(): StateRef {
  return { branch: "main", commit: "0000000", parentCommit: "0000000" };
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
    { method: "GET", pattern: "/dispatchable", handler: handleDispatchable(core) },
    { method: "POST", pattern: "/tasks", handler: handleCreateTask(core, config, registry) },
    { method: "POST", pattern: "/tasks/:id/events", handler: handleSubmitEvent(core) },
    { method: "POST", pattern: "/tasks/:id/status", handler: handleStatusUpdate(core) },
    { method: "POST", pattern: "/tasks/:id/reparent", handler: handleReparent(core) },
    { method: "POST", pattern: "/tasks/:id/revive", handler: handleRevive(core) },
    { method: "POST", pattern: "/tasks/:id/budget", handler: handleBudgetIncrease(core) },
    { method: "PATCH", pattern: "/tasks/:id/metadata", handler: handleMetadataUpdate(core, registry) },
    { method: "GET", pattern: "/attention", handler: handleAttention(core) },
    { method: "GET", pattern: "/attention/telegram", handler: handleAttentionTelegram(core) },
  ];
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
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
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
        createdBy: "http-api",
        createdAt: new Date().toISOString(),
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
        return applyDoneTransition(core, task, fenceToken, ctx, now, b.evidence, b.stateRef);

      case "blocked":
        return applyBlockedTransition(core, task, now, b.blocker ?? b.evidence ?? "No reason provided");

      case "pending":
        return applyChangesRequestedTransition(core, task, fenceToken, ctx, now, b.evidence);

      case "execute":
        return applyExecuteTransition(core, task, fenceToken, ctx, now);

      case "decompose":
        return { status: 501, body: { error: "not_implemented", message: "Decompose via status not yet supported" } };

      case "cancel":
        return applyCancelTransition(core, task, now, b.evidence);

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

function applyDoneTransition(
  core: Core,
  task: Task,
  fenceToken: number,
  ctx: AgentContext,
  ts: number,
  evidence?: string,
  stateRef?: StateRef,
): RouteResult {
  if (task.phase !== "review" || task.condition !== "active") {
    return {
      status: 409,
      body: {
        error: "invalid_state",
        message: `Task must be in review.active for done, got ${task.phase}.${task.condition}`,
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
  };
  err = submitOrError(core, completed);
  if (err) return err;

  notifyInformed(task, "✅ Done");

  return {
    status: 200,
    body: { ok: true, taskId: task.id, transition: "review.active → done" },
  };
}

/** blocked: any active state → TaskBlocked */
function applyBlockedTransition(
  core: Core,
  task: Task,
  ts: number,
  blocker: string,
): RouteResult {
  const summary: FailureSummary = {
    childId: null,
    approach: task.phase ?? "unknown",
    whatFailed: blocker,
    whatWasLearned: "Agent reported blocked — awaiting resolution.",
    artifactRef: null,
  };

  const blocked: TaskBlocked = {
    type: "TaskBlocked",
    taskId: task.id,
    ts,
    reason: blocker,
    reasonCode: "agent_reported_blocked",
    summary,
    source: { type: "middle", id: "daemon" },
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
): RouteResult {
  const canceled: TaskCanceled = {
    type: "TaskCanceled",
    taskId: task.id,
    ts,
    reason: "manual",
    source: { type: "middle", id: "daemon" },
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
        (t.condition === "leased" || t.condition === "active") &&
        t.leaseExpiresAt !== null &&
        t.leaseExpiresAt <= now,
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
