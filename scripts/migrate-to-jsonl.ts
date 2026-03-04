#!/usr/bin/env -S node --import tsx
/**
 * One-time migration: SQLite event store → JSONL append-only log.
 *
 * Usage:
 *   node --import tsx core/scripts/migrate-to-jsonl.ts [--db <path>] [--out <dir>]
 *
 * Defaults:
 *   --db  $WORKSPACE/data/taskcore.db
 *   --out $WORKSPACE/data/taskcore
 *
 * Steps:
 *   1. Open SQLite DB (read-only)
 *   2. Load all events ordered by sequence
 *   3. Write each as a JSONL line to events.jsonl
 *   4. Save current state as a snapshot
 *   5. Verify: line count === event count
 */

import * as fs from "node:fs";
import * as path from "node:path";
import Database from "better-sqlite3";
import { reduce } from "../core/reducer.js";
import { createInitialState, type Event, type SystemState } from "../core/types.js";

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

function parseArgs(): { dbPath: string; outDir: string } {
  const args = process.argv.slice(2);
  const workspace = process.env["WORKSPACE_DIR"] ??
    process.env["OPENCLAW_STATE_DIR"] ??
    `${process.env["HOME"]}/.openclaw/workspace`;

  let dbPath = `${workspace}/data/taskcore.db`;
  let outDir = `${workspace}/data/taskcore`;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[++i]!;
    } else if (args[i] === "--out" && args[i + 1]) {
      outDir = args[++i]!;
    }
  }

  return { dbPath, outDir };
}

function main(): void {
  const { dbPath, outDir } = parseArgs();
  const eventLogPath = path.join(outDir, "events.jsonl");
  const snapshotDir = path.join(outDir, "snapshots");

  console.log(`[migrate] SQLite DB: ${dbPath}`);
  console.log(`[migrate] Output dir: ${outDir}`);

  // Preflight checks
  if (!fs.existsSync(dbPath)) {
    console.error(`[migrate] ERROR: SQLite DB not found at ${dbPath}`);
    process.exit(1);
  }

  if (fs.existsSync(eventLogPath)) {
    const stat = fs.statSync(eventLogPath);
    if (stat.size > 0) {
      console.error(`[migrate] ERROR: ${eventLogPath} already exists and is non-empty.`);
      console.error(`[migrate] Remove it first if you want to re-run migration.`);
      process.exit(1);
    }
  }

  // Ensure output directories
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(snapshotDir, { recursive: true });

  // Open SQLite (read-only)
  const db = new Database(dbPath, { readonly: true });
  db.pragma("journal_mode = WAL");

  // Count events
  const countRow = db.prepare("SELECT COUNT(*) as cnt FROM events").get() as { cnt: number };
  const totalEvents = countRow.cnt;
  console.log(`[migrate] Found ${totalEvents} events in SQLite`);

  if (totalEvents === 0) {
    console.log("[migrate] No events to migrate. Done.");
    db.close();
    return;
  }

  // Load all events ordered by sequence
  const stmt = db.prepare(
    "SELECT sequence, task_id, type, ts, payload FROM events ORDER BY sequence ASC",
  );
  const rows = stmt.all() as EventRow[];

  // Open JSONL file for writing
  const fd = fs.openSync(eventLogPath, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT, 0o600);

  let written = 0;
  for (const row of rows) {
    const event = JSON.parse(row.payload) as Event;
    const line = JSON.stringify({
      seq: row.sequence,
      taskId: row.task_id,
      type: row.type,
      ts: row.ts,
      event,
    }) + "\n";
    fs.writeSync(fd, line);
    written++;

    if (written % 1000 === 0) {
      console.log(`[migrate]   ${written}/${totalEvents} events written...`);
    }
  }

  // fsync to ensure all data is on disk
  fs.fsyncSync(fd);
  fs.closeSync(fd);

  console.log(`[migrate] Wrote ${written} events to ${eventLogPath}`);

  // Verify line count
  const content = fs.readFileSync(eventLogPath, "utf-8");
  const lineCount = content.split("\n").filter((l) => l.trim().length > 0).length;
  if (lineCount !== totalEvents) {
    console.error(`[migrate] VERIFICATION FAILED: ${lineCount} lines vs ${totalEvents} events`);
    process.exit(1);
  }
  console.log(`[migrate] Verification passed: ${lineCount} lines === ${totalEvents} events`);

  // Build state by replaying all events (to create a snapshot)
  console.log("[migrate] Rebuilding state from events...");

  // Try to load existing snapshot for faster rebuild
  const snapshotStmt = db.prepare(
    "SELECT sequence, state, created_at FROM snapshots ORDER BY sequence DESC LIMIT 1",
  );
  const snapshotRow = snapshotStmt.get() as SnapshotDbRow | undefined;

  let state: SystemState;
  if (snapshotRow) {
    state = JSON.parse(snapshotRow.state) as SystemState;
    console.log(`[migrate] Loaded snapshot at sequence ${snapshotRow.sequence}, replaying from there...`);
    const remaining = rows.filter((r) => r.sequence > snapshotRow.sequence);
    for (const row of remaining) {
      const event = JSON.parse(row.payload) as Event;
      const result = reduce(state, event);
      if (!result.ok) {
        console.error(`[migrate] Replay failed at seq ${row.sequence}: ${result.error.message}`);
        process.exit(1);
      }
      state = result.value.state;
      state.sequence = row.sequence;
      const lastEnvelope = state.events[state.events.length - 1];
      if (lastEnvelope) lastEnvelope.sequence = row.sequence;
    }
  } else {
    state = createInitialState();
    for (const row of rows) {
      const event = JSON.parse(row.payload) as Event;
      const result = reduce(state, event);
      if (!result.ok) {
        console.error(`[migrate] Replay failed at seq ${row.sequence}: ${result.error.message}`);
        process.exit(1);
      }
      state = result.value.state;
      state.sequence = row.sequence;
      const lastEnvelope = state.events[state.events.length - 1];
      if (lastEnvelope) lastEnvelope.sequence = row.sequence;
    }
  }

  // Save snapshot
  const seqStr = String(state.sequence).padStart(8, "0");
  const tmpPath = path.join(snapshotDir, `snapshot-${seqStr}.tmp`);
  const finalPath = path.join(snapshotDir, `snapshot-${seqStr}.json`);
  fs.writeFileSync(tmpPath, JSON.stringify({
    sequence: state.sequence,
    state,
    createdAt: Date.now(),
  }));
  fs.renameSync(tmpPath, finalPath);

  const taskCount = Object.keys(state.tasks).length;
  console.log(`[migrate] Snapshot saved: ${finalPath} (${taskCount} tasks, seq ${state.sequence})`);

  db.close();
  console.log("[migrate] Migration complete.");
  console.log(`[migrate] Next steps:`);
  console.log(`[migrate]   1. Run: core/scripts/setup-eventlog.sh ${outDir}`);
  console.log(`[migrate]   2. Set TASKCORE_BACKEND=jsonl (or leave default)`);
  console.log(`[migrate]   3. Restart taskcore-daemon`);
  console.log(`[migrate]   4. Verify: curl localhost:18800/health`);
}

main();
