import { afterEach, beforeEach, describe, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { initRoomDatabase } from "../roomd.js";

let tmpDir: string;
let dbPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "roomd-test-"));
  dbPath = path.join(tmpDir, "roomd.db");
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("roomd database bootstrap", () => {
  test("creates schema and enables WAL mode", () => {
    const roomDb = initRoomDatabase(dbPath);
    const db = roomDb.db;

    const tables = db.prepare(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    const tableNames = tables.map((row) => row.name);
    assert.ok(tableNames.includes("rooms"));
    assert.ok(tableNames.includes("participants"));
    assert.ok(tableNames.includes("attachments"));
    assert.ok(tableNames.includes("runtime_threads"));
    assert.ok(tableNames.includes("room_events"));
    assert.ok(tableNames.includes("deliveries"));

    const journalMode = db.pragma("journal_mode", { simple: true });
    assert.equal(String(journalMode).toLowerCase(), "wal");

    roomDb.close();
  });

  test("appendRoomEvent stores append-only events and updates room seq", () => {
    const roomDb = initRoomDatabase(dbPath);
    const now = Date.now();

    roomDb.db.prepare(`
      INSERT INTO rooms (id, key, title, mode, state, created_at, updated_at, last_event_seq, metadata_json)
      VALUES ('room-1', 'telegram:chat:123', 'Test Room', 'group', 'active', ?, ?, 0, '{}')
    `).run(now, now);

    const seq = roomDb.appendRoomEvent("room-1", "room_created", { hello: "world" });
    assert.equal(seq, 1);

    const row = roomDb.db.prepare(`
      SELECT room_id, event_type, payload_json
      FROM room_events
      WHERE seq = ?
    `).get(seq) as { room_id: string; event_type: string; payload_json: string };
    assert.equal(row.room_id, "room-1");
    assert.equal(row.event_type, "room_created");
    assert.deepEqual(JSON.parse(row.payload_json), { hello: "world" });

    const room = roomDb.db.prepare(`
      SELECT last_event_seq
      FROM rooms
      WHERE id = 'room-1'
    `).get() as { last_event_seq: number };
    assert.equal(room.last_event_seq, 1);

    roomDb.close();
  });
});
