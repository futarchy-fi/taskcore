import * as fs from "node:fs";
import * as http from "node:http";
import * as path from "node:path";
import Database from "better-sqlite3";

interface SidecarConfig {
  port: number;
  workspaceDir: string;
  incidentsDbPath: string;
  sessionsDir: string;
  workspaceSessionsDir: string;
  runtimeFile: string;
  modelHealthFile: string;
  telegramDirectoryFile: string;
  telegramAllowlistFile: string;
  telegramPairingFile: string;
}

interface RouteResult {
  status: number;
  body: unknown;
}

interface SessionListItem {
  sessionId: string;
  filePath: string;
  sizeBytes: number;
  modifiedAt: string;
  source: "global" | "workspace";
}

interface SessionAgentGroup {
  agentId: string;
  sessionCount: number;
  sessions: SessionListItem[];
}

interface SessionListResponse {
  agents: SessionAgentGroup[];
}

interface ToolCall {
  name: string;
  arguments: string;
}

interface SessionUsage {
  inputTokens: number;
  outputTokens: number;
  cost: number;
}

interface SessionMessage {
  id: string;
  role: "user" | "assistant" | "tool";
  timestamp: string;
  content: string;
  toolCalls: ToolCall[] | null;
  toolName: string | null;
  usage: SessionUsage | null;
}

interface SessionDetailResponse {
  sessionId: string;
  agentId: string;
  startedAt: string;
  messageCount: number;
  messages: SessionMessage[];
}

interface IncidentFilters {
  severity?: string;
  category?: string;
  since?: string;
  resolved?: boolean;
  limit: number;
}

interface IncidentRow {
  id: string;
  ts: string;
  severity: string;
  category: string;
  source: string | null;
  detection: string | null;
  summary: string;
  detail: string | null;
  context: string | null;
  tags: string | null;
  resolved: number;
  resolved_at: string | null;
  resolved_by: string | null;
}

interface CommsDirectory {
  contacts?: Record<string, ContactRecord>;
  groups?: Record<string, GroupRecord>;
}

interface ContactRecord {
  name?: string;
  fullName?: string;
  username?: string;
  role?: string;
  relation?: string;
  notes?: string;
}

interface GroupRecord {
  name?: string;
  type?: string;
}

interface TelegramAllowlist {
  allowFrom?: string[];
}

interface PairingRequest {
  id?: string | number;
  code?: string;
  createdAt?: string;
  meta?: {
    username?: string;
    firstName?: string;
    lastName?: string;
  };
}

interface TelegramPairing {
  requests?: PairingRequest[];
}

interface SessionIndexEntry {
  chatType?: string;
  groupId?: string;
  subject?: string;
  displayName?: string;
  updatedAt?: number;
  origin?: {
    chatType?: string;
    accountId?: string;
    to?: string;
  };
}

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

const SESSION_LIST_TTL_MS = 30_000;
const INCIDENT_STATS_TTL_MS = 60_000;
const COMMS_TTL_MS = 30_000;
const MAX_SESSIONS_PER_AGENT = 100;

const cache = new Map<string, CacheEntry>();

const startedAtMs = Date.now();
const config = loadConfig();

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function loadConfig(): SidecarConfig {
  const home = process.env["HOME"] ?? "/home/ubuntu";
  const workspaceDir =
    process.env["WORKSPACE_DIR"] ??
    process.env["OPENCLAW_STATE_DIR"] ??
    `${home}/.openclaw/workspace`;

  return {
    port: envInt("DASHBOARD_API_PORT", 18801),
    workspaceDir,
    incidentsDbPath:
      process.env["INCIDENTS_DB"] ?? `${workspaceDir}/data/incidents/incidents.db`,
    sessionsDir: process.env["SESSIONS_DIR"] ?? `${home}/.openclaw/agents`,
    workspaceSessionsDir:
      process.env["WORKSPACE_SESSIONS_DIR"] ?? `${workspaceDir}/agents`,
    runtimeFile:
      process.env["RUNTIME_FILE"] ?? `${workspaceDir}/data/task-dashboard/executor_runtime.json`,
    modelHealthFile:
      process.env["MODEL_HEALTH_FILE"] ?? `${workspaceDir}/data/task-dashboard/model_health.json`,
    telegramDirectoryFile:
      process.env["TELEGRAM_DIRECTORY"] ?? `${workspaceDir}/data/telegram-directory.json`,
    telegramAllowlistFile:
      process.env["TELEGRAM_ALLOWLIST"] ?? `${workspaceDir}/credentials/telegram-allowFrom.json`,
    telegramPairingFile:
      process.env["TELEGRAM_PAIRING"] ?? `${workspaceDir}/credentials/telegram-pairing.json`,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

function toNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function safeIsoTimestamp(value: unknown): string {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) {
      return new Date(numeric).toISOString();
    }
    const parsed = Date.parse(value);
    if (!Number.isNaN(parsed)) {
      return new Date(parsed).toISOString();
    }
  }
  return "";
}

function parseJSONFile<T>(filePath: string): T | null {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const raw = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

function withCache<T>(key: string, ttlMs: number, compute: () => T): T {
  const now = Date.now();
  const existing = cache.get(key);
  if (existing && existing.expiresAt > now) {
    return existing.data as T;
  }
  const fresh = compute();
  cache.set(key, { data: fresh, expiresAt: now + ttlMs });
  return fresh;
}

function parseRequestUrl(rawUrl: string): URL {
  return new URL(rawUrl, "http://127.0.0.1");
}

function parseBooleanQuery(value: string | null): boolean | undefined {
  if (value === null) return undefined;
  if (value === "true") return true;
  if (value === "false") return false;
  return undefined;
}

function parseLimit(value: string | null, fallback: number, max: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function parseOffset(value: string | null, fallback: number): number {
  if (value === null) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return parsed;
}

function isSafePathSegment(value: string): boolean {
  return !value.includes("/") && !value.includes("\\") && !value.includes("..") && !value.includes("\0");
}

function listAgentIds(sessionRoot: string): string[] {
  try {
    const dirs = fs.readdirSync(sessionRoot, { withFileTypes: true });
    const agents: string[] = [];
    for (const entry of dirs) {
      if (!entry.isDirectory()) continue;
      const sessionsPath = path.join(sessionRoot, entry.name, "sessions");
      if (fs.existsSync(sessionsPath) && fs.statSync(sessionsPath).isDirectory()) {
        agents.push(entry.name);
      }
    }
    return agents;
  } catch {
    return [];
  }
}

function listAgentSessions(
  sessionRoot: string,
  agentId: string,
  source: "global" | "workspace",
): SessionListItem[] {
  const sessionsDir = path.join(sessionRoot, agentId, "sessions");
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const out: SessionListItem[] = [];
  for (const file of files) {
    if (!file.isFile()) continue;
    if (!file.name.endsWith(".jsonl")) continue;
    if (file.name === "sessions.json") continue;

    const filePath = path.join(sessionsDir, file.name);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      continue;
    }

    out.push({
      sessionId: file.name.replace(/\.jsonl$/, ""),
      filePath,
      sizeBytes: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      source,
    });
  }

  return out;
}

function buildSessionList(agentFilter?: string): SessionListResponse {
  const roots: Array<{ root: string; source: "global" | "workspace" }> = [
    { root: config.sessionsDir, source: "global" },
    { root: config.workspaceSessionsDir, source: "workspace" },
  ];

  const allAgents = new Set<string>();
  for (const root of roots) {
    for (const agent of listAgentIds(root.root)) {
      allAgents.add(agent);
    }
  }

  const selectedAgents = Array.from(allAgents).sort();
  const filteredAgents =
    agentFilter && agentFilter.trim().length > 0
      ? selectedAgents.filter((agent) => agent === agentFilter)
      : selectedAgents;

  const responseAgents: SessionAgentGroup[] = [];

  for (const agentId of filteredAgents) {
    const merged: SessionListItem[] = [];

    for (const root of roots) {
      merged.push(...listAgentSessions(root.root, agentId, root.source));
    }

    merged.sort((a, b) => Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt));
    const limited = merged.slice(0, MAX_SESSIONS_PER_AGENT);

    responseAgents.push({
      agentId,
      sessionCount: limited.length,
      sessions: limited,
    });
  }

  return { agents: responseAgents };
}

function findSessionFile(agentId: string, sessionIdRaw: string): string | null {
  const normalized = sessionIdRaw.endsWith(".jsonl")
    ? sessionIdRaw.slice(0, -6)
    : sessionIdRaw;

  if (!isSafePathSegment(agentId) || !isSafePathSegment(normalized)) {
    return null;
  }

  const roots = [config.sessionsDir, config.workspaceSessionsDir];
  for (const root of roots) {
    const candidate = path.join(root, agentId, "sessions", `${normalized}.jsonl`);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
      return candidate;
    }
  }

  return null;
}

function stringifyToolArguments(value: unknown): string {
  try {
    return JSON.stringify(value ?? {});
  } catch {
    return "{}";
  }
}

function extractUsage(rawUsage: unknown): SessionUsage | null {
  const usage = asRecord(rawUsage);
  if (!usage) return null;

  const costRaw = usage["cost"];
  let cost = 0;
  if (typeof costRaw === "number") {
    cost = costRaw;
  } else {
    const costObj = asRecord(costRaw);
    if (costObj) {
      cost = toNumber(costObj["total"], 0);
    }
  }

  return {
    inputTokens: toNumber(usage["input"], 0),
    outputTokens: toNumber(usage["output"], 0),
    cost,
  };
}

function parseSessionFile(
  filePath: string,
  agentId: string,
  sessionId: string,
  offset: number,
  limit: number,
): SessionDetailResponse {
  const raw = fs.readFileSync(filePath, "utf-8");
  const lines = raw.split("\n");

  let startedAt = "";
  let messageCount = 0;
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;

    let record: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line);
      const asObj = asRecord(parsed);
      if (!asObj) continue;
      record = asObj;
    } catch {
      continue;
    }

    const type = record["type"];
    if (type === "session") {
      startedAt = safeIsoTimestamp(record["timestamp"]);
      continue;
    }

    if (type !== "message") {
      continue;
    }

    const msg = asRecord(record["message"]);
    if (!msg) {
      continue;
    }

    const roleRaw = typeof msg["role"] === "string" ? msg["role"] : "assistant";

    messageCount += 1;
    if (messageCount <= offset) {
      continue;
    }
    if (messages.length >= limit) {
      continue;
    }

    const contentBlocks = Array.isArray(msg["content"])
      ? (msg["content"] as unknown[])
      : [];

    let content = "";
    const toolCalls: ToolCall[] = [];
    let toolName: string | null = null;

    for (const block of contentBlocks) {
      const blockObj = asRecord(block);
      if (!blockObj) continue;
      const blockType = blockObj["type"];

      if (blockType === "text") {
        const text = blockObj["text"];
        if (typeof text === "string") {
          content += text;
        }
        continue;
      }

      if (blockType === "thinking") {
        continue;
      }

      if (blockType === "toolCall") {
        const name =
          typeof blockObj["name"] === "string" && blockObj["name"].length > 0
            ? blockObj["name"]
            : "unknown";
        toolCalls.push({
          name,
          arguments: stringifyToolArguments(blockObj["arguments"]),
        });
        continue;
      }

      if (blockType === "toolResult") {
        if (typeof blockObj["name"] === "string") {
          toolName = blockObj["name"];
        }
        if (typeof blockObj["text"] === "string") {
          content += blockObj["text"];
        }
      }
    }

    if (roleRaw === "toolResult") {
      const explicitToolName = msg["toolName"];
      if (typeof explicitToolName === "string" && explicitToolName.length > 0) {
        toolName = explicitToolName;
      }

      if (!content) {
        const details = asRecord(msg["details"]);
        if (details && typeof details["aggregated"] === "string") {
          content = details["aggregated"];
        }
      }
    }

    const timestamp =
      safeIsoTimestamp(record["timestamp"]) || safeIsoTimestamp(msg["timestamp"]);

    messages.push({
      id:
        typeof record["id"] === "string" && record["id"].length > 0
          ? record["id"]
          : `msg-${messageCount}`,
      role: roleRaw === "toolResult" ? "tool" : (roleRaw as "user" | "assistant"),
      timestamp,
      content,
      toolCalls: toolCalls.length > 0 ? toolCalls : null,
      toolName,
      usage: extractUsage(msg["usage"]),
    });
  }

  return {
    sessionId,
    agentId,
    startedAt,
    messageCount,
    messages,
  };
}

function openIncidentsDb(): Database.Database | null {
  if (!fs.existsSync(config.incidentsDbPath)) {
    return null;
  }
  try {
    return new Database(config.incidentsDbPath, {
      readonly: true,
      fileMustExist: true,
    });
  } catch {
    return null;
  }
}

function parseJSONField(value: string | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function queryIncidents(db: Database.Database, filters: IncidentFilters): IncidentRow[] {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (filters.severity) {
    conditions.push("severity = ?");
    params.push(filters.severity);
  }
  if (filters.category) {
    conditions.push("category = ?");
    params.push(filters.category);
  }
  if (filters.since) {
    conditions.push("ts >= ?");
    params.push(filters.since);
  }
  if (filters.resolved !== undefined) {
    conditions.push("resolved = ?");
    params.push(filters.resolved ? 1 : 0);
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
  const stmt = db.prepare(
    `SELECT id, ts, severity, category, source, detection, summary, detail,
            context, tags, resolved, resolved_at, resolved_by
     FROM incidents
     ${whereClause}
     ORDER BY ts DESC
     LIMIT ?`,
  );

  return stmt.all(...params, filters.limit) as IncidentRow[];
}

function incidentStats(db: Database.Database, hours: number): {
  by_severity: Record<string, number>;
  by_category: Record<string, number>;
  total: number;
  hours: number;
} {
  const windowExpr = `-${hours} hours`;

  const severityRows = db
    .prepare(
      `SELECT severity, COUNT(*) as count
       FROM incidents
       WHERE ts >= datetime('now', ?)
       GROUP BY severity`,
    )
    .all(windowExpr) as Array<{ severity: string; count: number }>;

  const categoryRows = db
    .prepare(
      `SELECT category, COUNT(*) as count
       FROM incidents
       WHERE ts >= datetime('now', ?)
       GROUP BY category`,
    )
    .all(windowExpr) as Array<{ category: string; count: number }>;

  const totalRow = db
    .prepare(
      `SELECT COUNT(*) as total
       FROM incidents
       WHERE ts >= datetime('now', ?)`,
    )
    .get(windowExpr) as { total: number };

  const bySeverity: Record<string, number> = {
    critical: 0,
    error: 0,
    warning: 0,
    info: 0,
  };
  for (const row of severityRows) {
    bySeverity[row.severity] = row.count;
  }

  const byCategory: Record<string, number> = {};
  for (const row of categoryRows) {
    byCategory[row.category] = row.count;
  }

  return {
    by_severity: bySeverity,
    by_category: byCategory,
    total: totalRow.total,
    hours,
  };
}

function parseUserIdFromSessionKey(key: string, entry: SessionIndexEntry): string {
  const parts = key.split(":");
  const candidate = parts.length > 0 ? parts[parts.length - 1] ?? "" : "";
  if (candidate.length > 0) {
    return candidate;
  }

  const to = entry.origin?.to;
  if (typeof to === "string" && to.startsWith("telegram:")) {
    return to.replace(/^telegram:/, "");
  }

  return "";
}

function loadCommsData(): {
  ok: true;
  dms: Array<{
    userId: string;
    contactName: string;
    username: string;
    role: string;
    relation: string;
    onAllowlist: boolean;
    lastActivity: string | null;
    sessionCount: number;
    pendingPairing: { code: string; createdAt: string } | null;
  }>;
  groups: Array<{
    groupId: string;
    name: string;
    type: string;
  }>;
  allowlist: string[];
  pendingPairings: PairingRequest[];
} {
  const directory = parseJSONFile<CommsDirectory>(config.telegramDirectoryFile);
  const allowlistDoc = parseJSONFile<TelegramAllowlist>(config.telegramAllowlistFile);
  const pairingDoc = parseJSONFile<TelegramPairing>(config.telegramPairingFile);

  const contacts = directory?.contacts ?? {};
  const groupsDirectory = directory?.groups ?? {};
  const allowlist = (allowlistDoc?.allowFrom ?? []).map((id) => String(id));
  const pendingPairings = pairingDoc?.requests ?? [];

  const pendingById = new Map<string, PairingRequest>();
  for (const request of pendingPairings) {
    const id = request.id;
    if (id !== undefined && id !== null) {
      pendingById.set(String(id), request);
    }
  }

  const dmMap = new Map<string, {
    userId: string;
    contactName: string;
    username: string;
    role: string;
    relation: string;
    onAllowlist: boolean;
    lastActivityMs: number;
    sessionCount: number;
    pendingPairing: { code: string; createdAt: string } | null;
  }>();

  const groupMap = new Map<string, { groupId: string; name: string; type: string }>();

  const sessionIndexFiles = [
    ...globSessionIndexFiles(config.sessionsDir),
    ...globSessionIndexFiles(config.workspaceSessionsDir),
  ];

  for (const indexPath of sessionIndexFiles) {
    const indexDoc = parseJSONFile<Record<string, SessionIndexEntry>>(indexPath);
    if (!indexDoc) continue;

    for (const [key, value] of Object.entries(indexDoc)) {
      if (!key.includes("telegram")) continue;
      if (key.startsWith("telegram:slash:")) continue;

      const chatType = value.chatType ?? value.origin?.chatType ?? "";
      const updatedAtMs = toNumber(value.updatedAt, 0);

      if (chatType === "group") {
        const groupId =
          value.groupId ??
          (key.split(":").length > 0 ? key.split(":")[key.split(":").length - 1] ?? "" : "");
        if (!groupId) continue;

        const directoryGroup = groupsDirectory[groupId] ?? {};
        const name =
          directoryGroup.name ?? value.subject ?? value.displayName ?? `group:${groupId}`;
        const type = directoryGroup.type ?? "group";

        groupMap.set(groupId, { groupId, name, type });
        continue;
      }

      const userId = parseUserIdFromSessionKey(key, value);
      if (!userId || userId.startsWith("@")) {
        continue;
      }

      const contact = contacts[userId] ?? {};
      const pending = pendingById.get(userId);
      const pendingPairing = pending
        ? {
            code: pending.code ?? "",
            createdAt: pending.createdAt ?? "",
          }
        : null;

      const existing = dmMap.get(userId);
      if (existing) {
        existing.sessionCount += 1;
        existing.lastActivityMs = Math.max(existing.lastActivityMs, updatedAtMs);
        if (!existing.username && pending?.meta?.username) {
          existing.username = pending.meta.username;
        }
        continue;
      }

      dmMap.set(userId, {
        userId,
        contactName: contact.name ?? "",
        username: contact.username ?? pending?.meta?.username ?? "",
        role: contact.role ?? "",
        relation: contact.relation ?? "",
        onAllowlist: allowlist.includes(userId),
        lastActivityMs: updatedAtMs,
        sessionCount: 1,
        pendingPairing,
      });
    }
  }

  for (const userId of allowlist) {
    if (dmMap.has(userId)) continue;
    const contact = contacts[userId] ?? {};
    const pending = pendingById.get(userId);

    dmMap.set(userId, {
      userId,
      contactName: contact.name ?? "",
      username: contact.username ?? pending?.meta?.username ?? "",
      role: contact.role ?? "",
      relation: contact.relation ?? "",
      onAllowlist: true,
      lastActivityMs: 0,
      sessionCount: 0,
      pendingPairing: pending
        ? {
            code: pending.code ?? "",
            createdAt: pending.createdAt ?? "",
          }
        : null,
    });
  }

  const dms = Array.from(dmMap.values())
    .sort((a, b) => b.lastActivityMs - a.lastActivityMs)
    .map((entry) => ({
      userId: entry.userId,
      contactName: entry.contactName,
      username: entry.username,
      role: entry.role,
      relation: entry.relation,
      onAllowlist: entry.onAllowlist,
      lastActivity: entry.lastActivityMs > 0 ? new Date(entry.lastActivityMs).toISOString() : null,
      sessionCount: entry.sessionCount,
      pendingPairing: entry.pendingPairing,
    }));

  const groups = Array.from(groupMap.values()).sort((a, b) => a.name.localeCompare(b.name));

  return {
    ok: true,
    dms,
    groups,
    allowlist,
    pendingPairings,
  };
}

function globSessionIndexFiles(root: string): string[] {
  try {
    const agentDirs = fs.readdirSync(root, { withFileTypes: true });
    const files: string[] = [];
    for (const agentDir of agentDirs) {
      if (!agentDir.isDirectory()) continue;
      const candidate = path.join(root, agentDir.name, "sessions", "sessions.json");
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        files.push(candidate);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function handleHealth(): RouteResult {
  return {
    status: 200,
    body: {
      status: "ok",
      uptime: (Date.now() - startedAtMs) / 1000,
    },
  };
}

function handleRuntime(): RouteResult {
  const runtime = parseJSONFile<Record<string, unknown>>(config.runtimeFile);
  return {
    status: 200,
    body:
      runtime ?? {
        pid: null,
        startedAt: null,
        activeRuns: [],
        maxConcurrent: 1,
      },
  };
}

function handleSessionsList(url: URL): RouteResult {
  const agentId = url.searchParams.get("agentId") ?? undefined;
  const cacheKey = `sessions:list:${agentId ?? "all"}`;
  const response = withCache(cacheKey, SESSION_LIST_TTL_MS, () => buildSessionList(agentId));
  return { status: 200, body: response };
}

function handleSessionDetail(url: URL, agentId: string, sessionId: string): RouteResult {
  const offset = parseOffset(url.searchParams.get("offset"), 0);
  const limit = parseLimit(url.searchParams.get("limit"), 200, 500);

  const filePath = findSessionFile(agentId, sessionId);
  if (!filePath) {
    return {
      status: 404,
      body: { error: "not_found", message: `Session ${agentId}/${sessionId} not found` },
    };
  }

  try {
    const response = parseSessionFile(filePath, agentId, sessionId, offset, limit);
    return { status: 200, body: response };
  } catch {
    return {
      status: 500,
      body: { error: "session_parse_failed", message: "Failed to parse session file" },
    };
  }
}

function handleIncidents(url: URL): RouteResult {
  const db = openIncidentsDb();
  if (!db) {
    return {
      status: 503,
      body: { error: "database_unavailable", message: "Incidents database not available" },
    };
  }

  try {
    const filters: IncidentFilters = {
      limit: parseLimit(url.searchParams.get("limit"), 50, 200),
    };
    const severity = url.searchParams.get("severity");
    const category = url.searchParams.get("category");
    const since = url.searchParams.get("since");
    const resolved = parseBooleanQuery(url.searchParams.get("resolved"));
    if (severity !== null && severity.length > 0) {
      filters.severity = severity;
    }
    if (category !== null && category.length > 0) {
      filters.category = category;
    }
    if (since !== null && since.length > 0) {
      filters.since = since;
    }
    if (resolved !== undefined) {
      filters.resolved = resolved;
    }

    const rows = queryIncidents(db, filters);
    const incidents = rows.map((row) => ({
      id: row.id,
      ts: row.ts,
      severity: row.severity,
      category: row.category,
      source: row.source,
      detection: row.detection,
      summary: row.summary,
      detail: row.detail,
      context: parseJSONField(row.context),
      tags: parseJSONField(row.tags),
      resolved: Boolean(row.resolved),
      resolved_at: row.resolved_at,
      resolved_by: row.resolved_by,
    }));

    return {
      status: 200,
      body: {
        ok: true,
        incidents,
        count: incidents.length,
      },
    };
  } finally {
    db.close();
  }
}

function handleIncidentStats(url: URL): RouteResult {
  const hours = parseLimit(url.searchParams.get("hours"), 24, 24 * 365);
  const cacheKey = `incidents:stats:${hours}`;

  const payload = withCache(cacheKey, INCIDENT_STATS_TTL_MS, () => {
    const db = openIncidentsDb();
    if (!db) {
      return {
        __error: true as const,
      };
    }

    try {
      const stats = incidentStats(db, hours);
      return {
        __error: false as const,
        stats,
      };
    } finally {
      db.close();
    }
  });

  const typedPayload = payload as
    | { __error: true }
    | { __error: false; stats: ReturnType<typeof incidentStats> };

  if (typedPayload.__error) {
    return {
      status: 503,
      body: { error: "database_unavailable", message: "Incidents database not available" },
    };
  }

  return {
    status: 200,
    body: {
      ok: true,
      ...typedPayload.stats,
    },
  };
}

function handleModels(): RouteResult {
  const modelHealth = parseJSONFile<unknown>(config.modelHealthFile);
  if (modelHealth === null) {
    return {
      status: 200,
      body: { error: "Model health data not available", generatedAt: null },
    };
  }
  return { status: 200, body: modelHealth };
}

function handleComms(): RouteResult {
  const payload = withCache("comms", COMMS_TTL_MS, () => loadCommsData());
  return { status: 200, body: payload };
}

const prefsDir = path.join(config.workspaceDir, "data", "dashboard-prefs");

function ensurePrefsDir(): void {
  if (!fs.existsSync(prefsDir)) {
    fs.mkdirSync(prefsDir, { recursive: true });
  }
}

function handleGetPrefs(username: string): RouteResult {
  if (!username || !isSafePathSegment(username)) {
    return { status: 400, body: { error: "bad_request", message: "Missing or invalid X-Auth-User header" } };
  }
  const filePath = path.join(prefsDir, `${username}.json`);
  const prefs = parseJSONFile<Record<string, unknown>>(filePath);
  return { status: 200, body: prefs ?? {} };
}

function handlePutPrefs(body: string, username: string): RouteResult {
  if (!username || !isSafePathSegment(username)) {
    return { status: 400, body: { error: "bad_request", message: "Missing or invalid X-Auth-User header" } };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { status: 400, body: { error: "bad_request", message: "Invalid JSON body" } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { status: 400, body: { error: "bad_request", message: "Body must be a JSON object" } };
  }
  ensurePrefsDir();
  const filePath = path.join(prefsDir, `${username}.json`);
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2), "utf-8");
  return { status: 200, body: { ok: true } };
}

function routePut(url: URL, body: string, username: string): RouteResult {
  const pathname = url.pathname;
  if (pathname === "/prefs") {
    return handlePutPrefs(body, username);
  }
  return { status: 404, body: { error: "not_found", message: `No route for PUT ${pathname}` } };
}

function routeRequest(url: URL, username?: string): RouteResult {
  const pathname = url.pathname;

  if (pathname === "/health") {
    return handleHealth();
  }

  if (pathname === "/runtime") {
    return handleRuntime();
  }

  if (pathname === "/sessions") {
    return handleSessionsList(url);
  }

  const sessionMatch = pathname.match(/^\/sessions\/([^/]+)\/([^/]+)$/);
  if (sessionMatch) {
    const agentId = decodeURIComponent(sessionMatch[1] ?? "");
    const sessionId = decodeURIComponent(sessionMatch[2] ?? "");

    if (!isSafePathSegment(agentId) || !isSafePathSegment(sessionId)) {
      return {
        status: 400,
        body: { error: "invalid_path", message: "Invalid session path segments" },
      };
    }

    return handleSessionDetail(url, agentId, sessionId);
  }

  if (pathname === "/incidents") {
    return handleIncidents(url);
  }

  if (pathname === "/incidents/stats") {
    return handleIncidentStats(url);
  }

  if (pathname === "/models") {
    return handleModels();
  }

  if (pathname === "/comms") {
    return handleComms();
  }

  if (pathname === "/whoami") {
    return { status: 200, body: { user: username ?? null } };
  }

  if (pathname === "/prefs") {
    return handleGetPrefs(username ?? "");
  }

  return {
    status: 404,
    body: { error: "not_found", message: `No route for GET ${pathname}` },
  };
}

function sendJSON(res: http.ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(json);
}

const server = http.createServer((req, res) => {
  const method = req.method ?? "GET";
  const rawUrl = req.url ?? "/";

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-Auth-User");

  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (method !== "GET" && method !== "PUT") {
    sendJSON(res, 405, { error: "method_not_allowed" });
    return;
  }

  const username = typeof req.headers["x-auth-user"] === "string" ? req.headers["x-auth-user"] : "";

  if (method === "PUT") {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      try {
        const body = Buffer.concat(chunks).toString("utf-8");
        const url = parseRequestUrl(rawUrl);
        const result = routePut(url, body, username);
        sendJSON(res, result.status, result.body);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        sendJSON(res, 500, { error: "internal", message });
      }
    });
    return;
  }

  try {
    const url = parseRequestUrl(rawUrl);
    const result = routeRequest(url, username);
    sendJSON(res, result.status, result.body);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendJSON(res, 500, { error: "internal", message });
  }
});

ensurePrefsDir();

server.listen(config.port, "127.0.0.1", () => {
  // eslint-disable-next-line no-console
  console.log(`[dashboard-api] Listening on 127.0.0.1:${config.port}`);
});
