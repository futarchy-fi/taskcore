import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";

export interface RoomdConfig {
  dbPath: string;
  gatewayWsUrl: string;
  gatewayToken: string;
  heartbeatMs: number;
  reconnectBaseMs: number;
  reconnectMaxMs: number;
  serviceName: string;
}

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envStr(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export function loadRoomdConfig(): RoomdConfig {
  const workspaceDir = envStr(
    "WORKSPACE_DIR",
    envStr("OPENCLAW_STATE_DIR", `${process.env["HOME"]}/.openclaw/workspace`),
  );

  return {
    dbPath: envStr("ROOMD_DB", path.join(workspaceDir, "data", "roomd", "roomd.db")),
    gatewayWsUrl: envStr("ROOMD_GATEWAY_WS_URL", "ws://127.0.0.1:18789/ws"),
    gatewayToken: envStr("ROOMD_GATEWAY_TOKEN", envStr("OPENCLAW_GATEWAY_TOKEN", "")),
    heartbeatMs: envInt("ROOMD_HEARTBEAT_MS", 15_000),
    reconnectBaseMs: envInt("ROOMD_RECONNECT_BASE_MS", 1_000),
    reconnectMaxMs: envInt("ROOMD_RECONNECT_MAX_MS", 30_000),
    serviceName: envStr("ROOMD_SERVICE_NAME", "roomd"),
  };
}

export interface RoomdDatabase {
  db: Database.Database;
  appendRoomEvent: (roomId: string | null, eventType: string, payload?: unknown) => number;
  close: () => void;
}

function ensureParentDir(filePath: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function applyPragmas(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS rooms (
      id TEXT PRIMARY KEY,
      key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'direct',
      state TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_event_seq INTEGER NOT NULL DEFAULT 0,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS participants (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      participant_key TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'member',
      source TEXT NOT NULL DEFAULT 'manual',
      state TEXT NOT NULL DEFAULT 'active',
      joined_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      UNIQUE(room_id, participant_key)
    );

    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      event_seq INTEGER,
      kind TEXT NOT NULL,
      storage_key TEXT,
      mime_type TEXT,
      size_bytes INTEGER,
      created_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS runtime_threads (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      runtime TEXT NOT NULL,
      thread_key TEXT NOT NULL,
      agent_id TEXT,
      status TEXT NOT NULL DEFAULT 'idle',
      last_seen_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      UNIQUE(runtime, thread_key)
    );

    CREATE TABLE IF NOT EXISTS room_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      room_id TEXT,
      event_type TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'roomd',
      created_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS deliveries (
      id TEXT PRIMARY KEY,
      room_id TEXT NOT NULL,
      event_seq INTEGER,
      direction TEXT NOT NULL,
      provider TEXT NOT NULL,
      provider_ref TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_count INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
      FOREIGN KEY (event_seq) REFERENCES room_events(seq) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_participants_room_id ON participants(room_id);
    CREATE INDEX IF NOT EXISTS idx_attachments_room_id ON attachments(room_id);
    CREATE INDEX IF NOT EXISTS idx_runtime_threads_room_id ON runtime_threads(room_id);
    CREATE INDEX IF NOT EXISTS idx_room_events_room_seq ON room_events(room_id, seq DESC);
    CREATE INDEX IF NOT EXISTS idx_room_events_created_at ON room_events(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliveries_room_id ON deliveries(room_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_deliveries_status ON deliveries(status, updated_at DESC);
  `);
}

export function initRoomDatabase(dbPath: string): RoomdDatabase {
  ensureParentDir(dbPath);
  const db = new Database(dbPath);
  applyPragmas(db);
  applySchema(db);

  const insertEvent = db.prepare(`
    INSERT INTO room_events (room_id, event_type, source, created_at, payload_json)
    VALUES (@roomId, @eventType, 'roomd', @createdAt, @payloadJson)
  `);

  const updateRoomSeq = db.prepare(`
    UPDATE rooms
    SET last_event_seq = @seq,
        updated_at = @updatedAt
    WHERE id = @roomId
  `);

  return {
    db,
    appendRoomEvent: (roomId: string | null, eventType: string, payload?: unknown): number => {
      const createdAt = Date.now();
      const result = insertEvent.run({
        roomId,
        eventType,
        createdAt,
        payloadJson: JSON.stringify(payload ?? {}),
      });
      const seq = Number(result.lastInsertRowid);
      if (roomId !== null) {
        updateRoomSeq.run({ roomId, seq, updatedAt: createdAt });
      }
      return seq;
    },
    close: () => db.close(),
  };
}

export class GatewayWsClient {
  private readonly db: RoomdDatabase;
  private readonly config: RoomdConfig;
  private socket: WebSocket | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelayMs: number;
  private stopped = false;

  constructor(db: RoomdDatabase, config: RoomdConfig) {
    this.db = db;
    this.config = config;
    this.reconnectDelayMs = config.reconnectBaseMs;
  }

  start(): void {
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    this.clearHeartbeat();
    this.clearReconnect();
    if (this.socket !== null) {
      this.socket.close();
      this.socket = null;
    }
  }

  private connect(): void {
    if (this.stopped) return;

    const url = new URL(this.config.gatewayWsUrl);
    if (this.config.gatewayToken !== "") {
      url.searchParams.set("token", this.config.gatewayToken);
    }

    this.db.appendRoomEvent(null, "gateway_connecting", {
      url: `${url.origin}${url.pathname}`,
      service: this.config.serviceName,
    });

    const socket = new WebSocket(url);
    this.socket = socket;

    socket.addEventListener("open", () => {
      this.reconnectDelayMs = this.config.reconnectBaseMs;
      this.db.appendRoomEvent(null, "gateway_connected", {
        service: this.config.serviceName,
      });
      this.sendJson({
        type: "roomd.hello",
        service: this.config.serviceName,
        pid: process.pid,
        ts: Date.now(),
      });
      this.startHeartbeat();
    });

    socket.addEventListener("message", (event) => {
      const raw = typeof event.data === "string"
        ? event.data
        : Buffer.isBuffer(event.data)
          ? event.data.toString("utf-8")
          : String(event.data);

      let payload: unknown = raw;
      try {
        payload = JSON.parse(raw);
      } catch {
        // keep raw payload for append-only capture
      }

      this.db.appendRoomEvent(null, "gateway_message", { payload });
    });

    socket.addEventListener("error", () => {
      this.db.appendRoomEvent(null, "gateway_error", {
        service: this.config.serviceName,
      });
    });

    socket.addEventListener("close", (event) => {
      this.clearHeartbeat();
      this.socket = null;
      this.db.appendRoomEvent(null, "gateway_disconnected", {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      });
      this.scheduleReconnect();
    });
  }

  private startHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.sendJson({
        type: "roomd.ping",
        service: this.config.serviceName,
        ts: Date.now(),
      });
    }, this.config.heartbeatMs);
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimer !== null) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.clearReconnect();
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(
      this.reconnectDelayMs * 2,
      this.config.reconnectMaxMs,
    );
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private clearReconnect(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private sendJson(payload: unknown): void {
    if (this.socket === null || this.socket.readyState !== WebSocket.OPEN) {
      return;
    }
    this.socket.send(JSON.stringify(payload));
  }
}

export async function main(): Promise<void> {
  const config = loadRoomdConfig();
  const roomDb = initRoomDatabase(config.dbPath);
  roomDb.appendRoomEvent(null, "roomd_boot", {
    pid: process.pid,
    dbPath: config.dbPath,
    gatewayWsUrl: config.gatewayWsUrl,
  });

  const client = new GatewayWsClient(roomDb, config);
  client.start();

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    roomDb.appendRoomEvent(null, "roomd_shutdown", { signal, pid: process.pid });
    client.stop();
    roomDb.close();
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  void main().catch((err: unknown) => {
    console.error("[roomd] fatal error", err);
    process.exit(1);
  });
}
