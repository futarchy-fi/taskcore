import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { OrchestrationCore } from "../../core/index.js";
import type { Event, Phase } from "../../core/types.js";
import { reconcileOrphanedTasks } from "../reconcile.js";

const defaultBudgets = {
  analysis: { max: 6 },
  decomposition: { max: 6 },
  execution: { max: 6 },
  review: { max: 6 },
};

function withCore(run: (core: OrchestrationCore) => void): void {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskcore-reconcile-"));
  const dbPath = path.join(tmpDir, "test.db");
  const core = new OrchestrationCore({
    dbPath,
    invariantChecks: true,
    snapshotEvery: 50,
  });

  try {
    run(core);
  } finally {
    core.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function submitAll(core: OrchestrationCore, events: Event[]): void {
  for (const event of events) {
    const result = core.submit(event);
    assert.equal(result.ok, true, `failed submitting ${event.type} for ${event.taskId}`);
  }
}

function createTask(taskId: string, ts: number): Event {
  return {
    type: "TaskCreated",
    taskId,
    ts,
    title: `Task ${taskId}`,
    description: `Task ${taskId}`,
    parentId: null,
    rootId: taskId,
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: defaultBudgets,
    costBudget: 100,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };
}

function lease(taskId: string, ts: number, fenceToken: number, phase: Phase, agentId: string, sessionId: string): Event {
  return {
    type: "LeaseGranted",
    taskId,
    ts,
    fenceToken,
    agentId,
    phase,
    leaseTimeout: 60_000,
    sessionId,
    sessionType: "fresh",
    contextBudget: 1024,
  };
}

function started(taskId: string, ts: number, fenceToken: number, agentId: string, sessionId: string): Event {
  return {
    type: "AgentStarted",
    taskId,
    ts,
    fenceToken,
    agentContext: {
      sessionId,
      agentId,
      memoryRef: null,
      contextTokens: 400,
      modelId: "gpt-5",
    },
  };
}

function transition(
  taskId: string,
  ts: number,
  from: { phase: Phase; condition: "active" | "ready" | "waiting" },
  to: { phase: Phase; condition: "ready" | "waiting" },
  reasonCode: "decision_decompose" | "children_created" | "children_complete" | "add_children",
  fenceToken: number,
  agentId: string,
  sessionId: string,
): Event {
  return {
    type: "PhaseTransition",
    taskId,
    ts,
    from,
    to,
    reasonCode,
    reason: reasonCode,
    fenceToken,
    agentContext: {
      sessionId,
      agentId,
      memoryRef: null,
      contextTokens: 400,
      modelId: "gpt-5",
    },
  };
}

function complete(taskId: string, ts: number): Event {
  return {
    type: "TaskCompleted",
    taskId,
    ts,
    stateRef: {
      branch: `task/${taskId}`,
      commit: `c-${taskId}-${ts}`,
      parentCommit: `p-${taskId}-${ts - 1}`,
    },
  };
}

test("startup reconciliation recovers decomposition.active with already-materialized children into review.waiting", () => {
  withCore((core) => {
    submitAll(core, [
      createTask("T1", 1),
      lease("T1", 2, 1, "analysis", "analyst", "a-1"),
      started("T1", 3, 1, "analyst", "a-1"),
      transition("T1", 4, { phase: "analysis", condition: "active" }, { phase: "decomposition", condition: "ready" }, "decision_decompose", 1, "analyst", "a-1"),
      lease("T1", 5, 2, "decomposition", "decomposer", "d-1"),
      started("T1", 6, 2, "decomposer", "d-1"),
      {
        type: "DecompositionCreated",
        taskId: "T1",
        ts: 7,
        fenceToken: 2,
        version: 1,
        children: [
          {
            taskId: "T2",
            title: "Child 1",
            description: "Child 1",
            costAllocation: 20,
            skipAnalysis: true,
            dependencies: [],
          },
          {
            taskId: "T3",
            title: "Child 2",
            description: "Child 2",
            costAllocation: 20,
            skipAnalysis: true,
            dependencies: [],
          },
        ],
        checkpoints: [],
        completionRule: "and",
        agentContext: {
          sessionId: "d-1",
          agentId: "decomposer",
          memoryRef: null,
          contextTokens: 300,
          modelId: "gpt-5",
        },
      },
    ]);

    const reconciled = reconcileOrphanedTasks(core, 10_000);
    assert.equal(reconciled, 1);

    const parent = core.getTask("T1");
    assert.ok(parent);
    assert.equal(parent.phase, "review");
    assert.equal(parent.condition, "waiting");
    assert.equal(parent.decompositionVersion, 1);
    assert.deepEqual(parent.children, ["T2", "T3"]);

    const child1 = core.getTask("T2");
    const child2 = core.getTask("T3");
    assert.ok(child1);
    assert.ok(child2);
    assert.equal(child1.phase, "execution");
    assert.equal(child1.condition, "ready");
    assert.equal(child2.phase, "execution");
    assert.equal(child2.condition, "ready");
  });
});

test("startup reconciliation still retries decomposition when only old children exist from a prior version", () => {
  withCore((core) => {
    submitAll(core, [
      createTask("T10", 1),
      lease("T10", 2, 1, "analysis", "analyst", "a-10"),
      started("T10", 3, 1, "analyst", "a-10"),
      transition("T10", 4, { phase: "analysis", condition: "active" }, { phase: "decomposition", condition: "ready" }, "decision_decompose", 1, "analyst", "a-10"),
      lease("T10", 5, 2, "decomposition", "decomposer", "d-10"),
      started("T10", 6, 2, "decomposer", "d-10"),
      {
        type: "DecompositionCreated",
        taskId: "T10",
        ts: 7,
        fenceToken: 2,
        version: 1,
        children: [
          {
            taskId: "T11",
            title: "Old child 1",
            description: "Old child 1",
            costAllocation: 20,
            skipAnalysis: true,
            dependencies: [],
          },
          {
            taskId: "T12",
            title: "Old child 2",
            description: "Old child 2",
            costAllocation: 20,
            skipAnalysis: true,
            dependencies: [],
          },
        ],
        checkpoints: [],
        completionRule: "and",
        agentContext: {
          sessionId: "d-10",
          agentId: "decomposer",
          memoryRef: null,
          contextTokens: 300,
          modelId: "gpt-5",
        },
      },
      transition("T10", 8, { phase: "decomposition", condition: "active" }, { phase: "review", condition: "waiting" }, "children_created", 2, "decomposer", "d-10"),
      complete("T11", 9),
      complete("T12", 10),
      transition("T10", 11, { phase: "review", condition: "waiting" }, { phase: "review", condition: "ready" }, "children_complete", 2, "core", "core"),
      lease("T10", 12, 3, "review", "reviewer", "r-10"),
      started("T10", 13, 3, "reviewer", "r-10"),
      transition("T10", 14, { phase: "review", condition: "active" }, { phase: "decomposition", condition: "ready" }, "add_children", 3, "reviewer", "r-10"),
      lease("T10", 15, 4, "decomposition", "decomposer", "d-11"),
      started("T10", 16, 4, "decomposer", "d-11"),
    ]);

    const reconciled = reconcileOrphanedTasks(core, 10_000);
    assert.equal(reconciled, 1);

    const parent = core.getTask("T10");
    assert.ok(parent);
    assert.equal(parent.phase, "decomposition");
    assert.equal(parent.condition, "retryWait");
    assert.equal(parent.decompositionVersion, 1);
    assert.equal(parent.currentFenceToken, 4);
  });
});
