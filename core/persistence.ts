import Database from "better-sqlite3";
import {
  createInitialState,
  type Event,
  type EventEnvelope,
  type SystemState,
} from "./types.js";

export interface SnapshotRow {
  sequence: number;
  state: SystemState;
  createdAt: number;
}

interface EventRow {
  sequence: number;
  task_id: string;
  type: string;
  ts: number;
  payload: string;
}

interface SnapshotDbRow {
  sequence: number;
  state: string;
  created_at: number;
}

export class SQLitePersistence {
  private readonly db: Database.Database;

  public constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = FULL");
    this.db.pragma("foreign_keys = ON");
    this.init();
  }

  private init(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        ts INTEGER NOT NULL,
        payload TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_task_id_sequence ON events(task_id, sequence);
      CREATE INDEX IF NOT EXISTS idx_events_type_sequence ON events(type, sequence);

      CREATE TABLE IF NOT EXISTS snapshots (
        sequence INTEGER PRIMARY KEY,
        state TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  public appendEvent(event: Event): number {
    const stmt = this.db.prepare(
      "INSERT INTO events (task_id, type, ts, payload) VALUES (?, ?, ?, ?)",
    );
    const info = stmt.run(event.taskId, event.type, event.ts, JSON.stringify(event));
    return Number(info.lastInsertRowid);
  }

  public loadEventsSince(sequence: number): EventEnvelope[] {
    const stmt = this.db.prepare(
      "SELECT sequence, task_id, type, ts, payload FROM events WHERE sequence > ? ORDER BY sequence ASC",
    );
    const rows = stmt.all(sequence) as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      event: JSON.parse(row.payload) as Event,
    }));
  }

  public loadTaskEvents(taskId: string): EventEnvelope[] {
    const stmt = this.db.prepare(
      "SELECT sequence, task_id, type, ts, payload FROM events WHERE task_id = ? ORDER BY sequence ASC",
    );
    const rows = stmt.all(taskId) as EventRow[];
    return rows.map((row) => ({
      sequence: row.sequence,
      event: JSON.parse(row.payload) as Event,
    }));
  }

  public saveSnapshot(state: SystemState): void {
    const stmt = this.db.prepare(
      "INSERT INTO snapshots (sequence, state, created_at) VALUES (?, ?, ?) ON CONFLICT(sequence) DO UPDATE SET state = excluded.state, created_at = excluded.created_at",
    );
    stmt.run(state.sequence, JSON.stringify(state), Date.now());
  }

  public loadLatestSnapshot(): SnapshotRow | null {
    const stmt = this.db.prepare(
      "SELECT sequence, state, created_at FROM snapshots ORDER BY sequence DESC LIMIT 1",
    );
    const row = stmt.get() as SnapshotDbRow | undefined;
    if (!row) {
      return null;
    }

    return {
      sequence: row.sequence,
      state: JSON.parse(row.state) as SystemState,
      createdAt: row.created_at,
    };
  }

  public rebuildState(reducer: (state: SystemState, event: Event) => SystemState): SystemState {
    const snapshot = this.loadLatestSnapshot();
    let state = snapshot?.state ?? createInitialState();
    const sequence = snapshot?.sequence ?? 0;
    const events = this.loadEventsSince(sequence);

    for (const envelope of events) {
      state = reducer(state, envelope.event);
      state.sequence = envelope.sequence;
      const lastEvent = state.events[state.events.length - 1];
      if (lastEvent) {
        lastEvent.sequence = envelope.sequence;
      }
    }

    return state;
  }

  public truncateAll(): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM events").run();
      this.db.prepare("DELETE FROM snapshots").run();
      this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'").run();
    });
    tx();
  }

  public close(): void {
    try {
      this.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch (err) {
      console.error("[persistence] WAL checkpoint failed:", err);
    }
    this.db.close();
  }
}
