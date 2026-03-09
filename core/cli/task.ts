#!/usr/bin/env node
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

const PORT = Number.parseInt(process.env["ORCHESTRATOR_PORT"] ?? "18800", 10);
const BASE_URL = `http://127.0.0.1:${Number.isFinite(PORT) ? PORT : 18800}`;
const ACTIVE_DIR = path.join(os.homedir(), ".taskcore", "active");

interface ApiResponse<T = unknown> {
  status: number;
  body: T;
}

interface TaskContext {
  taskId: string;
  phase: string | null;
  fenceToken: number;
  sessionId: string;
  journalPath: string;
  codeWorktree: string | null;
  claimedAt: number;
  reviewNotes?: string[];
}

type FlagValue = boolean | string | string[];

interface ParsedFlags {
  positionals: string[];
  flags: Record<string, FlagValue>;
}

class CliError extends Error {
  code: number;

  constructor(message: string, code = 1) {
    super(message);
    this.code = code;
  }
}

class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, body: unknown) {
    const bodyObj = asRecord(body);
    const msg = bodyObj?.["message"];
    const fallback = typeof msg === "string" ? msg : `API error (${status})`;
    super(fallback);
    this.status = status;
    this.body = body;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/** Check if an ApiError looks like a lease-expiry state mismatch and print a helpful message. Returns true if handled. */
function handleLeaseExpiryError(err: unknown, taskId: string, action: string): boolean {
  if (!(err instanceof ApiError)) return false;
  const body = asRecord(err.body);
  if (err.status !== 409 || body?.["error"] !== "invalid_state") return false;
  const msg = typeof body["message"] === "string" ? body["message"] : "";
  process.stderr.write(`\nCannot ${action}: ${msg}\n`);
  process.stderr.write(`This usually means your lease expired and the task reverted.\n`);
  process.stderr.write(`Run: task claim ${taskId}\n\n`);
  return true;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function asArray<T = unknown>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function formatMoney(value: unknown): string {
  const n = asNumber(value);
  if (n === null) return "n/a";
  return n.toFixed(2);
}

function formatIso(ts: unknown): string {
  const n = asNumber(ts);
  if (n === null) return "n/a";
  return new Date(n).toISOString().replace("T", " ").replace(".000Z", " UTC");
}

function normalizeTaskId(raw: string): string {
  const trimmed = raw.trim();
  const match = trimmed.match(/^T(\d+)$/i);
  if (match) return match[1]!;
  return trimmed;
}

function parseFlags(argv: string[]): ParsedFlags {
  const positionals: string[] = [];
  const flags: Record<string, FlagValue> = {};

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!token.startsWith("--")) {
      positionals.push(token);
      continue;
    }

    if (token === "--") {
      for (let j = i + 1; j < argv.length; j++) positionals.push(argv[j]!);
      break;
    }

    const eq = token.indexOf("=");
    let key = token.slice(2);
    let value: FlagValue = true;

    if (eq >= 0) {
      key = token.slice(2, eq);
      value = token.slice(eq + 1);
    } else {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) {
        value = next;
        i += 1;
      }
    }

    const existing = flags[key];
    if (existing === undefined) {
      flags[key] = value;
    } else if (Array.isArray(existing)) {
      existing.push(String(value));
      flags[key] = existing;
    } else {
      flags[key] = [String(existing), String(value)];
    }
  }

  return { positionals, flags };
}

function getFlagString(flags: Record<string, FlagValue>, key: string): string | undefined {
  const value = flags[key];
  if (value === undefined || value === false) return undefined;
  if (Array.isArray(value)) return value[value.length - 1];
  if (value === true) return undefined;
  return value;
}

function getFlagBool(flags: Record<string, FlagValue>, key: string): boolean {
  const value = flags[key];
  if (value === undefined) return false;
  if (value === true) return true;
  if (value === false) return false;
  if (Array.isArray(value)) {
    const last = value[value.length - 1]?.toLowerCase();
    return last === "1" || last === "true" || last === "yes" || last === "on";
  }
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function getFlagList(flags: Record<string, FlagValue>, key: string): string[] {
  const value = flags[key];
  if (value === undefined || value === false || value === true) return [];
  const raw = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const entry of raw) {
    for (const part of entry.split(",")) {
      const trimmed = part.trim();
      if (trimmed) out.push(trimmed);
    }
  }
  return out;
}

function parseDurationMs(raw: string | undefined, fallbackMs: number): number {
  if (!raw) return fallbackMs;
  const text = raw.trim().toLowerCase();
  const match = text.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) {
    throw new CliError(`Invalid duration: ${raw}. Use formats like 10m, 30m, 1h.`, 1);
  }
  const amount = Number.parseInt(match[1]!, 10);
  const unit = match[2] ?? "m";
  const multiplier = unit === "h" ? 3_600_000
    : unit === "m" ? 60_000
    : unit === "s" ? 1_000
    : 1;
  return amount * multiplier;
}

function findTaskFile(startDir: string): string | null {
  let current = path.resolve(startDir);

  while (true) {
    const candidate = path.join(current, ".task");
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function readTaskContext(): { filePath: string | null; context: TaskContext | null } {
  const taskFile = findTaskFile(process.cwd());
  if (!taskFile) return { filePath: null, context: null };

  try {
    const parsed = JSON.parse(fs.readFileSync(taskFile, "utf-8")) as unknown;
    const obj = asRecord(parsed);
    if (!obj) return { filePath: taskFile, context: null };

    const taskId = asString(obj["taskId"]);
    const phase = asString(obj["phase"]);
    const fenceToken = asNumber(obj["fenceToken"]);
    const sessionId = asString(obj["sessionId"]);
    const journalPath = asString(obj["journalPath"]);
    const codeWorktree = asString(obj["codeWorktree"]);
    const claimedAt = asNumber(obj["claimedAt"]);

    if (!taskId || fenceToken === null || !sessionId || !journalPath || claimedAt === null) {
      return { filePath: taskFile, context: null };
    }

    return {
      filePath: taskFile,
      context: {
        taskId,
        phase,
        fenceToken,
        sessionId,
        journalPath,
        codeWorktree,
        claimedAt,
        reviewNotes: asArray<string>(obj["reviewNotes"]),
      },
    };
  } catch {
    return { filePath: taskFile, context: null };
  }
}

function writeTaskContext(taskContext: TaskContext, roots: string[]): void {
  const content = JSON.stringify(taskContext, null, 2) + "\n";
  for (const root of roots) {
    if (!root) continue;
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, ".task"), content, "utf-8");
  }
}

function clearTaskContextFile(): void {
  const { filePath } = readTaskContext();
  if (filePath && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// --- Active task file: ~/.taskcore/active/{agent-id}.json ---

function activeTaskPath(agentId: string): string {
  return path.join(ACTIVE_DIR, `${agentId}.json`);
}

function writeActiveTask(agentId: string, context: TaskContext): void {
  fs.mkdirSync(ACTIVE_DIR, { recursive: true });
  const content = JSON.stringify(context, null, 2) + "\n";
  fs.writeFileSync(activeTaskPath(agentId), content, "utf-8");
}

function readActiveTask(agentId: string): TaskContext | null {
  const filePath = activeTaskPath(agentId);
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf-8")) as unknown;
    const obj = asRecord(parsed);
    if (!obj) return null;

    const taskId = asString(obj["taskId"]);
    const phase = asString(obj["phase"]);
    const fenceToken = asNumber(obj["fenceToken"]);
    const sessionId = asString(obj["sessionId"]);
    const journalPath = asString(obj["journalPath"]);
    const codeWorktree = asString(obj["codeWorktree"]);
    const claimedAt = asNumber(obj["claimedAt"]);

    if (!taskId || fenceToken === null || !sessionId || claimedAt === null) {
      return null;
    }

    return {
      taskId,
      phase,
      fenceToken,
      sessionId,
      journalPath: journalPath ?? "",
      codeWorktree,
      claimedAt,
      reviewNotes: asArray<string>(obj["reviewNotes"]),
    };
  } catch {
    return null;
  }
}

function clearActiveTask(agentId: string): void {
  const filePath = activeTaskPath(agentId);
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // ignore — file may already be gone
  }
}

function resolveAgentId(): string | undefined {
  return process.env["TASKCORE_AGENT_ID"]?.trim()
    || process.env["CLAW_NAME"]?.trim()
    || undefined;
}

function requireAgentId(): string {
  const agentId = resolveAgentId();
  if (!agentId) {
    throw new CliError("TASKCORE_AGENT_ID is required for this command.", 3);
  }
  return agentId;
}

/** Extract agent role from instance ID: "claude.3" → "claude", "coder" → "coder" */
function agentRole(agentId: string): string {
  const dot = agentId.indexOf(".");
  return dot >= 0 ? agentId.slice(0, dot) : agentId;
}

function currentTaskId(explicit?: string): string {
  if (explicit) return normalizeTaskId(explicit);

  // 1. .task file in cwd tree (worktree-native)
  const { context } = readTaskContext();
  if (context?.taskId) return normalizeTaskId(context.taskId);

  // 2. Active task file (~/.taskcore/active/{agent-id}.json)
  const agentId = resolveAgentId();
  if (agentId) {
    const active = readActiveTask(agentId);
    if (active?.taskId) return normalizeTaskId(active.taskId);
  }

  // 3. TASK_ID env var (lossy fallback — ID only)
  const envTaskId = process.env["TASK_ID"]?.trim();
  if (envTaskId) return normalizeTaskId(envTaskId);

  throw new CliError("No active task context. Claim a task first or pass a task id.", 1);
}

async function httpRequest(method: "GET" | "POST" | "PATCH", urlPath: string, body?: unknown): Promise<ApiResponse> {
  return await new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE_URL);
    const payload = body === undefined ? undefined : JSON.stringify(body);

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(payload),
          }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          if (!raw.trim()) {
            resolve({ status: res.statusCode ?? 500, body: {} });
            return;
          }

          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 500, body: raw });
          }
        });
      },
    );

    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

async function apiRequest(method: "GET" | "POST" | "PATCH", pathName: string, body?: unknown): Promise<Record<string, unknown>> {
  let response: ApiResponse;
  try {
    response = await httpRequest(method, pathName, body);
  } catch (err) {
    throw new CliError(`Unable to reach daemon at ${BASE_URL}: ${String(err)}`, 2);
  }

  const responseObj = asRecord(response.body);
  if (response.status < 200 || response.status >= 300) {
    throw new ApiError(response.status, responseObj ?? response.body);
  }

  return responseObj ?? {};
}

function printTable(rows: string[][]): void {
  if (rows.length === 0) return;

  const widths: number[] = [];
  for (const row of rows) {
    row.forEach((cell, idx) => {
      widths[idx] = Math.max(widths[idx] ?? 0, cell.length);
    });
  }

  for (const row of rows) {
    const line = row
      .map((cell, idx) => cell.padEnd(widths[idx] ?? cell.length))
      .join("  ");
    process.stdout.write(line + "\n");
  }
}

function priorityRank(priority: string): number {
  switch (priority) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    case "backlog": return 4;
    default: return 5;
  }
}

function toTaskListEntry(value: unknown): Record<string, unknown> | null {
  const t = asRecord(value);
  if (!t) return null;
  if (asString(t["id"]) === null) return null;
  return t;
}

function getString(obj: Record<string, unknown>, key: string, fallback = ""): string {
  const value = obj[key];
  return typeof value === "string" ? value : fallback;
}

function getNumber(obj: Record<string, unknown>, key: string, fallback = 0): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  if (hours < 24) return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  const remainingHours = hours % 24;
  return remainingHours > 0 ? `${days}d ${remainingHours}h` : `${days}d`;
}

function phaseGuidance(phase: string, condition: string): string[] {
  const state = `${phase}.${condition}`;
  switch (state) {
    case "analysis.ready":
      return ["Claim and analyze the task:", "  task claim <id>"];
    case "analysis.active":
      return [
        "You're analyzing this task. Next steps:",
        "  task decide execute       # ready to implement",
        "  task decide decompose     # break into subtasks",
        "  task block <reason>       # can't proceed",
      ];
    case "execution.ready":
      return ["Claim and start working:", "  task claim <id>"];
    case "execution.active":
      return [
        "You're executing this task. Next steps:",
        "  task submit <evidence>    # done, send for review",
        "  task complete <evidence>  # done, no review needed",
        "  task block <reason>       # stuck",
        "  task update <message>     # log progress",
        "  task cost <amount>        # report cost",
      ];
    case "review.ready":
      return ["Claim to start reviewing:", "  task claim <id>"];
    case "review.active":
      return [
        "You're reviewing this task. Next steps:",
        "  task review read          # read review materials",
        "  task review approve       # approve",
        "  task review reject        # reject",
        "  task review request-changes <notes>  # request changes",
      ];
    case "decomposition.ready":
      return ["Claim to decompose:", "  task claim <id>"];
    case "decomposition.active":
      return [
        "You're decomposing this task. Next steps:",
        "  task decompose start      # begin decomposition",
        "  task decompose add <...>  # add a child task",
        "  task decompose commit     # finalize children",
        "  task decompose cancel     # cancel decomposition",
      ];
    default:
      return [`State: ${state}`];
  }
}

async function cmdHome(jsonMode: boolean): Promise<void> {
  const agentId = resolveAgentId();

  // --- Try to find active task ---
  let activeContext: TaskContext | null = null;

  // 1. .task file in cwd
  const { context: cwdContext } = readTaskContext();
  if (cwdContext) activeContext = cwdContext;

  // 2. Active task file
  if (!activeContext && agentId) {
    activeContext = readActiveTask(agentId);
  }

  if (activeContext) {
    // Fetch live state from daemon
    let task: Record<string, unknown> | null = null;
    try {
      task = await getTask(activeContext.taskId);
    } catch {
      // daemon unreachable or task gone — show what we have from the file
    }

    const taskId = activeContext.taskId;
    const title = task ? getString(task, "title", "(untitled)") : "(unknown)";
    const phase = task ? getString(task, "phase", activeContext.phase ?? "unknown") : (activeContext.phase ?? "unknown");
    const condition = task ? getString(task, "condition", getString(task, "terminal", "unknown")) : "active";
    const terminal = task ? getString(task, "terminal", "") : "";
    const elapsed = formatDuration(Date.now() - activeContext.claimedAt);

    if (jsonMode) {
      const result: Record<string, unknown> = {
        mode: "active",
        taskId,
        title,
        phase,
        condition,
        terminal: terminal || undefined,
        fenceToken: activeContext.fenceToken,
        sessionId: activeContext.sessionId,
        elapsed,
        journalPath: activeContext.journalPath,
        codeWorktree: activeContext.codeWorktree,
      };
      if (task) result["task"] = task;
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return;
    }

    // Detect lease expiry: active file exists but task is no longer active for us
    const leaseExpired = !terminal && condition !== "active" && activeContext.fenceToken > 0;

    process.stdout.write(`\n  Active Task: T${taskId} — ${title}\n`);
    if (leaseExpired) {
      process.stdout.write(`\n  ⚠️  LEASE EXPIRED — task reverted to ${phase}.${condition}\n`);
      process.stdout.write(`  Your work may still be in the worktree. To reclaim:\n`);
      process.stdout.write(`    task claim ${taskId}\n\n`);
    }
    process.stdout.write(`  Phase:       ${phase}.${terminal || condition}\n`);
    process.stdout.write(`  Claimed:     ${elapsed} ago (fence ${activeContext.fenceToken})\n`);
    if (activeContext.codeWorktree) {
      process.stdout.write(`  Worktree:    ${activeContext.codeWorktree}\n`);
    }
    if (activeContext.journalPath) {
      process.stdout.write(`  Journal:     ${activeContext.journalPath}\n`);
    }
    if (agentId) {
      process.stdout.write(`  Agent:       ${agentId}\n`);
    }

    // Show review notes if any
    if (activeContext.reviewNotes && activeContext.reviewNotes.length > 0) {
      process.stdout.write(`\n  Review Notes:\n`);
      for (const note of activeContext.reviewNotes) {
        process.stdout.write(`    - ${note}\n`);
      }
    }

    // Show description snippet if available
    if (task) {
      const desc = getString(task, "description", "");
      if (desc) {
        const lines = desc.split("\n").slice(0, 3);
        process.stdout.write(`\n  Description:\n`);
        for (const line of lines) {
          process.stdout.write(`    ${line}\n`);
        }
        if (desc.split("\n").length > 3) {
          process.stdout.write(`    ...\n`);
        }
      }

      // Show cost if available
      const costObj = asRecord(task["cost"]);
      if (costObj) {
        const allocated = asNumber(costObj["allocated"]);
        const consumed = asNumber(costObj["consumed"]);
        if (allocated !== null) {
          const remaining = (allocated ?? 0) - (consumed ?? 0);
          process.stdout.write(`\n  Budget: ${formatMoney(consumed)} / ${formatMoney(allocated)} (${formatMoney(remaining)} remaining)\n`);
        }
      }
    }

    // Phase-specific guidance
    if (!terminal) {
      const guidance = phaseGuidance(phase, condition);
      process.stdout.write("\n");
      for (const line of guidance) {
        process.stdout.write(`  ${line}\n`);
      }
    } else {
      process.stdout.write(`\n  Task is terminal (${terminal}). No active work.\n`);
      process.stdout.write(`  Run: task release   # to clear active context\n`);
    }

    process.stdout.write("\n");
    return;
  }

  // --- No active task: show available work ---
  const role = agentId ? agentRole(agentId) : null;

  let tasks: Record<string, unknown>[] = [];
  try {
    const body = await apiRequest("GET", "/tasks?full=true");
    tasks = asArray<unknown>(body["tasks"])
      .map((t) => toTaskListEntry(t))
      .filter((t): t is Record<string, unknown> => t !== null);
  } catch (err) {
    if (jsonMode) {
      process.stdout.write(JSON.stringify({ mode: "idle", error: String(err) }, null, 2) + "\n");
    } else {
      process.stdout.write(`\n  No active task.${agentId ? ` (agent: ${agentId})` : ""}\n`);
      process.stdout.write(`  Cannot reach daemon: ${String(err)}\n\n`);
    }
    return;
  }

  // Filter to claimable tasks (*.ready, not terminal)
  const claimable = tasks
    .filter((t) => {
      const terminal = getString(t, "terminal", "");
      if (terminal) return false;
      const condition = getString(t, "condition", "");
      return condition === "ready";
    })
    .filter((t) => {
      // If agent has a role, prefer tasks assigned to that role (but show all)
      return true;
    })
    .sort((a, b) => {
      const metaA = asRecord(a["metadata"]) ?? {};
      const metaB = asRecord(b["metadata"]) ?? {};
      // Tasks assigned to my role come first
      if (role) {
        const aMatch = getString(metaA, "assignee") === role ? 0 : 1;
        const bMatch = getString(metaB, "assignee") === role ? 0 : 1;
        if (aMatch !== bMatch) return aMatch - bMatch;
      }
      // Then by priority
      const pa = priorityRank(getString(metaA, "priority", "medium"));
      const pb = priorityRank(getString(metaB, "priority", "medium"));
      if (pa !== pb) return pa - pb;
      return getNumber(b, "updatedAt") - getNumber(a, "updatedAt");
    });

  if (jsonMode) {
    process.stdout.write(JSON.stringify({
      mode: "idle",
      agentId: agentId || null,
      role: role || null,
      available: claimable.length,
      tasks: claimable.slice(0, 10),
    }, null, 2) + "\n");
    return;
  }

  process.stdout.write(`\n  No active task.${agentId ? ` (agent: ${agentId})` : ""}\n`);

  if (claimable.length === 0) {
    process.stdout.write("  No tasks available to claim.\n\n");
    return;
  }

  // Show up to 10 claimable tasks
  const shown = claimable.slice(0, 10);
  process.stdout.write(`\n  Available tasks (${claimable.length} total):\n\n`);

  const rows: string[][] = [];
  for (const t of shown) {
    const id = getString(t, "id");
    const title = getString(t, "title", "(untitled)");
    const phase = getString(t, "phase", "?");
    const meta = asRecord(t["metadata"]) ?? {};
    const priority = getString(meta, "priority", "medium");
    const assignee = getString(meta, "assignee", "");
    const roleTag = role && assignee === role ? " *" : "";
    rows.push([`  T${id}`, `[${priority}]`, `${phase}`, `${title}${roleTag}`]);
  }
  printTable(rows);

  if (claimable.length > 10) {
    process.stdout.write(`  ... and ${claimable.length - 10} more\n`);
  }

  process.stdout.write(`\n  Claim a task:  task claim <id>\n\n`);
}

function printHelp(): void {
  const text = [
    "task CLI",
    "",
    "Usage:",
    "  task list [filters]",
    "  task show <id> [--events] [--children] [--deps]",
    "  task events <id> [--last N]",
    "  task attention [--format telegram]",
    "  task create <title> --description <desc> [options]",
    "  task claim <id>",
    "  task release [--reason <reason>] [--worked]",
    "  task extend [--duration 15m|30m|1h]",
    "  task submit <evidence>",
    "  task complete <evidence>",
    "  task block <reason>",
    "  task cost <amount>",
    "  task update <message>",
    "  task analyze",
    "  task decide <execute|decompose>",
    "  task decompose <start|add|commit|cancel> ...",
    "  task review <read|note|approve|reject|request-changes> ...",
    "  task journal <read|write|write-file> ...",
    "  task worktree",
    "  task revive <id> [--reason <reason>]",
    "  task cancel <id> [--reason <reason>]",
    "  task budget <id> [--cost N] [--attempts phase:max,...]",
    "  task metadata <id> <key> <value>",
    "  task reparent <id> --parent <parent-id>",
    "  task incident <summary> --severity <...> --category <...>",
    "",
    "Global:",
    "  --json   Print raw JSON response when available",
  ].join("\n");
  process.stdout.write(text + "\n");
}

function ensureText(input: string | undefined, name: string): string {
  if (!input || !input.trim()) {
    throw new CliError(`${name} is required.`, 1);
  }
  return input.trim();
}

async function getTask(taskId: string): Promise<Record<string, unknown>> {
  const body = await apiRequest("GET", `/tasks/${normalizeTaskId(taskId)}`);
  const task = asRecord(body["task"]);
  if (!task) throw new CliError(`Malformed task response for ${taskId}.`, 2);
  return task;
}

async function getTaskEvents(taskId: string): Promise<Record<string, unknown>[]> {
  const body = await apiRequest("GET", `/tasks/${normalizeTaskId(taskId)}/events`);
  return asArray<unknown>(body["events"])
    .map((event) => asRecord(event))
    .filter((event): event is Record<string, unknown> => event !== null);
}

function printTaskOverview(task: Record<string, unknown>, includeDeps: boolean, childRows: Array<Record<string, unknown>>): void {
  const id = getString(task, "id");
  const title = getString(task, "title", "(untitled)");
  const phase = getString(task, "phase", "terminal");
  const condition = getString(task, "condition", getString(task, "terminal", "unknown"));
  const priority = getString(asRecord(task["metadata"]) ?? {}, "priority", "medium");
  const assignee = getString(asRecord(task["metadata"]) ?? {}, "assignee", "-");
  const reviewer = getString(asRecord(task["metadata"]) ?? {}, "reviewer", "-");

  process.stdout.write(`--- T${id}: ${title} ---\n`);
  process.stdout.write(`Priority:    ${priority}\n`);
  process.stdout.write(`Phase:       ${phase}\n`);
  process.stdout.write(`Condition:   ${condition}\n`);
  process.stdout.write(`Assignee:    ${assignee || "-"}\n`);
  process.stdout.write(`Reviewer:    ${reviewer || "-"}\n`);

  const parentId = asString(task["parentId"]);
  if (parentId) {
    process.stdout.write(`Parent:      T${parentId}\n`);
  }

  process.stdout.write(`\nCreated:     ${formatIso(task["createdAt"])}\n`);
  process.stdout.write(`Updated:     ${formatIso(task["updatedAt"])}\n`);

  process.stdout.write("\n## Description\n");
  process.stdout.write(getString(task, "description", "(none)") + "\n");

  const attemptsObj = asRecord(task["attempts"]);
  if (attemptsObj) {
    process.stdout.write("\n## Attempts\n");
    for (const phaseKey of ["analysis", "decomposition", "execution", "review"]) {
      const phaseAttempts = asRecord(attemptsObj[phaseKey]);
      if (!phaseAttempts) continue;
      const used = getNumber(phaseAttempts, "used", 0);
      const max = getNumber(phaseAttempts, "max", 0);
      process.stdout.write(`  ${phaseKey.padEnd(12)} ${used}/${max} used\n`);
    }
  }

  const costObj = asRecord(task["cost"]);
  if (costObj) {
    const allocated = asNumber(costObj["allocated"]);
    const consumed = asNumber(costObj["consumed"]);
    const childAllocated = asNumber(costObj["childAllocated"]);
    const childRecovered = asNumber(costObj["childRecovered"]);
    const remaining = (allocated ?? 0) - (consumed ?? 0) - (childAllocated ?? 0) + (childRecovered ?? 0);

    process.stdout.write("\n## Cost\n");
    process.stdout.write(`  Allocated: ${formatMoney(allocated)}\n`);
    process.stdout.write(`  Consumed:  ${formatMoney(consumed)}\n`);
    process.stdout.write(`  Remaining: ${formatMoney(remaining)}\n`);
  }

  const failures = asArray<unknown>(task["failureSummaries"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (failures.length > 0) {
    process.stdout.write("\n## Previous Failures\n");
    failures.forEach((failure, idx) => {
      const whatFailed = getString(failure, "whatFailed", "(unknown)");
      const learned = getString(failure, "whatWasLearned", "");
      process.stdout.write(`  - Attempt ${idx + 1}: ${whatFailed}\n`);
      if (learned) process.stdout.write(`    Learned: ${learned}\n`);
    });
  }

  const reviewState = asRecord(task["reviewState"]);
  const verdicts = asArray<unknown>(reviewState?.["verdicts"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (verdicts.length > 0) {
    process.stdout.write("\n## Review Feedback\n");
    for (const verdict of verdicts) {
      const round = getNumber(verdict, "round", 0);
      const reviewerId = getString(verdict, "reviewer", "reviewer");
      const value = getString(verdict, "verdict", "unknown");
      const reasoning = getString(verdict, "reasoning", "");
      process.stdout.write(`  Round ${round} (${reviewerId}): ${value}\n`);
      if (reasoning) process.stdout.write(`  \"${reasoning}\"\n`);
    }
  }

  if (includeDeps) {
    const deps = asArray<unknown>(task["dependencies"])
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    process.stdout.write("\n## Dependencies\n");
    if (deps.length === 0) {
      process.stdout.write("  (none)\n");
    } else {
      for (const dep of deps) {
        const target = getString(dep, "target", "?");
        const status = getString(dep, "status", "unknown");
        process.stdout.write(`  T${target} (${status})\n`);
      }
    }
  }

  process.stdout.write("\n## Children\n");
  if (childRows.length === 0) {
    process.stdout.write("  (none)\n");
  } else {
    let doneCount = 0;
    const problemCounts: Record<string, number> = {};
    for (const child of childRows) {
      const cid = getString(child, "id");
      const ctitle = getString(child, "title", "(untitled)");
      const cphase = getString(child, "phase", "terminal");
      const ccondition = getString(child, "condition", getString(child, "terminal", "unknown"));
      process.stdout.write(`  T${cid} ${ctitle} [${cphase}.${ccondition}]\n`);

      const ct = getString(child, "terminal", "");
      if (ct === "done") { doneCount++; }
      else if (ct) { problemCounts[ct] = (problemCounts[ct] ?? 0) + 1; }
      else if (ccondition) { problemCounts[ccondition] = (problemCounts[ccondition] ?? 0) + 1; }
    }

    const parts = [`${doneCount}/${childRows.length} done`];
    for (const [key, count] of Object.entries(problemCounts).sort((a, b) => b[1] - a[1])) {
      parts.push(`${count} ${key}`);
    }
    process.stdout.write(`\n  Summary: ${parts.join(", ")}\n`);
  }
}

async function cmdList(argv: string[], jsonMode: boolean): Promise<void> {
  const { flags } = parseFlags(argv);
  const body = await apiRequest("GET", "/tasks?full=true");
  const tasks = asArray<unknown>(body["tasks"])
    .map((task) => toTaskListEntry(task))
    .filter((task): task is Record<string, unknown> => task !== null);

  const phaseFilter = getFlagString(flags, "phase");
  const conditionFilter = getFlagString(flags, "condition");
  const terminalFilter = getFlagString(flags, "terminal");
  const assigneeFilter = getFlagString(flags, "assignee");
  const priorityFilter = getFlagString(flags, "priority");
  const parentFilter = getFlagString(flags, "parent");
  const mine = getFlagBool(flags, "mine");
  const DEFAULT_LIMIT = 100;
  const limitRaw = getFlagString(flags, "limit");
  const limit = limitRaw ? Number.parseInt(limitRaw, 10) : DEFAULT_LIMIT;

  const myAgent = resolveAgentId();

  const filtered = tasks
    .filter((task) => {
      const metadata = asRecord(task["metadata"]) ?? {};
      if (phaseFilter && getString(task, "phase") !== phaseFilter) return false;
      if (conditionFilter && getString(task, "condition") !== conditionFilter) return false;
      if (terminalFilter && getString(task, "terminal") !== terminalFilter) return false;
      if (!terminalFilter && getString(task, "terminal")) return false;
      if (assigneeFilter && getString(metadata, "assignee") !== assigneeFilter) return false;
      if (priorityFilter && getString(metadata, "priority", "medium") !== priorityFilter) return false;
      if (parentFilter && getString(task, "parentId") !== normalizeTaskId(parentFilter)) return false;
      if (mine && myAgent && getString(metadata, "assignee") !== agentRole(myAgent)) return false;
      return true;
    })
    .sort((a, b) => {
      const pa = priorityRank(getString(asRecord(a["metadata"]) ?? {}, "priority", "medium"));
      const pb = priorityRank(getString(asRecord(b["metadata"]) ?? {}, "priority", "medium"));
      if (pa !== pb) return pa - pb;
      return getNumber(b, "updatedAt") - getNumber(a, "updatedAt");
    });

  const shown = Number.isInteger(limit) && (limit ?? 0) > 0
    ? filtered.slice(0, limit ?? 0)
    : filtered;

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ total: filtered.length, shown: shown.length, tasks: shown }, null, 2) + "\n");
    return;
  }

  const wide = getFlagBool(flags, "wide");
  const extraFields = getFlagList(flags, "fields");

  // Build parent→children index for the waiting field
  const childrenByParent = new Map<string, Record<string, unknown>[]>();
  for (const task of tasks) {
    const pid = asString(task["parentId"]);
    if (pid) {
      let list = childrenByParent.get(pid);
      if (!list) { list = []; childrenByParent.set(pid, list); }
      list.push(task);
    }
  }

  function waitingSummary(task: Record<string, unknown>): string {
    const condition = getString(task, "condition", getString(task, "terminal", ""));
    if (condition !== "waiting") return "-";
    const id = getString(task, "id");
    const children = childrenByParent.get(id);
    if (!children || children.length === 0) return "waiting (no children)";
    let done = 0;
    const problems: Record<string, number> = {};
    for (const child of children) {
      const ct = getString(child, "terminal", "");
      if (ct === "done") { done++; continue; }
      if (ct) { problems[ct] = (problems[ct] ?? 0) + 1; continue; }
      const cc = getString(child, "condition", "");
      if (cc) problems[cc] = (problems[cc] ?? 0) + 1;
    }
    const parts = [`${done}/${children.length} done`];
    for (const [key, count] of Object.entries(problems).sort((a, b) => b[1] - a[1])) {
      parts.push(`${count} ${key}`);
    }
    return parts.join(", ");
  }

  type Column = { header: string; extract: (task: Record<string, unknown>, meta: Record<string, unknown>) => string };
  const availableExtras: Record<string, Column> = {
    reviewer:  { header: "Reviewer",  extract: (_t, m) => getString(m, "reviewer", "-") },
    consulted: { header: "Consulted", extract: (_t, m) => getString(m, "consulted", "-") },
    informed:  { header: "Informed",  extract: (_t, m) => {
      const v = m["informed"];
      if (Array.isArray(v)) return v.join(",") || "-";
      return getString(m, "informed", "-");
    }},
    parent:    { header: "Parent",    extract: (t, _m) => { const p = asString(t["parentId"]); return p ? `T${p}` : "-"; } },
    cost:      { header: "Cost",      extract: (t, _m) => {
      const c = asRecord(t["cost"]);
      if (!c) return "-";
      const consumed = asNumber(c["consumed"]);
      const allocated = asNumber(c["allocated"]);
      return consumed !== null && allocated !== null ? `${formatMoney(consumed)}/${formatMoney(allocated)}` : "-";
    }},
    updated:   { header: "Updated",   extract: (t, _m) => {
      const ts = asNumber(t["updatedAt"]);
      if (ts === null) return "-";
      return new Date(ts).toISOString().slice(0, 10);
    }},
    waiting:   { header: "Waiting On", extract: (t, _m) => waitingSummary(t) },
  };

  const extras: Column[] = [];
  if (wide) {
    extras.push(availableExtras["reviewer"]!, availableExtras["consulted"]!, availableExtras["parent"]!);
  }
  for (const name of extraFields) {
    const col = availableExtras[name];
    if (!col) {
      const valid = Object.keys(availableExtras).join(", ");
      throw new CliError(`Unknown field '${name}'. Available: ${valid}`, 1);
    }
    if (!extras.includes(col)) extras.push(col);
  }

  const headerRow = ["ID", "Priority", "Phase", "Condition", "Assignee", ...extras.map((c) => c.header), "Title"];
  const rows: string[][] = [headerRow];
  for (const task of shown) {
    const metadata = asRecord(task["metadata"]) ?? {};
    rows.push([
      `T${getString(task, "id")}`,
      getString(metadata, "priority", "medium"),
      getString(task, "phase", "terminal"),
      getString(task, "condition", getString(task, "terminal", "unknown")),
      getString(metadata, "assignee", "-"),
      ...extras.map((c) => c.extract(task, metadata)),
      getString(task, "title", "(untitled)"),
    ]);
  }

  printTable(rows);
  if (shown.length < filtered.length) {
    process.stdout.write(`\nShowing top ${shown.length} of ${filtered.length} tasks (capped at ${limit}). Use --limit to change.\n`);
  } else {
    process.stdout.write(`\nShowing ${shown.length} tasks\n`);
  }
  process.stdout.write("Hint: run `task show <id>` for full details.\n");
}

async function cmdShow(argv: string[], jsonMode: boolean): Promise<void> {
  const { positionals, flags } = parseFlags(argv);
  const taskId = normalizeTaskId(ensureText(positionals[0], "task id"));
  const task = await getTask(taskId);

  const includeEvents = getFlagBool(flags, "events");
  const includeChildren = getFlagBool(flags, "children");
  const includeDeps = getFlagBool(flags, "deps");

  const children: Record<string, unknown>[] = [];
  if (includeChildren) {
    const childrenBody = await apiRequest("GET", `/tasks?parentId=${encodeURIComponent(taskId)}&full=true`);
    for (const entry of asArray<unknown>(childrenBody["tasks"])) {
      const child = asRecord(entry);
      if (child) children.push(child);
    }
  }

  const events = includeEvents ? await getTaskEvents(taskId) : [];

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ task, children, events }, null, 2) + "\n");
    return;
  }

  printTaskOverview(task, includeDeps, children);

  if (includeEvents) {
    process.stdout.write("\n## Events\n");
    for (const event of events) {
      const ts = getNumber(event, "ts");
      const type = getString(event, "type", "unknown");
      process.stdout.write(`  ${formatIso(ts)}  ${type}\n`);
    }
  }
}

async function cmdEvents(argv: string[], jsonMode: boolean): Promise<void> {
  const { positionals, flags } = parseFlags(argv);
  const taskId = normalizeTaskId(ensureText(positionals[0], "task id"));
  const events = await getTaskEvents(taskId);

  const lastRaw = getFlagString(flags, "last");
  const lastN = lastRaw ? Number.parseInt(lastRaw, 10) : null;
  const shown = Number.isInteger(lastN) && (lastN ?? 0) > 0
    ? events.slice(Math.max(0, events.length - (lastN ?? 0)))
    : events;

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ taskId, events: shown }, null, 2) + "\n");
    return;
  }

  for (const event of shown) {
    const ts = formatIso(event["ts"]);
    const type = getString(event, "type", "unknown");
    process.stdout.write(`[${ts}] ${type}\n`);
  }
}

async function cmdAttention(argv: string[], jsonMode: boolean): Promise<void> {
  const { flags } = parseFlags(argv);
  const format = getFlagString(flags, "format");

  if (format === "telegram") {
    const body = await apiRequest("GET", "/attention/telegram");
    if (jsonMode) {
      process.stdout.write(JSON.stringify(body, null, 2) + "\n");
      return;
    }
    process.stdout.write((asString(body["text"]) ?? "") + "\n");
    return;
  }

  const body = await apiRequest("GET", "/attention");
  if (jsonMode) {
    process.stdout.write(JSON.stringify(body, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Blocked:   ${String(body["blocked"] ?? 0)}\n`);
  process.stdout.write(`Failed:    ${String(body["failed"] ?? 0)}\n`);
  process.stdout.write(`Stalled:   ${String(body["stalled"] ?? 0)}\n`);
  process.stdout.write(`Exhausted: ${String(body["exhausted"] ?? 0)}\n`);

  const tasksObj = asRecord(body["tasks"]);
  if (!tasksObj) return;

  for (const key of ["blocked", "failed", "stalled", "exhausted"]) {
    const list = asArray<unknown>(tasksObj[key])
      .map((entry) => asRecord(entry))
      .filter((entry): entry is Record<string, unknown> => entry !== null);
    if (list.length === 0) continue;

    process.stdout.write(`\n${key.toUpperCase()}:\n`);
    for (const task of list) {
      process.stdout.write(`  T${getString(task, "id")} [${getString(task, "priority", "medium")}] ${getString(task, "title")}\n`);
    }
  }
}

function parseDependsOn(flags: Record<string, FlagValue>): string[] {
  return getFlagList(flags, "depends-on").map((id) => normalizeTaskId(id));
}

async function cmdCreate(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();

  const { positionals, flags } = parseFlags(argv);
  const title = ensureText(positionals[0], "title");
  const description = ensureText(getFlagString(flags, "description"), "--description");

  const body: Record<string, unknown> = {
    title,
    description,
  };

  const assignee = getFlagString(flags, "assignee");
  const reviewer = getFlagString(flags, "reviewer");
  const consulted = getFlagString(flags, "consulted");
  const priority = getFlagString(flags, "priority");
  const informed = getFlagList(flags, "informed");
  const dependsOn = parseDependsOn(flags);
  const repo = getFlagString(flags, "repo");
  const baseBranch = getFlagString(flags, "base-branch");

  if (assignee) body["assignee"] = assignee;
  if (reviewer) body["reviewer"] = reviewer;
  if (consulted) body["consulted"] = consulted;
  if (priority) body["priority"] = priority;
  if (informed.length > 0) body["informed"] = informed;
  if (dependsOn.length > 0) body["dependsOn"] = dependsOn;
  if (repo) body["repo"] = repo;
  if (baseBranch) body["baseBranch"] = baseBranch;

  const response = await apiRequest("POST", "/tasks", body);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  const taskId = getString(response, "taskId", "?");
  process.stdout.write(`Created T${taskId}: ${title}\n`);
  process.stdout.write(`Phase: ${getString(response, "phase", "analysis")}, Condition: ${getString(response, "condition", "ready")}\n`);
  if (assignee) process.stdout.write(`Dispatcher will auto-assign to ${assignee}.\n`);
  if (dependsOn.length > 0) process.stdout.write(`Waiting on ${dependsOn.map((id) => `T${id}`).join(", ")} before starting.\n`);
  process.stdout.write(`Hint: task show ${taskId}\n`);
  if (dependsOn.length === 0) {
    process.stdout.write(`Depends on other tasks? Run: task metadata ${taskId} depends-on <task-ids>\n`);
  }
}

async function cmdClaim(argv: string[], jsonMode: boolean): Promise<void> {
  const agentId = requireAgentId();
  const { positionals, flags } = parseFlags(argv);
  const taskId = normalizeTaskId(ensureText(positionals[0], "task id"));
  const force = getFlagBool(flags, "force");

  const response = await apiRequest("POST", `/tasks/${taskId}/claim`, {
    agentId,
    source: "task-cli",
    force,
  });

  const task = asRecord(response["task"]);
  if (!task) throw new CliError("Malformed claim response: missing task payload.", 2);

  const workspace = asRecord(response["workspace"]);
  const journalWorktree = asString(workspace?.["journalWorktree"]);
  const journalPath = asString(workspace?.["journalPath"]);
  const codeWorktree = asString(workspace?.["codeWorktree"]);

  const sessionId = ensureText(asString(response["sessionId"]) ?? "", "sessionId");
  const fenceToken = asNumber(response["fenceToken"]);
  if (fenceToken === null) throw new CliError("Malformed claim response: missing fenceToken.", 2);

  const context: TaskContext = {
    taskId,
    phase: asString(task["phase"]),
    fenceToken,
    sessionId,
    journalPath: journalPath ?? "",
    codeWorktree: codeWorktree ?? null,
    claimedAt: Date.now(),
    reviewNotes: [],
  };

  const roots: string[] = [];
  if (journalWorktree) roots.push(journalWorktree);
  if (codeWorktree) roots.push(codeWorktree);
  if (roots.length > 0 && journalPath) {
    writeTaskContext(context, roots);
  }

  // Write global active task file
  writeActiveTask(agentId, context);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  process.stdout.write(`--- Claimed T${taskId}: ${getString(task, "title", "(untitled)")} ---\n`);
  const leaseTimeout = asNumber(response["leaseTimeout"]);
  if (leaseTimeout !== null) {
    process.stdout.write(`Lease: ${Math.round(leaseTimeout / 60000)} min (extend with \`task extend\`)\n`);
  }
  process.stdout.write(`Fence: ${fenceToken}\n`);

  const desc = getString(task, "description", "(none)");
  const descLines = desc.split("\n");
  process.stdout.write("\n## Description\n");
  if (descLines.length > 5) {
    process.stdout.write(descLines.slice(0, 5).join("\n") + "\n");
    process.stdout.write(`  ... (${descLines.length - 5} more lines — \`task show ${taskId}\` for full)\n`);
  } else {
    process.stdout.write(desc + "\n");
  }

  process.stdout.write("\n## Your Workspace\n");
  if (journalPath) process.stdout.write(`  Journal: ${journalPath}\n`);
  if (codeWorktree) {
    process.stdout.write(`  Code:    ${codeWorktree}\n\n`);
    process.stdout.write(`  cd ${codeWorktree}\n`);
  } else if (journalWorktree) {
    process.stdout.write(`\n  cd ${journalWorktree}\n`);
  }

  const failures = asArray<unknown>(task["failureSummaries"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (failures.length > 0) {
    process.stdout.write(`\n## Previous Attempts (${failures.length} failed)\n`);
    failures.forEach((failure, idx) => {
      process.stdout.write(`  - Attempt ${idx + 1}: ${getString(failure, "whatFailed", "(unknown)")}\n`);
      const learned = getString(failure, "whatWasLearned", "");
      if (learned) process.stdout.write(`    Learned: ${learned}\n`);
    });
  }

  const reviewState = asRecord(task["reviewState"]);
  const verdicts = asArray<unknown>(reviewState?.["verdicts"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (verdicts.length > 0) {
    process.stdout.write("\n## Review Feedback\n");
    for (const verdict of verdicts) {
      process.stdout.write(`  Round ${getNumber(verdict, "round", 0)} (${getString(verdict, "reviewer", "reviewer")}): ${getString(verdict, "verdict", "unknown")}\n`);
      const reasoning = getString(verdict, "reasoning", "");
      if (reasoning) process.stdout.write(`  \"${reasoning}\"\n`);
    }
  }

  const parentJournal = asString(response["parentJournal"]);
  if (parentJournal) {
    const pLines = parentJournal.split("\n").filter((l) => l.trim().length > 0);
    process.stdout.write("\n## Parent Context\n");
    process.stdout.write("  " + pLines.slice(0, 2).join("\n  ") + "\n");
    if (pLines.length > 2) {
      process.stdout.write(`  ... (${pLines.length - 2} more lines in journal)\n`);
    }
  }

  const siblingFailures = asArray<unknown>(response["siblingFailures"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (siblingFailures.length > 0) {
    process.stdout.write(`\n## Sibling Failures (${siblingFailures.length})\n`);
    for (const sibling of siblingFailures.slice(0, 5)) {
      const raw = getString(sibling, "summary", "") || getString(sibling, "content", "");
      const oneLine = raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("_Recorded")).join(" — ").slice(0, 120);
      process.stdout.write(`  T${getString(sibling, "taskId", "?")}: ${oneLine}\n`);
    }
    if (siblingFailures.length > 5) {
      process.stdout.write(`  ... and ${siblingFailures.length - 5} more\n`);
    }
  }

  process.stdout.write("\n## Next Steps\n");
  process.stdout.write("  task submit \"what you did\"   — when done\n");
  process.stdout.write("  task block \"what's wrong\"    — if stuck\n");
  process.stdout.write("  task show                    — full task details\n");
  process.stdout.write("  task extend                  — extend lease\n");
}

function sourceFor(agentId: string): Record<string, string> {
  return { type: "agent", id: agentId };
}

async function cmdRelease(argv: string[], jsonMode: boolean): Promise<void> {
  const agentId = requireAgentId();
  const { flags } = parseFlags(argv);
  const taskId = currentTaskId();
  const task = await getTask(taskId);

  const fenceToken = getNumber(task, "currentFenceToken", -1);
  const phase = getString(task, "phase", "execution");
  if (fenceToken < 0) throw new CliError(`Task ${taskId} has no active lease to release.`, 1);

  const reason = getFlagString(flags, "reason") ?? "Released by task CLI";
  const worked = getFlagBool(flags, "worked");

  const payload = {
    type: "LeaseReleased",
    taskId,
    ts: Date.now(),
    fenceToken,
    reason,
    phase,
    workPerformed: worked,
    source: sourceFor(agentId),
  };

  const response = await apiRequest("POST", `/tasks/${taskId}/events`, payload);
  clearActiveTask(agentId);
  clearTaskContextFile();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Released T${taskId}.\n`);
}

async function cmdExtend(argv: string[], jsonMode: boolean): Promise<void> {
  const agentId = requireAgentId();
  const { flags } = parseFlags(argv);
  const taskId = currentTaskId();
  const task = await getTask(taskId);

  const fenceToken = getNumber(task, "currentFenceToken", -1);
  if (fenceToken < 0) throw new CliError(`Task ${taskId} has no active lease to extend.`, 1);

  const duration = parseDurationMs(getFlagString(flags, "duration"), 15 * 60_000);

  const payload = {
    type: "LeaseExtended",
    taskId,
    ts: Date.now(),
    fenceToken,
    leaseTimeout: duration,
    source: sourceFor(agentId),
  };

  const response = await apiRequest("POST", `/tasks/${taskId}/events`, payload);

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Extended lease for T${taskId} by ${Math.round(duration / 60000)} min.\n`);
}

async function cmdSubmit(argv: string[], jsonMode: boolean): Promise<void> {
  const agentId = requireAgentId();
  const evidence = ensureText(argv.join(" "), "evidence");
  const taskId = currentTaskId();

  let response: Record<string, unknown>;
  try {
    response = await apiRequest("POST", `/tasks/${taskId}/status`, {
      status: "review",
      evidence,
    });
  } catch (err) {
    if (handleLeaseExpiryError(err, taskId, "submit")) process.exit(1);
    throw err;
  }

  clearActiveTask(agentId);
  clearTaskContextFile();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Submitted T${taskId} for review.\n`);
  process.stdout.write("Your work will be reviewed.\n");
}

async function cmdComplete(argv: string[], jsonMode: boolean): Promise<void> {
  const agentId = requireAgentId();
  const evidence = ensureText(argv.join(" "), "evidence");
  const taskId = currentTaskId();

  let response: Record<string, unknown>;
  try {
    response = await apiRequest("POST", `/tasks/${taskId}/status`, {
      status: "done",
      evidence,
    });
  } catch (err) {
    if (handleLeaseExpiryError(err, taskId, "complete")) process.exit(1);
    throw err;
  }

  clearActiveTask(agentId);
  clearTaskContextFile();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Completed T${taskId}.\n`);
}

async function cmdBlock(argv: string[], jsonMode: boolean): Promise<void> {
  const agentId = requireAgentId();
  const reason = ensureText(argv.join(" "), "reason");
  const taskId = currentTaskId();

  let response: Record<string, unknown>;
  try {
    response = await apiRequest("POST", `/tasks/${taskId}/status`, {
      status: "blocked",
      blocker: reason,
    });
  } catch (err) {
    if (handleLeaseExpiryError(err, taskId, "block")) process.exit(1);
    throw err;
  }

  clearActiveTask(agentId);
  clearTaskContextFile();

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Blocked T${taskId}.\n`);
}

async function cmdCost(argv: string[], jsonMode: boolean): Promise<void> {
  const agentId = requireAgentId();
  const amountRaw = argv[0];
  const amount = amountRaw ? Number(amountRaw) : NaN;
  if (!Number.isFinite(amount) || amount < 0) {
    throw new CliError("Amount must be a non-negative number.", 1);
  }

  const taskId = currentTaskId();
  const task = await getTask(taskId);
  const fenceToken = getNumber(task, "currentFenceToken", -1);
  if (fenceToken < 0) throw new CliError(`Task ${taskId} has no active lease token.`, 1);

  const response = await apiRequest("POST", `/tasks/${taskId}/events`, {
    type: "CostReported",
    taskId,
    ts: Date.now(),
    fenceToken,
    reportedCost: amount,
    source: sourceFor(agentId),
  });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Reported ${formatMoney(amount)} for T${taskId}.\n`);
}

async function cmdUpdate(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const message = ensureText(argv.join(" "), "message");
  const taskId = currentTaskId();

  const journalRes = await apiRequest("POST", `/tasks/${taskId}/journal`, { entry: message });
  const metadataRes = await apiRequest("PATCH", `/tasks/${taskId}/metadata`, {
    last_update: message,
    last_update_at: new Date().toISOString(),
    reason: "progress update via task CLI",
  });

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ journal: journalRes, metadata: metadataRes }, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Recorded progress update for T${taskId}.\n`);
}

async function cmdAnalyze(jsonMode: boolean): Promise<void> {
  const taskId = currentTaskId();
  const task = await getTask(taskId);

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ task }, null, 2) + "\n");
    return;
  }

  process.stdout.write(`--- Analysis: T${taskId} — ${getString(task, "title", "(untitled)")} ---\n\n`);
  process.stdout.write("## Task Description\n");
  process.stdout.write(getString(task, "description", "(none)") + "\n");

  const failures = asArray<unknown>(task["failureSummaries"])
    .map((entry) => asRecord(entry))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  if (failures.length > 0) {
    process.stdout.write(`\n## Previous Approaches (${failures.length} failed)\n`);
    failures.forEach((failure, idx) => {
      process.stdout.write(`  v${idx + 1}: ${getString(failure, "whatFailed", "(unknown)")}\n`);
    });
  }

  process.stdout.write("\n## Considerations\n");
  process.stdout.write("  - Is this simple enough for a single agent?\n");
  process.stdout.write("  - Should it be decomposed into subtasks?\n");
  process.stdout.write("  - Is it blocked or missing information?\n");

  process.stdout.write("\n## Your Decision\n");
  process.stdout.write("  task decide execute\n");
  process.stdout.write("  task decide decompose\n");
  process.stdout.write("  task block \"reason\"\n");
}

async function cmdDecide(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const { positionals, flags } = parseFlags(argv);
  const decision = positionals[0]?.trim();
  if (decision !== "execute" && decision !== "decompose") {
    throw new CliError("Usage: task decide <execute|decompose> [--force]", 1);
  }

  const force = getFlagBool(flags, "force");
  const taskId = currentTaskId();

  if (!force) {
    const journal = await apiRequest("GET", `/tasks/${taskId}/journal`);
    const content = typeof journal["content"] === "string" ? journal["content"].trim() : "";
    if (content.length === 0) {
      throw new CliError(
        "Cannot proceed: no analysis found. Submit your analysis first:\n  task journal \"your analysis here\"\n\nUse --force to bypass this check.",
        1,
      );
    }
  }

  const status = decision === "execute" ? "execute" : "decompose";
  const response = await apiRequest("POST", `/tasks/${taskId}/status`, { status });

  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  if (decision === "execute") {
    process.stdout.write(`Decision recorded: T${taskId} will execute directly.\n`);
  } else {
    process.stdout.write(`Decision recorded: T${taskId} will be decomposed.\n`);
  }
}

function parseSiblingDeps(raw: string[]): number[] {
  const indices = raw.map((value) => Number.parseInt(value, 10));
  for (const idx of indices) {
    if (!Number.isInteger(idx) || idx < 0) {
      throw new CliError("--depends-on must contain non-negative sibling indices.", 1);
    }
  }
  return indices;
}

async function cmdDecompose(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const sub = argv[0];
  const args = argv.slice(1);
  const taskId = currentTaskId();

  switch (sub) {
    case "start": {
      const task = await getTask(taskId);
      const response = await apiRequest("POST", `/tasks/${taskId}/decompose/start`, {});
      if (jsonMode) {
        process.stdout.write(JSON.stringify({ task, ...response }, null, 2) + "\n");
        return;
      }

      process.stdout.write(`--- Decomposition: T${taskId} — ${getString(task, "title", "(untitled)")} ---\n\n`);
      process.stdout.write("## Task Description\n");
      process.stdout.write(getString(task, "description", "(none)") + "\n");

      process.stdout.write("\n## Budget\n");
      process.stdout.write(`  Remaining: ${formatMoney(response["budgetRemaining"])}\n`);
      process.stdout.write("  You must allocate cost to each child from this budget.\n");

      const approaches = asArray<unknown>(task["approachHistory"])
        .map((entry) => asRecord(entry))
        .filter((entry): entry is Record<string, unknown> => entry !== null);
      process.stdout.write("\n## Previous Decompositions\n");
      if (approaches.length === 0) {
        process.stdout.write("  (none — first attempt)\n");
      } else {
        for (const approach of approaches) {
          process.stdout.write(
            `  v${String(approach["version"] ?? "?")}: ${getString(approach, "description", "decomposition")} — ${getString(approach, "outcome", "unknown")}\n`,
          );
          const failureSummary = getString(approach, "failureSummary", "");
          if (failureSummary) {
            process.stdout.write(`    Failed: ${failureSummary}\n`);
          }
        }
      }

      process.stdout.write("\n## Guidelines\n");
      process.stdout.write("  - Each child should be completable by one agent in one session\n");
      process.stdout.write("  - Children should be as independent as possible\n");
      process.stdout.write("  - Use --depends-on when order matters (0-indexed sibling position)\n");
      process.stdout.write("  - Leave assignee blank unless a specific agent is needed\n");

      process.stdout.write("\n## Next Step\n");
      process.stdout.write("  Add your first child:\n\n");
      process.stdout.write("  task decompose add \"Child title\" \\\n");
      process.stdout.write("    --desc \"What this child should do\" \\\n");
      process.stdout.write("    --cost 10\n");
      return;
    }

    case "add": {
      const { positionals, flags } = parseFlags(args);
      const title = ensureText(positionals[0], "child title");
      const desc = ensureText(getFlagString(flags, "desc"), "--desc");
      const costRaw = getFlagString(flags, "cost");
      const cost = costRaw ? Number(costRaw) : NaN;
      if (!Number.isFinite(cost) || cost <= 0) {
        throw new CliError("--cost must be a positive number.", 1);
      }

      const depends = parseSiblingDeps(getFlagList(flags, "depends-on"));

      const body: Record<string, unknown> = {
        title,
        description: desc,
        costAllocation: cost,
      };

      const assignee = getFlagString(flags, "assignee");
      const reviewer = getFlagString(flags, "reviewer");
      if (assignee) body["assignee"] = assignee;
      if (reviewer) body["reviewer"] = reviewer;
      if (depends.length > 0) body["dependsOnSiblings"] = depends;
      if (getFlagBool(flags, "skip-analysis")) body["skipAnalysis"] = true;

      const response = await apiRequest("POST", `/tasks/${taskId}/decompose/add-child`, body);

      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }

      process.stdout.write(`--- Child #${String(response["childIndex"] ?? "?")} added ---\n`);
      process.stdout.write(`  Title: ${title}\n`);
      process.stdout.write(`  Cost:  ${formatMoney(cost)}\n`);
      process.stdout.write(`\nBudget remaining: ${formatMoney(response["budgetRemaining"])}\n`);
      process.stdout.write("\nNext:\n");
      process.stdout.write("  task decompose add \"Next title\" --desc \"...\" --cost N\n");
      process.stdout.write("  task decompose checkpoint 0,2     — mark checkpoints (optional)\n");
      process.stdout.write("  task decompose commit \"Strategy description\"\n");
      return;
    }

    case "checkpoint": {
      const raw = args.join(",").split(",").map((s) => s.trim()).filter(Boolean);
      if (raw.length === 0 || (raw.length === 1 && raw[0] === "none")) {
        const response = await apiRequest("POST", `/tasks/${taskId}/decompose/checkpoint`, { indices: [] });
        if (jsonMode) { process.stdout.write(JSON.stringify(response, null, 2) + "\n"); return; }
        process.stdout.write("Checkpoints cleared.\n");
        return;
      }

      let indices: number[];
      if (raw.length === 1 && raw[0] === "all") {
        // Will be resolved server-side; fetch children count first
        const response = await apiRequest("POST", `/tasks/${taskId}/decompose/checkpoint`, { indices: [] });
        const children = asArray<unknown>(response["children"]);
        indices = children.map((_, i) => i);
      } else {
        indices = raw.map((s) => {
          const n = Number.parseInt(s, 10);
          if (!Number.isInteger(n) || n < 0) throw new CliError(`Invalid child index: '${s}'`, 1);
          return n;
        });
      }

      const response = await apiRequest("POST", `/tasks/${taskId}/decompose/checkpoint`, { indices });
      if (jsonMode) { process.stdout.write(JSON.stringify(response, null, 2) + "\n"); return; }

      const children = asArray<unknown>(response["children"])
        .map((c) => asRecord(c))
        .filter((c): c is Record<string, unknown> => c !== null);
      process.stdout.write("--- Checkpoint selection ---\n");
      for (const child of children) {
        const marker = child["isCheckpoint"] ? " ★" : "";
        process.stdout.write(`  #${String(child["index"])}: ${getString(child, "title", "(untitled)")}${marker}\n`);
      }
      process.stdout.write(`\n★ = checkpoint (wakes parent for re-analysis on completion)\n`);
      process.stdout.write("\nNext:\n");
      process.stdout.write("  task decompose commit \"Strategy description\"\n");
      return;
    }

    case "commit": {
      const strategy = ensureText(args.join(" "), "strategy description");
      const response = await apiRequest("POST", `/tasks/${taskId}/decompose/commit`, { approach: strategy });

      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }

      process.stdout.write("--- Decomposition committed ---\n\n");
      process.stdout.write(`Strategy: ${strategy}\n\n`);
      const children = asArray<unknown>(response["children"])
        .map((child) => asRecord(child))
        .filter((child): child is Record<string, unknown> => child !== null);
      process.stdout.write(`Created ${children.length} children:\n`);
      for (const child of children) {
        process.stdout.write(`  T${getString(child, "id", "?")}: ${getString(child, "title", "(untitled)")}  ${formatMoney(child["costAllocation"])}\n`);
      }
      return;
    }

    case "cancel": {
      const response = await apiRequest("POST", `/tasks/${taskId}/decompose/cancel`, {});
      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write(`Canceled pending decomposition session for T${taskId}.\n`);
      return;
    }

    default:
      throw new CliError("Usage: task decompose <start|add|checkpoint|commit|cancel> ...", 1);
  }
}

function ensureContextWithTaskId(taskId: string): TaskContext {
  const info = readTaskContext();
  if (!info.context || normalizeTaskId(info.context.taskId) !== normalizeTaskId(taskId)) {
    return {
      taskId,
      phase: null,
      fenceToken: 0,
      sessionId: "",
      journalPath: "",
      codeWorktree: null,
      claimedAt: Date.now(),
      reviewNotes: [],
    };
  }
  return info.context;
}

function persistReviewNotes(taskId: string, notes: string[]): void {
  const { context, filePath } = readTaskContext();
  if (!context || !filePath || normalizeTaskId(context.taskId) !== normalizeTaskId(taskId)) return;
  context.reviewNotes = notes;
  fs.writeFileSync(filePath, JSON.stringify(context, null, 2) + "\n", "utf-8");
}

function getReviewEvidence(taskId: string, explicit: string | null): string {
  if (explicit && explicit.trim()) return explicit.trim();
  const context = ensureContextWithTaskId(taskId);
  const notes = context.reviewNotes ?? [];
  if (notes.length === 0) return "Review completed.";
  return notes.map((note, idx) => `${idx + 1}. ${note}`).join("\n");
}

async function cmdReview(argv: string[], jsonMode: boolean): Promise<void> {
  const agentId = requireAgentId();

  const sub = argv[0];
  const args = argv.slice(1);

  // "list" doesn't require an active task
  if (sub === "list") {
    const { flags } = parseFlags(args);
    const mine = getFlagBool(flags, "mine");
    const body = await apiRequest("GET", "/tasks?full=true");
    const tasks = asArray<unknown>(body["tasks"])
      .map((t) => asRecord(t))
      .filter((t): t is Record<string, unknown> => t !== null)
      .filter((t) => {
        if (getString(t, "terminal")) return false;
        if (getString(t, "phase") !== "review") return false;
        if (getString(t, "condition") !== "ready") return false;
        if (mine) {
          const meta = asRecord(t["metadata"]) ?? {};
          const reviewer = getString(meta, "reviewer");
          if (reviewer && reviewer !== agentRole(agentId) && reviewer !== agentId) return false;
        }
        return true;
      })
      .sort((a, b) => getNumber(a, "updatedAt") - getNumber(b, "updatedAt"));

    if (jsonMode) {
      process.stdout.write(JSON.stringify({ count: tasks.length, tasks: tasks.map((t) => ({
        id: getString(t, "id"), title: getString(t, "title"),
        reviewer: getString(asRecord(t["metadata"]) ?? {}, "reviewer", "-"),
        updatedAt: getString(t, "updatedAt"),
      }))}, null, 2) + "\n");
      return;
    }

    if (tasks.length === 0) {
      process.stdout.write("No tasks waiting for review.\n");
      return;
    }

    process.stdout.write(`${tasks.length} tasks waiting for review:\n\n`);
    for (const t of tasks) {
      const tid = getString(t, "id");
      const title = getString(t, "title", "(untitled)");
      const meta = asRecord(t["metadata"]) ?? {};
      const reviewer = getString(meta, "reviewer", "-");
      const updatedAt = getNumber(t, "updatedAt");
      const ago = updatedAt > 0 ? formatDuration(Date.now() - updatedAt) : "?";
      process.stdout.write(`  T${tid}  ${title}\n`);
      process.stdout.write(`         reviewer: ${reviewer}  waiting: ${ago}\n`);
    }
    process.stdout.write("\nTo review: task claim <id>, then task review read/approve/reject\n");
    return;
  }

  const taskId = currentTaskId();

  switch (sub) {
    case "read": {
      const response = await apiRequest("GET", `/tasks/${taskId}/review/context`);
      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write(getString(response, "text", "No review context available.") + "\n");
      return;
    }

    case "note": {
      const note = ensureText(args.join(" "), "note");
      const response = await apiRequest("POST", `/tasks/${taskId}/review/note`, { note });

      const notes = asArray<unknown>(response["notes"]).map((entry) => asString(entry)).filter((entry): entry is string => entry !== null);
      persistReviewNotes(taskId, notes);

      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }

      process.stdout.write(`--- Note recorded (${notes.length} total) ---\n\n`);
      process.stdout.write("Your notes so far:\n");
      notes.forEach((entry, idx) => process.stdout.write(`  ${idx + 1}. ${entry}\n`));
      process.stdout.write("\n  task review note \"Another observation\"\n");
      process.stdout.write("  task review approve \"Summary\"\n");
      process.stdout.write("  task review reject \"Reason\"\n");
      process.stdout.write("  task review request-changes \"Feedback\"\n");
      return;
    }

    case "approve": {
      const evidence = getReviewEvidence(taskId, args.join(" "));
      const response = await apiRequest("POST", `/tasks/${taskId}/status`, {
        status: "done",
        evidence,
      });
      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write(`Approved T${taskId}.\n`);
      return;
    }

    case "reject": {
      const evidence = getReviewEvidence(taskId, args.join(" "));
      const response = await apiRequest("POST", `/tasks/${taskId}/status`, {
        status: "reject",
        evidence,
      });
      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write(`Rejected T${taskId}.\n`);
      return;
    }

    case "request-changes": {
      const evidence = getReviewEvidence(taskId, args.join(" "));
      const response = await apiRequest("POST", `/tasks/${taskId}/status`, {
        status: "pending",
        evidence,
      });
      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write("--- Changes requested ---\n\n");
      process.stdout.write(`T${taskId} returns to execution.\n`);
      process.stdout.write(`Feedback: \"${evidence}\"\n`);
      return;
    }

    default:
      throw new CliError("Usage: task review <list|read|note|approve|reject|request-changes> ...", 1);
  }
}

async function cmdJournal(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const sub = argv[0];
  const args = argv.slice(1);
  const taskId = currentTaskId();

  switch (sub) {
    case "read": {
      const response = await apiRequest("GET", `/tasks/${taskId}/journal`);
      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write(getString(response, "content", "") + "\n");
      return;
    }

    case "write": {
      const entry = ensureText(args.join(" "), "journal entry");
      const response = await apiRequest("POST", `/tasks/${taskId}/journal`, { entry });
      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write(`Journal updated for T${taskId}.\n`);
      return;
    }

    case "write-file": {
      const fileName = ensureText(args[0], "file name");
      const content = ensureText(args.slice(1).join(" "), "file content");
      const response = await apiRequest("POST", `/tasks/${taskId}/journal/file`, {
        name: fileName,
        content,
      });
      if (jsonMode) {
        process.stdout.write(JSON.stringify(response, null, 2) + "\n");
        return;
      }
      process.stdout.write(`Wrote ${fileName} to journal for T${taskId}.\n`);
      return;
    }

    default:
      throw new CliError("Usage: task journal <read|write|write-file> ...", 1);
  }
}

function taskFromContextOrFail(): TaskContext {
  const { context } = readTaskContext();
  if (!context) throw new CliError("No .task context found in current directory tree.", 1);
  return context;
}

function cmdWorktree(): void {
  const context = taskFromContextOrFail();
  process.stdout.write(`Journal: ${context.journalPath}\n`);
  process.stdout.write(`Code:    ${context.codeWorktree ?? "(none)"}\n`);
}

async function cmdRevive(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const { positionals, flags } = parseFlags(argv);
  const taskId = normalizeTaskId(ensureText(positionals[0], "task id"));
  const reason = getFlagString(flags, "reason") ?? "New approach available";

  const response = await apiRequest("POST", `/tasks/${taskId}/revive`, { reason });
  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }
  process.stdout.write(`Revived T${taskId}.\n`);
}

async function cmdCancel(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const { positionals, flags } = parseFlags(argv);
  const taskId = normalizeTaskId(ensureText(positionals[0], "task id"));
  const reason = getFlagString(flags, "reason") ?? "No longer needed";

  const response = await apiRequest("POST", `/tasks/${taskId}/status`, { status: "cancel", evidence: reason });
  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }
  process.stdout.write(`Canceled T${taskId}.\n`);
}

function parseAttemptBudget(raw: string[]): Record<string, { max: number }> {
  const out: Record<string, { max: number }> = {};
  for (const entry of raw) {
    const [phase, maxRaw] = entry.split(":");
    const max = Number.parseInt(maxRaw ?? "", 10);
    if (!phase || !Number.isInteger(max) || max <= 0) {
      throw new CliError(`Invalid attempt budget '${entry}'. Use phase:max (e.g. execution:4).`, 1);
    }
    out[phase] = { max };
  }
  return out;
}

async function cmdBudget(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const { positionals, flags } = parseFlags(argv);
  const taskId = normalizeTaskId(ensureText(positionals[0], "task id"));

  const costRaw = getFlagString(flags, "cost");
  const attemptsRaw = getFlagList(flags, "attempts");

  const body: Record<string, unknown> = {
    reason: "budget updated via task CLI",
  };

  if (costRaw) {
    const cost = Number(costRaw);
    if (!Number.isFinite(cost) || cost <= 0) {
      throw new CliError("--cost must be a positive number.", 1);
    }
    body["costBudgetIncrease"] = cost;
  }

  if (attemptsRaw.length > 0) {
    body["attemptBudgetIncrease"] = parseAttemptBudget(attemptsRaw);
  }

  if (body["costBudgetIncrease"] === undefined && body["attemptBudgetIncrease"] === undefined) {
    throw new CliError("Provide at least one of --cost or --attempts.", 1);
  }

  const response = await apiRequest("POST", `/tasks/${taskId}/budget`, body);
  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Updated budget for T${taskId}.\n`);
}

function parseMetadataValue(raw: string): unknown {
  if (raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  const n = Number(raw);
  if (Number.isFinite(n) && raw.trim() !== "") return n;
  if (raw.includes(",")) {
    return raw.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return raw;
}

async function cmdMetadata(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const taskId = normalizeTaskId(ensureText(argv[0], "task id"));
  const rest = argv.slice(1);

  if (rest.length === 0) {
    throw new CliError("Usage: task metadata <id> key=value [key2=value2 ...]\n       task metadata <id> <key> <value>", 1);
  }

  const patch: Record<string, unknown> = {};

  // Check if using key=value format (any arg contains '=')
  const hasKvp = rest.some((arg) => arg.includes("="));
  if (hasKvp) {
    for (const arg of rest) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx < 1) throw new CliError(`Invalid key=value pair: '${arg}'. Format: key=value`, 1);
      const key = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      patch[key] = parseMetadataValue(value);
    }
  } else {
    // Legacy 3-arg form: task metadata <id> <key> <value>
    const key = ensureText(rest[0], "metadata key");
    const value = ensureText(rest.slice(1).join(" "), "metadata value");
    patch[key] = parseMetadataValue(value);
  }

  patch["reason"] = "metadata updated via task CLI";

  const response = await apiRequest("PATCH", `/tasks/${taskId}/metadata`, patch);
  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }
  const keys = Object.keys(patch).filter((k) => k !== "reason");
  process.stdout.write(`Updated metadata for T${taskId}: ${keys.join(", ")}\n`);
}

async function cmdReparent(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const { positionals, flags } = parseFlags(argv);
  const taskId = normalizeTaskId(ensureText(positionals[0], "task id"));
  const parent = normalizeTaskId(ensureText(getFlagString(flags, "parent"), "--parent"));

  const response = await apiRequest("POST", `/tasks/${taskId}/reparent`, { newParentId: parent });
  if (jsonMode) {
    process.stdout.write(JSON.stringify(response, null, 2) + "\n");
    return;
  }
  process.stdout.write(`Reparented T${taskId} under T${parent}.\n`);
}

async function cmdIncident(argv: string[], jsonMode: boolean): Promise<void> {
  requireAgentId();
  const { positionals, flags } = parseFlags(argv);
  const summary = ensureText(positionals.join(" "), "summary");
  const severity = ensureText(getFlagString(flags, "severity"), "--severity");
  const category = ensureText(getFlagString(flags, "category"), "--category");
  const detail = getFlagString(flags, "detail");
  const tags = getFlagList(flags, "tags");

  const workspaceDir = process.env["WORKSPACE_DIR"]
    ?? process.env["OPENCLAW_STATE_DIR"]
    ?? path.join(os.homedir(), ".openclaw", "workspace");

  const incidentDir = path.join(workspaceDir, "data", "incidents");
  fs.mkdirSync(incidentDir, { recursive: true });

  const incidentId = `INC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const incident = {
    id: incidentId,
    ts: new Date().toISOString(),
    severity,
    category,
    summary,
    detail: detail ?? null,
    tags,
    source: "task-cli",
  };

  const date = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(incidentDir, `${date}.jsonl`), JSON.stringify(incident) + "\n", "utf-8");

  if (jsonMode) {
    process.stdout.write(JSON.stringify({ incident_id: incidentId, status: "recorded" }, null, 2) + "\n");
    return;
  }
  process.stdout.write(`Incident recorded: ${incidentId}\n`);
}

const subcommandHelp: Record<string, string> = {
  list: [
    "task list [filters]",
    "",
    "List non-terminal tasks, sorted by priority then recency.",
    "Default limit: 100. Use --limit to change.",
    "",
    "Filters:",
    "  --phase <phase>        Filter by phase (analysis, execution, review, ...)",
    "  --condition <cond>     Filter by condition (ready, active, exhausted, ...)",
    "  --terminal <term>      Show terminal tasks (done, failed, cancelled)",
    "  --assignee <agent>     Filter by assignee",
    "  --priority <level>     Filter by priority (critical, high, medium, low, backlog)",
    "  --parent <id>          Filter by parent task",
    "  --mine                 Show only tasks assigned to TASKCORE_AGENT_ID",
    "  --limit <N>            Max tasks to show (default: 100)",
    "",
    "Display:",
    "  --wide                 Show extra columns (reviewer, consulted, parent)",
    "  --fields <f1,f2,...>   Add specific columns. Available fields:",
    "                           reviewer, consulted, informed, parent, cost, updated, waiting",
  ].join("\n"),

  show: [
    "task show <id> [options]",
    "",
    "Show full details for a task.",
    "",
    "Options:",
    "  --events     Include event history",
    "  --children   Include child tasks",
    "  --deps       Include dependency info",
  ].join("\n"),

  events: [
    "task events <id> [--last N]",
    "",
    "Show event history for a task.",
    "",
    "Options:",
    "  --last <N>   Show only the last N events",
  ].join("\n"),

  attention: [
    "task attention [--format telegram]",
    "",
    "Show tasks needing attention (blocked, failed, stalled, exhausted).",
    "",
    "Options:",
    "  --format telegram   Output as Telegram-formatted text",
  ].join("\n"),

  create: [
    "task create <title> --description <desc> [options]",
    "",
    "Create a new task. Requires TASKCORE_AGENT_ID.",
    "",
    "Options:",
    "  --description <text>   Task description (required)",
    "  --assignee <agent>     Assign to a specific agent",
    "  --reviewer <agent>     Set reviewer",
    "  --consulted <agent>    Set consulted agent",
    "  --priority <level>     Priority (critical, high, medium, low, backlog)",
    "  --informed <ids>       Comma-separated list of agents to notify",
    "  --depends-on <ids>     Comma-separated task IDs this depends on",
    "  --repo <repo>          Repository for this task",
    "  --base-branch <branch> Base branch for code worktree",
  ].join("\n"),

  claim: [
    "task claim <id>",
    "",
    "Claim a task and receive workspace info. Requires TASKCORE_AGENT_ID.",
    "Writes a .task context file to the worktree root.",
  ].join("\n"),

  release: [
    "task release [--reason <reason>] [--worked]",
    "",
    "Release the current task's lease. Requires TASKCORE_AGENT_ID.",
    "",
    "Options:",
    "  --reason <text>   Why the lease is being released",
    "  --worked          Indicate that useful work was performed",
  ].join("\n"),

  extend: [
    "task extend [--duration 15m|30m|1h]",
    "",
    "Extend the lease on the current task. Requires TASKCORE_AGENT_ID.",
    "",
    "Options:",
    "  --duration <dur>   Lease extension (default: 15m). Formats: 10m, 30m, 1h",
  ].join("\n"),

  submit: [
    "task submit <evidence>",
    "",
    "Submit the current task for review. Requires TASKCORE_AGENT_ID.",
    "Evidence describes what was done.",
  ].join("\n"),

  complete: [
    "task complete <evidence>",
    "",
    "Mark the current task as done. Requires TASKCORE_AGENT_ID.",
    "Evidence describes what was accomplished.",
  ].join("\n"),

  block: [
    "task block <reason>",
    "",
    "Mark the current task as blocked. Requires TASKCORE_AGENT_ID.",
    "Reason explains what is preventing progress.",
  ].join("\n"),

  cost: [
    "task cost <amount>",
    "",
    "Report cost consumed on the current task. Requires TASKCORE_AGENT_ID.",
    "Amount is a non-negative number (dollars).",
  ].join("\n"),

  update: [
    "task update <message>",
    "",
    "Record a progress update (journal entry + metadata). Requires TASKCORE_AGENT_ID.",
  ].join("\n"),

  analyze: [
    "task analyze",
    "",
    "Show analysis context for the current task.",
    "Displays description, previous failures, and decision options.",
  ].join("\n"),

  decide: [
    "task decide <execute|decompose>",
    "",
    "Record an analysis decision. Requires TASKCORE_AGENT_ID.",
    "",
    "  execute     Task will be executed directly",
    "  decompose   Task will be split into subtasks",
  ].join("\n"),

  decompose: [
    "task decompose <subcommand> ...",
    "",
    "Manage task decomposition. Requires TASKCORE_AGENT_ID.",
    "",
    "Subcommands:",
    "  start                                Begin a decomposition session",
    "  add <title> --desc <text> --cost <N>  Add a child task",
    "    --assignee <agent>                  Assign child to agent",
    "    --reviewer <agent>                  Set child reviewer",
    "    --depends-on <indices>              Comma-separated 0-based sibling indices",
    "    --skip-analysis                     Skip analysis phase for child",
    "  commit <strategy>                     Commit the decomposition",
    "  cancel                                Cancel pending decomposition",
  ].join("\n"),

  review: [
    "task review <subcommand> ...",
    "",
    "Review workflow for the current task. Requires TASKCORE_AGENT_ID.",
    "",
    "Subcommands:",
    "  read                    Show review context",
    "  note <text>             Add a review note",
    "  approve [summary]       Approve and mark done",
    "  reject [reason]         Reject the submission",
    "  request-changes [text]  Send back for rework",
  ].join("\n"),

  journal: [
    "task journal <subcommand> ...",
    "",
    "Read/write journal entries. Requires TASKCORE_AGENT_ID.",
    "",
    "Subcommands:",
    "  read                      Read the task journal",
    "  write <entry>             Append a journal entry",
    "  write-file <name> <text>  Write a named file to the journal",
  ].join("\n"),

  worktree: [
    "task worktree",
    "",
    "Show journal and code worktree paths from the .task context file.",
  ].join("\n"),

  revive: [
    "task revive <id> [--reason <reason>]",
    "",
    "Revive a failed or blocked task. Requires TASKCORE_AGENT_ID.",
    "",
    "Options:",
    "  --reason <text>   Why the task is being revived",
  ].join("\n"),

  cancel: [
    "task cancel <id> [--reason <reason>]",
    "",
    "Cancel a task. Requires TASKCORE_AGENT_ID.",
    "",
    "Options:",
    "  --reason <text>   Why the task is being cancelled",
  ].join("\n"),

  budget: [
    "task budget <id> [--cost N] [--attempts phase:max,...]",
    "",
    "Increase budget for a task. Requires TASKCORE_AGENT_ID.",
    "Provide at least one of --cost or --attempts.",
    "",
    "Options:",
    "  --cost <N>                  Add dollars to cost budget",
    "  --attempts <phase:max,...>  Increase attempt limits (e.g. execution:4,review:2)",
  ].join("\n"),

  metadata: [
    "task metadata <id> <key> <value>",
    "",
    "Set a metadata field on a task. Requires TASKCORE_AGENT_ID.",
    "Value is auto-parsed: null, true, false, numbers, comma-separated lists.",
  ].join("\n"),

  reparent: [
    "task reparent <id> --parent <parent-id>",
    "",
    "Move a task under a different parent. Requires TASKCORE_AGENT_ID.",
  ].join("\n"),

  incident: [
    "task incident <summary> --severity <sev> --category <cat> [options]",
    "",
    "Record an incident. Requires TASKCORE_AGENT_ID.",
    "",
    "Options:",
    "  --severity <level>   Incident severity (required)",
    "  --category <cat>     Incident category (required)",
    "  --detail <text>      Additional detail",
    "  --tags <t1,t2,...>   Comma-separated tags",
  ].join("\n"),
};

function wantsHelp(argv: string[]): boolean {
  return argv.includes("--help") || argv.includes("-h");
}

function extractJsonFlag(argv: string[]): { jsonMode: boolean; args: string[] } {
  let jsonMode = false;
  const args: string[] = [];

  for (const token of argv) {
    if (token === "--json") {
      jsonMode = true;
      continue;
    }
    args.push(token);
  }

  return { jsonMode, args };
}

async function run(argv: string[]): Promise<void> {
  const { jsonMode, args } = extractJsonFlag(argv);
  const command = args[0];
  const rest = args.slice(1);

  if (!command) {
    await cmdHome(jsonMode);
    return;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  const help = subcommandHelp[command];
  if (help && wantsHelp(rest)) {
    process.stdout.write(help + "\n");
    return;
  }

  switch (command) {
    case "list":
      await cmdList(rest, jsonMode);
      return;
    case "show":
      await cmdShow(rest, jsonMode);
      return;
    case "events":
      await cmdEvents(rest, jsonMode);
      return;
    case "attention":
      await cmdAttention(rest, jsonMode);
      return;
    case "create":
      await cmdCreate(rest, jsonMode);
      return;
    case "claim":
      await cmdClaim(rest, jsonMode);
      return;
    case "release":
      await cmdRelease(rest, jsonMode);
      return;
    case "extend":
      await cmdExtend(rest, jsonMode);
      return;
    case "submit":
      await cmdSubmit(rest, jsonMode);
      return;
    case "complete":
      await cmdComplete(rest, jsonMode);
      return;
    case "block":
      await cmdBlock(rest, jsonMode);
      return;
    case "cost":
      await cmdCost(rest, jsonMode);
      return;
    case "update":
      await cmdUpdate(rest, jsonMode);
      return;
    case "analyze":
      await cmdAnalyze(jsonMode);
      return;
    case "decide":
      await cmdDecide(rest, jsonMode);
      return;
    case "decompose":
      await cmdDecompose(rest, jsonMode);
      return;
    case "review":
      await cmdReview(rest, jsonMode);
      return;
    case "journal":
      await cmdJournal(rest, jsonMode);
      return;
    case "worktree":
      cmdWorktree();
      return;
    case "revive":
      await cmdRevive(rest, jsonMode);
      return;
    case "cancel":
      await cmdCancel(rest, jsonMode);
      return;
    case "budget":
      await cmdBudget(rest, jsonMode);
      return;
    case "metadata":
      await cmdMetadata(rest, jsonMode);
      return;
    case "reparent":
      await cmdReparent(rest, jsonMode);
      return;
    case "incident":
      await cmdIncident(rest, jsonMode);
      return;
    default:
      throw new CliError(`Unknown command: ${command}`, 1);
  }
}

run(process.argv.slice(2)).catch((err: unknown) => {
  if (err instanceof CliError) {
    process.stderr.write(err.message + "\n");
    process.exit(err.code);
    return;
  }

  if (err instanceof ApiError) {
    const body = asRecord(err.body);
    if (body) {
      const errorCode = asString(body["error"]);
      const message = asString(body["message"]);
      if (errorCode) {
        process.stderr.write(`${errorCode}: ${message ?? "API request failed"}\n`);
      } else if (message) {
        process.stderr.write(`${message}\n`);
      } else {
        process.stderr.write(`${JSON.stringify(body)}\n`);
      }
    } else {
      process.stderr.write(String(err.body) + "\n");
    }
    process.exit(2);
    return;
  }

  process.stderr.write(`Unexpected error: ${String(err)}\n`);
  process.exit(1);
});
