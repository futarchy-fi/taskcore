import * as fs from "node:fs";
import * as path from "node:path";
import {
  createInitialState,
  type Event,
  type EventEnvelope,
  type Persistence,
  type SnapshotRow,
  type SystemState,
} from "./types.js";

interface EventLine {
  seq: number;
  taskId: string;
  type: string;
  ts: number;
  event: Event;
}

/**
 * Append-only JSONL persistence backend.
 *
 * Write path (the critical invariant):
 *   1. JSON-encode the event as a single line
 *   2. write() to the file descriptor (kernel append semantics via O_APPEND)
 *   3. fsync() — event is durable on disk BEFORE we return
 *
 * The in-memory state is always rebuildable from the log file.
 * Snapshots are optional accelerators stored as separate JSON files.
 */
export class JsonlPersistence implements Persistence {
  private readonly eventLogPath: string;
  private readonly snapshotDir: string;
  private fd: number;
  private sequence: number;
  /** In-memory index: taskId → sequence numbers (for loadTaskEvents) */
  private taskIndex: Map<string, number[]> = new Map();
  /** In-memory cache of all event envelopes (for loadEventsSince / loadTaskEvents) */
  private eventCache: EventEnvelope[] = [];

  public constructor(eventLogDir: string) {
    this.eventLogPath = path.join(eventLogDir, "events.jsonl");
    this.snapshotDir = path.join(eventLogDir, "snapshots");

    // Ensure directories exist
    fs.mkdirSync(eventLogDir, { recursive: true });
    fs.mkdirSync(this.snapshotDir, { recursive: true });

    // Open event log with O_WRONLY | O_APPEND | O_CREAT
    // O_APPEND guarantees atomic append semantics at the kernel level
    this.fd = fs.openSync(
      this.eventLogPath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
      0o600,
    );

    // Load existing events to determine current sequence and build index
    this.sequence = 0;
    this.loadExistingEvents();
  }

  public appendEvent(event: Event): number {
    this.sequence++;
    const seq = this.sequence;

    const line: EventLine = {
      seq,
      taskId: event.taskId,
      type: event.type,
      ts: event.ts,
      event,
    };

    const encoded = JSON.stringify(line) + "\n";
    fs.writeSync(this.fd, encoded);
    fs.fsyncSync(this.fd);

    // Update in-memory cache and index
    const envelope: EventEnvelope = { sequence: seq, event };
    this.eventCache.push(envelope);

    let taskSeqs = this.taskIndex.get(event.taskId);
    if (!taskSeqs) {
      taskSeqs = [];
      this.taskIndex.set(event.taskId, taskSeqs);
    }
    taskSeqs.push(this.eventCache.length - 1);

    return seq;
  }

  public loadEventsSince(sequence: number): EventEnvelope[] {
    // Binary search for the first envelope with seq > sequence
    const envelopes = this.eventCache;
    let lo = 0;
    let hi = envelopes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (envelopes[mid]!.sequence <= sequence) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    return envelopes.slice(lo);
  }

  public loadTaskEvents(taskId: string): EventEnvelope[] {
    const indices = this.taskIndex.get(taskId);
    if (!indices) return [];
    return indices.map((idx) => this.eventCache[idx]!);
  }

  public saveSnapshot(state: SystemState): void {
    const seqStr = String(state.sequence).padStart(8, "0");
    const tmpPath = path.join(this.snapshotDir, `snapshot-${seqStr}.tmp`);
    const finalPath = path.join(this.snapshotDir, `snapshot-${seqStr}.json`);

    // Write to temp file, then atomic rename
    fs.writeFileSync(tmpPath, JSON.stringify({
      sequence: state.sequence,
      state,
      createdAt: Date.now(),
    }));
    fs.renameSync(tmpPath, finalPath);
  }

  public loadLatestSnapshot(): SnapshotRow | null {
    let files: string[];
    try {
      files = fs.readdirSync(this.snapshotDir);
    } catch {
      return null;
    }

    const snapshotFiles = files
      .filter((f) => f.startsWith("snapshot-") && f.endsWith(".json"))
      .sort();

    if (snapshotFiles.length === 0) return null;

    const latest = snapshotFiles[snapshotFiles.length - 1]!;
    const data = fs.readFileSync(path.join(this.snapshotDir, latest), "utf-8");
    const parsed = JSON.parse(data) as {
      sequence: number;
      state: SystemState;
      createdAt: number;
    };

    return {
      sequence: parsed.sequence,
      state: parsed.state,
      createdAt: parsed.createdAt,
    };
  }

  public rebuildState(
    reducer: (state: SystemState, event: Event) => SystemState,
  ): SystemState {
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
    // Close current fd
    fs.closeSync(this.fd);

    // Remove event log and recreate empty
    try { fs.unlinkSync(this.eventLogPath); } catch { /* may not exist */ }
    this.fd = fs.openSync(
      this.eventLogPath,
      fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT,
      0o600,
    );

    // Remove all snapshots
    try {
      const files = fs.readdirSync(this.snapshotDir);
      for (const f of files) {
        fs.unlinkSync(path.join(this.snapshotDir, f));
      }
    } catch { /* ignore */ }

    // Reset in-memory state
    this.sequence = 0;
    this.eventCache = [];
    this.taskIndex = new Map();
  }

  public resetSequence(sequence: number): void {
    this.sequence = sequence;
  }

  public close(): void {
    try {
      fs.closeSync(this.fd);
    } catch {
      // Already closed or invalid fd — ignore
    }
  }

  // -------------------------------------------------------------------------
  // Private
  // -------------------------------------------------------------------------

  private loadExistingEvents(): void {
    let content: string;
    try {
      content = fs.readFileSync(this.eventLogPath, "utf-8");
    } catch {
      return; // No existing file
    }

    if (content.length === 0) return;

    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;

      let parsed: EventLine;
      try {
        parsed = JSON.parse(trimmed) as EventLine;
      } catch {
        console.error(`[jsonl-persistence] Skipping malformed line: ${trimmed.slice(0, 100)}`);
        continue;
      }

      if (parsed.seq > this.sequence) {
        this.sequence = parsed.seq;
      }

      const envelope: EventEnvelope = {
        sequence: parsed.seq,
        event: parsed.event,
      };
      this.eventCache.push(envelope);

      let taskSeqs = this.taskIndex.get(parsed.taskId);
      if (!taskSeqs) {
        taskSeqs = [];
        this.taskIndex.set(parsed.taskId, taskSeqs);
      }
      taskSeqs.push(this.eventCache.length - 1);
    }
  }
}
