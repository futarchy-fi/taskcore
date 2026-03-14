import test from "node:test";
import assert from "node:assert/strict";

import { reduce } from "../reducer.js";
import { validateEvent } from "../validator.js";
import { createInitialState, type Event, type SystemState } from "../types.js";

function completionVerification(ts = 1, taskId = "T10"): Extract<Event, { type: "TaskCompleted" }>["verification"] {
  return {
    mode: "code-task",
    verifiedAt: ts,
    proof: {
      kind: "code-task",
      commitRef: `commit-${taskId}-${ts}`,
      changedFiles: ["src/index.ts"],
      testsPassed: true,
    },
    result: {
      kind: "code-task",
      status: "verified",
      verifiedCommitRef: `commit-${taskId}-${ts}`,
      changedFileCount: 1,
      testsPassed: true,
    },
  };
}

function bootstrapState(): SystemState {
  const created: Event = {
    type: "TaskCreated",
    taskId: "T10",
    ts: 1,
    title: "Validate me",
    description: "Task for validator tests",
    parentId: null,
    rootId: "T10",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 2 },
      decomposition: { max: 2 },
      execution: { max: 2 },
      review: { max: 2 },
    },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };

  const reduced = reduce(createInitialState(), created);
  assert.equal(reduced.ok, true);
  return reduced.ok ? reduced.value.state : createInitialState();
}

test("validator rejects non-monotonic fence token", () => {
  const state = bootstrapState();

  const invalidLease: Event = {
    type: "LeaseGranted",
    taskId: "T10",
    ts: 2,
    fenceToken: 0,
    agentId: "analyst",
    phase: "analysis",
    leaseTimeout: 60_000,
    sessionId: "sess-1",
    sessionType: "fresh",
    contextBudget: 512,
  };

  const error = validateEvent(state, invalidLease);
  assert.ok(error);
  assert.equal(error.code, "fence_not_monotonic");
});

test("validator enforces failure summary on TaskFailed", () => {
  const state = bootstrapState();

  const invalidFail: Event = {
    type: "TaskFailed",
    taskId: "T10",
    ts: 3,
    reason: "budget_exhausted",
    phase: "analysis",
    summary: {
      childId: null,
      approach: "",
      whatFailed: "",
      whatWasLearned: "",
      artifactRef: null,
    },
  };

  const error = validateEvent(state, invalidFail);
  assert.ok(error);
  assert.equal(error.code, "missing_failure_summary");
});


test("validator rejects TaskCompleted without verification", () => {
  let state = bootstrapState();
  const lease: Event = {
    type: "LeaseGranted",
    taskId: "T10",
    ts: 2,
    fenceToken: 1,
    agentId: "coder",
    phase: "analysis",
    leaseTimeout: 60_000,
    sessionId: "sess-1",
    sessionType: "fresh",
    contextBudget: 512,
  };
  const toExec: Event = {
    type: "PhaseTransition",
    taskId: "T10",
    ts: 3,
    from: { phase: "analysis", condition: "active" },
    to: { phase: "execution", condition: "ready" },
    reasonCode: "decision_execute",
    reason: "go",
    fenceToken: 1,
    agentContext: { sessionId: "sess-1", agentId: "coder", memoryRef: null, contextTokens: 100, modelId: "gpt-5" },
  };
  for (const e of [lease, { ...lease, type: "AgentStarted", ts: 2, agentContext: { sessionId: "sess-1", agentId: "coder", memoryRef: null, contextTokens: 100, modelId: "gpt-5" } } as Event, toExec]) {
    const r = reduce(state, e);
    assert.equal(r.ok, true);
    state = r.ok ? r.value.state : state;
  }
  const event = {
    type: "TaskCompleted",
    taskId: "T10",
    ts: 4,
    stateRef: { branch: "task/T10", commit: "abc", parentCommit: "def" },
  } as Event;
  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "missing_verification");
});

test("validator rejects TaskCompleted with mismatched verification mode", () => {
  let state = createInitialState();
  const created: Event = {
    type: "TaskCreated",
    taskId: "T20",
    ts: 1,
    title: "Journal task",
    description: "Task for validator tests",
    parentId: null,
    rootId: "T20",
    initialPhase: "execution",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: true,
    metadata: {},
    source: { type: "middle", id: "planner" },
    completionVerificationMode: "journal-only",
  };
  const r = reduce(state, created);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;
  const event: Event = {
    type: "TaskCompleted",
    taskId: "T20",
    ts: 2,
    stateRef: { branch: "task/T20", commit: "abc", parentCommit: "def" },
    verification: completionVerification(2, "T20"),
  };
  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "verification_mode_mismatch");
});

test("validator accepts TaskCompleted with matching proof", () => {
  let state = createInitialState();
  const created: Event = {
    type: "TaskCreated",
    taskId: "T30",
    ts: 1,
    title: "Code task",
    description: "Task for validator tests",
    parentId: null,
    rootId: "T30",
    initialPhase: "execution",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: true,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };
  const r = reduce(state, created);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;
  const event: Event = {
    type: "TaskCompleted",
    taskId: "T30",
    ts: 2,
    stateRef: { branch: "task/T30", commit: "abc", parentCommit: "def" },
    verification: completionVerification(2, "T30"),
  };
  const error = validateEvent(state, event);
  assert.equal(error, null);
});

test("validator rejects coordinator verification with mismatched child counts", () => {
  let state = createInitialState();
  const created: Event = {
    type: "TaskCreated",
    taskId: "T40",
    ts: 1,
    title: "Coordinator task",
    description: "Task for coordinator verification tests",
    parentId: null,
    rootId: "T40",
    initialPhase: "execution",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: true,
    metadata: {},
    source: { type: "middle", id: "planner" },
    completionVerificationMode: "coordinator",
  };
  const r = reduce(state, created);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;

  const event: Event = {
    type: "TaskCompleted",
    taskId: "T40",
    ts: 2,
    stateRef: { branch: "task/T40", commit: "abc", parentCommit: "def" },
    verification: {
      mode: "coordinator",
      verifiedAt: 2,
      proof: {
        kind: "coordinator",
        childTaskIds: ["T40-A", "T40-B"],
        summary: "Child tasks completed",
        allChildrenSucceeded: true,
      },
      result: {
        kind: "coordinator",
        status: "verified",
        childTaskCount: 2,
        successfulChildCount: 1,
        allChildrenSucceeded: true,
      },
    },
  };

  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "invalid_completion_result");
});

test("validator accepts aggregate verification with matching component totals", () => {
  let state = createInitialState();
  const created: Event = {
    type: "TaskCreated",
    taskId: "T50",
    ts: 1,
    title: "Aggregate task",
    description: "Task for aggregate verification tests",
    parentId: null,
    rootId: "T50",
    initialPhase: "execution",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: true,
    metadata: {},
    source: { type: "middle", id: "planner" },
    completionVerificationMode: "aggregate",
  };
  const r = reduce(state, created);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;

  const event: Event = {
    type: "TaskCompleted",
    taskId: "T50",
    ts: 2,
    stateRef: { branch: "task/T50", commit: "abc", parentCommit: "def" },
    verification: {
      mode: "aggregate",
      verifiedAt: 2,
      proof: {
        kind: "aggregate",
        componentResults: [
          { name: "build", status: "succeeded", evidenceRef: "build-123" },
          { name: "docs", status: "skipped" },
          { name: "review", status: "succeeded", evidenceRef: "review-456" },
        ],
        summary: "Critical path tasks finished",
        criticalPathMet: true,
      },
      result: {
        kind: "aggregate",
        status: "verified",
        componentCount: 3,
        succeededCount: 2,
        failedCount: 0,
        skippedCount: 1,
        criticalPathMet: true,
      },
    },
  };

  const error = validateEvent(state, event);
  assert.equal(error, null);
});

// ---------------------------------------------------------------------------
// TaskReparented validation tests
// ---------------------------------------------------------------------------

function twoTaskState(): SystemState {
  let state = createInitialState();

  const parentCreated: Event = {
    type: "TaskCreated",
    taskId: "P1",
    ts: 1,
    title: "Parent",
    description: "Parent task",
    parentId: null,
    rootId: "P1",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
    costBudget: 10,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  const childCreated: Event = {
    type: "TaskCreated",
    taskId: "C1",
    ts: 2,
    title: "Child (self-rooted)",
    description: "Will be reparented",
    parentId: null,
    rootId: "C1",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  for (const e of [parentCreated, childCreated]) {
    const r = reduce(state, e);
    assert.equal(r.ok, true);
    state = r.ok ? r.value.state : state;
  }

  return state;
}

test("TaskReparented: valid reparent of self-rooted task", () => {
  const state = twoTaskState();

  const event: Event = {
    type: "TaskReparented",
    taskId: "C1",
    ts: 10,
    oldParentId: null,
    newParentId: "P1",
    oldRootId: "C1",
    newRootId: "P1",
    source: { type: "middle", id: "test" },
  };

  const error = validateEvent(state, event);
  assert.equal(error, null);
});

test("TaskReparented: self-reparent rejected", () => {
  const state = twoTaskState();

  const event: Event = {
    type: "TaskReparented",
    taskId: "C1",
    ts: 10,
    oldParentId: null,
    newParentId: "C1",
    oldRootId: "C1",
    newRootId: "C1",
    source: { type: "middle", id: "test" },
  };

  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "self_reparent");
});

test("TaskReparented: missing new parent rejected", () => {
  const state = twoTaskState();

  const event: Event = {
    type: "TaskReparented",
    taskId: "C1",
    ts: 10,
    oldParentId: null,
    newParentId: "NONEXISTENT",
    oldRootId: "C1",
    newRootId: "C1",
    source: { type: "middle", id: "test" },
  };

  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "parent_missing");
});

test("TaskReparented: stale oldParentId rejected", () => {
  const state = twoTaskState();

  const event: Event = {
    type: "TaskReparented",
    taskId: "C1",
    ts: 10,
    oldParentId: "P1", // C1 currently has null parent
    newParentId: "P1",
    oldRootId: "C1",
    newRootId: "P1",
    source: { type: "middle", id: "test" },
  };

  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "stale_parent");
});

test("TaskReparented: cycle detection (A→B, reparent B under A)", () => {
  let state = createInitialState();

  // Create A (root) → B (child of A)
  const createA: Event = {
    type: "TaskCreated",
    taskId: "A",
    ts: 1,
    title: "Task A",
    description: "Root",
    parentId: null,
    rootId: "A",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
    costBudget: 10,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  const createB: Event = {
    type: "TaskCreated",
    taskId: "B",
    ts: 2,
    title: "Task B",
    description: "Child of A",
    parentId: "A",
    rootId: "A",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  for (const e of [createA, createB]) {
    const r = reduce(state, e);
    assert.equal(r.ok, true);
    state = r.ok ? r.value.state : state;
  }

  // Try to reparent A under B — would create cycle
  const event: Event = {
    type: "TaskReparented",
    taskId: "A",
    ts: 10,
    oldParentId: null,
    newParentId: "B",
    oldRootId: "A",
    newRootId: "A", // B's rootId is A
    source: { type: "middle", id: "test" },
  };

  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "cycle_detected");
});

// ---------------------------------------------------------------------------
// TaskExhausted + BudgetIncreased validation tests
// ---------------------------------------------------------------------------

function exhaustableState(): SystemState {
  let state = createInitialState();
  const created: Event = {
    type: "TaskCreated",
    taskId: "TX",
    ts: 1,
    title: "Exhaustable",
    description: "Will exhaust",
    parentId: null,
    rootId: "TX",
    initialPhase: "execution",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 1 }, review: { max: 2 } },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: true,
    metadata: {},
    source: { type: "middle", id: "test" },
  };
  const r = reduce(state, created);
  assert.equal(r.ok, true);
  return r.ok ? r.value.state : createInitialState();
}

test("TaskExhausted requires ready or retryWait condition", () => {
  let state = exhaustableState();
  // Move to leased condition
  const leaseEvent: Event = {
    type: "LeaseGranted",
    taskId: "TX",
    ts: 2,
    fenceToken: 1,
    agentId: "coder",
    phase: "execution",
    leaseTimeout: 60_000,
    sessionId: "s-1",
    sessionType: "fresh",
    contextBudget: 512,
  };
  const r = reduce(state, leaseEvent);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;

  const exhaustEvent: Event = {
    type: "TaskExhausted",
    taskId: "TX",
    ts: 3,
    reason: "budget_exhausted",
    phase: "execution",
    source: { type: "core", id: "clock" },
  };
  const error = validateEvent(state, exhaustEvent);
  assert.ok(error);
  assert.equal(error.code, "invalid_condition");
});

test("TaskExhausted phase must match task phase", () => {
  const state = exhaustableState();
  const exhaustEvent: Event = {
    type: "TaskExhausted",
    taskId: "TX",
    ts: 2,
    reason: "budget_exhausted",
    phase: "analysis", // task is in execution
    source: { type: "core", id: "clock" },
  };
  const error = validateEvent(state, exhaustEvent);
  assert.ok(error);
  assert.equal(error.code, "phase_mismatch");
});

test("BudgetIncreased rejected on terminal task", () => {
  let state = exhaustableState();
  // Fail the task
  const failEvent: Event = {
    type: "TaskFailed",
    taskId: "TX",
    ts: 2,
    reason: "budget_exhausted",
    phase: "execution",
    summary: {
      childId: null,
      approach: "exec",
      whatFailed: "ran out",
      whatWasLearned: "need more",
      artifactRef: null,
    },
  };
  const r = reduce(state, failEvent);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;

  const budgetEvent: Event = {
    type: "BudgetIncreased",
    taskId: "TX",
    ts: 3,
    attemptBudgetIncrease: { execution: { max: 6 } },
    costBudgetIncrease: 0,
    reason: "trying to increase on terminal",
    source: { type: "middle", id: "daemon" },
  };
  const error = validateEvent(state, budgetEvent);
  assert.ok(error);
  assert.equal(error.code, "terminal_absorption");
});

test("BudgetIncreased rejects negative cost increase", () => {
  const state = exhaustableState();
  const event: Event = {
    type: "BudgetIncreased",
    taskId: "TX",
    ts: 2,
    attemptBudgetIncrease: null,
    costBudgetIncrease: -5,
    reason: "invalid decrease",
    source: { type: "middle", id: "daemon" },
  };
  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "invalid_cost_increase");
});

test("BudgetIncreased requires non-empty reason", () => {
  const state = exhaustableState();
  const event: Event = {
    type: "BudgetIncreased",
    taskId: "TX",
    ts: 2,
    attemptBudgetIncrease: null,
    costBudgetIncrease: 5,
    reason: "  ",
    source: { type: "middle", id: "daemon" },
  };
  const error = validateEvent(state, event);
  assert.ok(error);
  assert.equal(error.code, "invalid_reason");
});

// ---------------------------------------------------------------------------
// TaskReparented validation tests (continued)
// ---------------------------------------------------------------------------

test("TaskReparented: reparent of terminal task succeeds", () => {
  let state = twoTaskState();

  // Make C1 terminal (failed)
  const failC1: Event = {
    type: "TaskFailed",
    taskId: "C1",
    ts: 5,
    reason: "budget_exhausted",
    phase: "analysis",
    summary: {
      childId: null,
      approach: "initial",
      whatFailed: "ran out of budget",
      whatWasLearned: "need more budget",
      artifactRef: null,
    },
  };

  const r = reduce(state, failC1);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;

  // Should still allow reparenting
  const event: Event = {
    type: "TaskReparented",
    taskId: "C1",
    ts: 10,
    oldParentId: null,
    newParentId: "P1",
    oldRootId: "C1",
    newRootId: "P1",
    source: { type: "middle", id: "test" },
  };

  const error = validateEvent(state, event);
  assert.equal(error, null);
});
