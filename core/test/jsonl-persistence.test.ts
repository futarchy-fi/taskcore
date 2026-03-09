import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonlPersistence } from "../jsonl-persistence.js";
import { createInitialState, type Event, type SystemState } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tmpDir: string;
let persistence: JsonlPersistence;

function makeTmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "taskcore-jsonl-test-"));
}

function makeEvent(taskId: string, ts: number, type: string = "TaskCreated"): Event {
  return {
    type: "TaskCreated",
    taskId,
    ts,
    title: `Task ${taskId}`,
    description: `Test task ${taskId}`,
    parentId: null,
    rootId: taskId,
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 4 },
      decomposition: { max: 3 },
      execution: { max: 8 },
      review: { max: 6 },
    },
    costBudget: 100,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  } as Event;
}

function makeLeaseEvent(taskId: string, ts: number, fenceToken: number): Event {
  return {
    type: "LeaseGranted",
    taskId,
    ts,
    fenceToken,
    agentId: "test-agent",
    phase: "analysis",
    leaseTimeout: 60_000,
    sessionId: "sess-1",
    sessionType: "fresh",
    contextBudget: 1024,
    agentContext: {
      sessionId: "sess-1",
      agentId: "test-agent",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  } as Event;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("JsonlPersistence", () => {
  beforeEach(() => {
    tmpDir = makeTmpDir();
    persistence = new JsonlPersistence(tmpDir);
  });

  afterEach(() => {
    try { persistence.close(); } catch { /* ignore */ }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("appendEvent returns monotonically increasing sequence numbers", () => {
    const seq1 = persistence.appendEvent(makeEvent("T1", 1000));
    const seq2 = persistence.appendEvent(makeEvent("T2", 2000));
    const seq3 = persistence.appendEvent(makeEvent("T3", 3000));

    assert.equal(seq1, 1);
    assert.equal(seq2, 2);
    assert.equal(seq3, 3);
  });

  test("appendEvent writes to disk (survives close + reopen)", () => {
    persistence.appendEvent(makeEvent("T1", 1000));
    persistence.appendEvent(makeEvent("T2", 2000));
    persistence.close();

    // Reopen
    const p2 = new JsonlPersistence(tmpDir);
    const events = p2.loadEventsSince(0);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.sequence, 1);
    assert.equal(events[0]!.event.taskId, "T1");
    assert.equal(events[1]!.sequence, 2);
    assert.equal(events[1]!.event.taskId, "T2");
    p2.close();
  });

  test("appendEvent after reopen continues sequence numbering", () => {
    persistence.appendEvent(makeEvent("T1", 1000));
    persistence.appendEvent(makeEvent("T2", 2000));
    persistence.close();

    const p2 = new JsonlPersistence(tmpDir);
    const seq3 = p2.appendEvent(makeEvent("T3", 3000));
    assert.equal(seq3, 3);
    p2.close();
  });

  test("loadEventsSince returns events after given sequence", () => {
    persistence.appendEvent(makeEvent("T1", 1000));
    persistence.appendEvent(makeEvent("T2", 2000));
    persistence.appendEvent(makeEvent("T3", 3000));

    const since1 = persistence.loadEventsSince(1);
    assert.equal(since1.length, 2);
    assert.equal(since1[0]!.sequence, 2);
    assert.equal(since1[1]!.sequence, 3);

    const since0 = persistence.loadEventsSince(0);
    assert.equal(since0.length, 3);

    const since3 = persistence.loadEventsSince(3);
    assert.equal(since3.length, 0);
  });

  test("loadTaskEvents returns events for a specific task", () => {
    persistence.appendEvent(makeEvent("T1", 1000));
    persistence.appendEvent(makeEvent("T2", 2000));
    persistence.appendEvent(makeLeaseEvent("T1", 3000, 1));

    const t1Events = persistence.loadTaskEvents("T1");
    assert.equal(t1Events.length, 2);
    assert.equal(t1Events[0]!.event.type, "TaskCreated");
    assert.equal(t1Events[1]!.event.type, "LeaseGranted");

    const t2Events = persistence.loadTaskEvents("T2");
    assert.equal(t2Events.length, 1);
    assert.equal(t2Events[0]!.event.type, "TaskCreated");

    const t3Events = persistence.loadTaskEvents("T3");
    assert.equal(t3Events.length, 0);
  });

  test("saveSnapshot + loadLatestSnapshot roundtrips", () => {
    const state: SystemState = {
      tasks: {
        T1: {
          id: "T1",
          title: "Test",
          description: "A test task",
          parentId: null,
          rootId: "T1",
          phase: "analysis",
          condition: "ready",
          terminal: null,
          currentFenceToken: 0,
          leasedTo: null,
          leaseExpiresAt: null,
          retryAfter: null,
          lastAgentExitAt: null,
          attempts: {
            analysis: { used: 0, max: 4 },
            decomposition: { used: 0, max: 3 },
            execution: { used: 0, max: 8 },
            review: { used: 0, max: 6 },
          },
          cost: { allocated: 100, consumed: 0, childAllocated: 0, childRecovered: 0 },
          decompositionVersion: 0,
          children: [],
          checkpoints: [],
          costRecoveredToParent: false,
          triggeredCheckpoints: [],
          completionRule: "and",
          dependencies: [],
          approachHistory: [],
          failureSummaries: [],
          failureDigestVersion: 0,
          terminalSummary: null,
          stateRef: null,
          checkpointRefs: [],
          reviewConfig: null,
          reviewState: null,
          sessionPolicy: "fresh",
          currentSessionId: null,
          contextIsolation: [],
          contextBudget: 200,
          waitState: null,
          lastCompletionVerification: null,
          createdAt: 1000,
          updatedAt: 1000,
          metadata: {},
        },
      },
      events: [],
      sequence: 42,
    };

    persistence.saveSnapshot(state);
    const loaded = persistence.loadLatestSnapshot();

    assert.ok(loaded);
    assert.equal(loaded.sequence, 42);
    assert.equal(Object.keys(loaded.state.tasks).length, 1);
    assert.equal(loaded.state.tasks["T1"]!.title, "Test");
  });

  test("loadLatestSnapshot picks highest sequence", () => {
    const state1 = createInitialState();
    state1.sequence = 10;
    persistence.saveSnapshot(state1);

    const state2 = createInitialState();
    state2.sequence = 50;
    persistence.saveSnapshot(state2);

    const state3 = createInitialState();
    state3.sequence = 30;
    persistence.saveSnapshot(state3);

    const latest = persistence.loadLatestSnapshot();
    assert.ok(latest);
    assert.equal(latest.sequence, 50);
  });

  test("loadLatestSnapshot returns null when no snapshots", () => {
    const result = persistence.loadLatestSnapshot();
    assert.equal(result, null);
  });

  test("truncateAll clears events and snapshots", () => {
    persistence.appendEvent(makeEvent("T1", 1000));
    persistence.appendEvent(makeEvent("T2", 2000));
    persistence.saveSnapshot(createInitialState());

    persistence.truncateAll();

    const events = persistence.loadEventsSince(0);
    assert.equal(events.length, 0);

    const snapshot = persistence.loadLatestSnapshot();
    assert.equal(snapshot, null);

    // New events start at sequence 1 again
    const seq = persistence.appendEvent(makeEvent("T3", 3000));
    assert.equal(seq, 1);
  });

  test("rebuildState replays events from scratch", () => {
    persistence.appendEvent(makeEvent("T1", 1000));
    persistence.appendEvent(makeEvent("T2", 2000));

    let callCount = 0;
    const state = persistence.rebuildState((st, event) => {
      callCount++;
      // Simple passthrough — just track the event
      const next = { ...st, events: [...st.events], sequence: st.sequence };
      next.events.push({ sequence: 0, event });
      return next;
    });

    assert.equal(callCount, 2);
    assert.equal(state.sequence, 2);
  });

  test("rebuildState uses snapshot when available", () => {
    persistence.appendEvent(makeEvent("T1", 1000));
    persistence.appendEvent(makeEvent("T2", 2000));

    // Save a snapshot at sequence 1
    const snapshotState = createInitialState();
    snapshotState.sequence = 1;
    persistence.saveSnapshot(snapshotState);

    persistence.appendEvent(makeEvent("T3", 3000));

    let callCount = 0;
    const state = persistence.rebuildState((st, event) => {
      callCount++;
      const next = { ...st, events: [...st.events], sequence: st.sequence };
      next.events.push({ sequence: 0, event });
      return next;
    });

    // Should only replay events after the snapshot (seq 2 and 3)
    assert.equal(callCount, 2);
    assert.equal(state.sequence, 3);
  });

  test("events.jsonl is valid JSONL (one JSON object per line)", () => {
    persistence.appendEvent(makeEvent("T1", 1000));
    persistence.appendEvent(makeEvent("T2", 2000));
    persistence.appendEvent(makeEvent("T3", 3000));
    persistence.close();

    const content = fs.readFileSync(path.join(tmpDir, "events.jsonl"), "utf-8");
    const lines = content.split("\n").filter((l) => l.trim().length > 0);

    assert.equal(lines.length, 3);

    for (const line of lines) {
      const parsed = JSON.parse(line);
      assert.ok(parsed.seq);
      assert.ok(parsed.taskId);
      assert.ok(parsed.type);
      assert.ok(parsed.event);
    }
  });

  test("snapshot files use zero-padded sequence names", () => {
    const state = createInitialState();
    state.sequence = 42;
    persistence.saveSnapshot(state);

    const files = fs.readdirSync(path.join(tmpDir, "snapshots"));
    assert.equal(files.length, 1);
    assert.equal(files[0], "snapshot-00000042.json");
  });

  test("handles empty event log file gracefully", () => {
    persistence.close();

    // Create empty file
    fs.writeFileSync(path.join(tmpDir, "events.jsonl"), "");

    const p2 = new JsonlPersistence(tmpDir);
    const events = p2.loadEventsSince(0);
    assert.equal(events.length, 0);
    p2.close();
  });

  test("handles malformed lines gracefully (skips them)", () => {
    persistence.close();

    // Write some valid lines and one malformed line
    const eventLogPath = path.join(tmpDir, "events.jsonl");
    const validLine1 = JSON.stringify({
      seq: 1,
      taskId: "T1",
      type: "TaskCreated",
      ts: 1000,
      event: makeEvent("T1", 1000),
    });
    const malformedLine = "{broken json";
    const validLine2 = JSON.stringify({
      seq: 2,
      taskId: "T2",
      type: "TaskCreated",
      ts: 2000,
      event: makeEvent("T2", 2000),
    });

    fs.writeFileSync(eventLogPath, `${validLine1}\n${malformedLine}\n${validLine2}\n`);

    const p2 = new JsonlPersistence(tmpDir);
    const events = p2.loadEventsSince(0);
    assert.equal(events.length, 2);
    assert.equal(events[0]!.sequence, 1);
    assert.equal(events[1]!.sequence, 2);
    p2.close();
  });

  test("concurrent-safe: multiple appends maintain ordering", () => {
    const events: Event[] = [];
    for (let i = 0; i < 100; i++) {
      events.push(makeEvent(`T${i}`, 1000 + i));
    }

    const sequences: number[] = [];
    for (const event of events) {
      sequences.push(persistence.appendEvent(event));
    }

    // All sequences should be monotonically increasing
    for (let i = 1; i < sequences.length; i++) {
      assert.ok(sequences[i]! > sequences[i - 1]!, `seq ${sequences[i]} should be > ${sequences[i - 1]}`);
    }

    // Reopen and verify all are present
    persistence.close();
    const p2 = new JsonlPersistence(tmpDir);
    const loaded = p2.loadEventsSince(0);
    assert.equal(loaded.length, 100);
    p2.close();
  });
});

describe("JsonlPersistence integration with OrchestrationCore", () => {
  // This test verifies that the JSONL backend works end-to-end through the core
  let coreDir: string;

  beforeEach(() => {
    coreDir = makeTmpDir();
  });

  afterEach(() => {
    fs.rmSync(coreDir, { recursive: true, force: true });
  });

  test("OrchestrationCore works with jsonl backend", async () => {
    // Dynamic import to avoid circular issues
    const { OrchestrationCore } = await import("../index.js");

    const core = new OrchestrationCore({
      dbPath: path.join(coreDir, "unused.db"),
      eventLogDir: coreDir,
      persistenceBackend: "jsonl",
      invariantChecks: true,
      snapshotEvery: 5,
    });

    // Create a task
    const result = core.submit(makeEvent("T1", Date.now()));
    assert.ok(result.ok, `Submit should succeed: ${!result.ok ? result.error.message : ""}`);

    // Verify task is in state
    const task = core.getTask("T1");
    assert.ok(task);
    assert.equal(task.title, "Task T1");

    core.close();

    // Reopen and verify state is recovered
    const core2 = new OrchestrationCore({
      dbPath: path.join(coreDir, "unused.db"),
      eventLogDir: coreDir,
      persistenceBackend: "jsonl",
      invariantChecks: true,
      snapshotEvery: 5,
    });

    const task2 = core2.getTask("T1");
    assert.ok(task2);
    assert.equal(task2.title, "Task T1");
    assert.equal(task2.phase, "analysis");
    assert.equal(task2.condition, "ready");

    core2.close();
  });

  test("snapshot-accelerated recovery works", async () => {
    const { OrchestrationCore } = await import("../index.js");

    const core = new OrchestrationCore({
      dbPath: path.join(coreDir, "unused.db"),
      eventLogDir: coreDir,
      persistenceBackend: "jsonl",
      invariantChecks: true,
      snapshotEvery: 3,  // snapshot every 3 events
    });

    // Submit enough events to trigger a snapshot
    core.submit(makeEvent("T1", 1000));
    core.submit(makeEvent("T2", 2000));
    core.submit(makeEvent("T3", 3000));  // should trigger snapshot at seq 3
    core.submit(makeEvent("T4", 4000));

    core.close();

    // Verify snapshot was created
    const snapshotDir = path.join(coreDir, "snapshots");
    const snapshots = fs.readdirSync(snapshotDir).filter((f) => f.endsWith(".json"));
    // At least one snapshot should exist (at seq 3, and possibly one from close())
    assert.ok(snapshots.length >= 1, `Expected at least 1 snapshot, got ${snapshots.length}`);

    // Reopen and verify all tasks recovered
    const core2 = new OrchestrationCore({
      dbPath: path.join(coreDir, "unused.db"),
      eventLogDir: coreDir,
      persistenceBackend: "jsonl",
      invariantChecks: true,
      snapshotEvery: 3,
    });

    assert.ok(core2.getTask("T1"));
    assert.ok(core2.getTask("T2"));
    assert.ok(core2.getTask("T3"));
    assert.ok(core2.getTask("T4"));

    core2.close();
  });

  test("recovery from log only (no snapshots)", async () => {
    const { OrchestrationCore } = await import("../index.js");

    const core = new OrchestrationCore({
      dbPath: path.join(coreDir, "unused.db"),
      eventLogDir: coreDir,
      persistenceBackend: "jsonl",
      invariantChecks: true,
      snapshotEvery: 0,  // disable snapshots
    });

    core.submit(makeEvent("T1", 1000));
    core.submit(makeEvent("T2", 2000));
    core.submit(makeEvent("T3", 3000));

    core.close();

    // Delete any snapshots that might have been created at close()
    const snapshotDir = path.join(coreDir, "snapshots");
    try {
      for (const f of fs.readdirSync(snapshotDir)) {
        fs.unlinkSync(path.join(snapshotDir, f));
      }
    } catch { /* ignore */ }

    // Reopen — should rebuild entirely from log
    const core2 = new OrchestrationCore({
      dbPath: path.join(coreDir, "unused.db"),
      eventLogDir: coreDir,
      persistenceBackend: "jsonl",
      invariantChecks: true,
      snapshotEvery: 0,
    });

    assert.ok(core2.getTask("T1"));
    assert.ok(core2.getTask("T2"));
    assert.ok(core2.getTask("T3"));

    core2.close();
  });
});
