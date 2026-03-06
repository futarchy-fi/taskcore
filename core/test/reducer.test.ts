import test from "node:test";
import assert from "node:assert/strict";

import { reduce } from "../reducer.js";
import {
  computeCostRemaining,
  createInitialState,
  type Event,
  type FailureSummary,
  type StateRef,
} from "../types.js";

function summary(): FailureSummary {
  return {
    childId: null,
    approach: "attempted execution",
    whatFailed: "integration error",
    whatWasLearned: "need smaller slices",
    artifactRef: null,
  };
}

function stateRef(): StateRef {
  return {
    branch: "task/T1-test",
    commit: "abc123",
    parentCommit: "abc122",
  };
}

test("reducer applies create -> lease -> phase transition", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated",
      taskId: "T1",
      ts: 1,
      title: "Root task",
      description: "Build feature",
      parentId: null,
      rootId: "T1",
      initialPhase: "analysis",
      initialCondition: "ready",
      attemptBudgets: {
        analysis: { max: 3 },
        decomposition: { max: 2 },
        execution: { max: 3 },
        review: { max: 2 },
      },
      costBudget: 10,
      dependencies: [],
      reviewConfig: { required: true, attemptBudget: 2, isolationRules: [] },
      skipAnalysis: false,
      metadata: {},
      source: { type: "middle", id: "planner" },
    },
    {
      type: "LeaseGranted",
      taskId: "T1",
      ts: 2,
      fenceToken: 1,
      agentId: "analyst",
      phase: "analysis",
      leaseTimeout: 60_000,
      sessionId: "s-1",
      sessionType: "fresh",
      contextBudget: 1024,
      agentContext: {
        sessionId: "s-1",
        agentId: "analyst",
        memoryRef: null,
        contextTokens: 512,
        modelId: "gpt-5",
      },
    },
    {
      type: "PhaseTransition",
      taskId: "T1",
      ts: 4,
      from: { phase: "analysis", condition: "active" },
      to: { phase: "execution", condition: "ready" },
      reasonCode: "decision_execute",
      reason: "small enough",
      fenceToken: 1,
      agentContext: {
        sessionId: "s-1",
        agentId: "analyst",
        memoryRef: null,
        contextTokens: 256,
        modelId: "gpt-5",
      },
    },
  ];

  for (const event of events) {
    const result = reduce(state, event);
    assert.equal(result.ok, true);
    state = result.ok ? result.value.state : state;
  }

  const task = state.tasks.T1;
  assert.ok(task);
  assert.equal(task.phase, "execution");
  assert.equal(task.condition, "ready");
  assert.equal(task.attempts.analysis.used, 1);
  assert.equal(state.sequence, 3);
});

test("child terminal failure summary is accumulated on parent", () => {
  let state = createInitialState();

  const createParent: Event = {
    type: "TaskCreated",
    taskId: "P1",
    ts: 1,
    title: "Parent",
    description: "Parent task",
    parentId: null,
    rootId: "P1",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 3 },
      decomposition: { max: 2 },
      execution: { max: 3 },
      review: { max: 2 },
    },
    costBudget: 10,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };

  const createChild: Event = {
    type: "TaskCreated",
    taskId: "C1",
    ts: 2,
    title: "Child",
    description: "Child task",
    parentId: "P1",
    rootId: "P1",
    initialPhase: "execution",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 2 },
      decomposition: { max: 2 },
      execution: { max: 2 },
      review: { max: 1 },
    },
    costBudget: 4,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: true,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };

  const failChild: Event = {
    type: "TaskFailed",
    taskId: "C1",
    ts: 3,
    reason: "budget_exhausted",
    phase: "execution",
    summary: summary(),
  };

  for (const event of [createParent, createChild, failChild]) {
    const result = reduce(state, event);
    assert.equal(result.ok, true);
    state = result.ok ? result.value.state : state;
  }

  const child = state.tasks.C1;
  const parent = state.tasks.P1;
  assert.ok(child);
  assert.ok(parent);

  assert.equal(child.terminal, "failed");
  assert.equal(parent.failureSummaries.length, 1);
  assert.equal(parent.failureSummaries[0]?.childId, "C1");
});

// ---------------------------------------------------------------------------
// TaskReparented reducer tests
// ---------------------------------------------------------------------------

const budgets = { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } };

test("TaskReparented: basic reparent updates parentId, rootId, parent.children", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "R", ts: 1,
      title: "Root", description: "Root task",
      parentId: null, rootId: "R",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 10,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskCreated", taskId: "O", ts: 2,
      title: "Orphan", description: "Self-rooted orphan",
      parentId: null, rootId: "O",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 5,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskReparented", taskId: "O", ts: 10,
      oldParentId: null, newParentId: "R",
      oldRootId: "O", newRootId: "R",
      source: { type: "middle", id: "test" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const orphan = state.tasks["O"];
  const root = state.tasks["R"];
  assert.ok(orphan);
  assert.ok(root);
  assert.equal(orphan.parentId, "R");
  assert.equal(orphan.rootId, "R");
  assert.ok(root.children.includes("O"));
});

test("TaskReparented: old parent children cleaned up", () => {
  let state = createInitialState();

  // Create old parent → child, then new parent, then reparent child to new parent
  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "OLD", ts: 1,
      title: "Old parent", description: "Was parent",
      parentId: null, rootId: "OLD",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 10,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskCreated", taskId: "CH", ts: 2,
      title: "Child", description: "Child of OLD",
      parentId: "OLD", rootId: "OLD",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 3,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskCreated", taskId: "NEW", ts: 3,
      title: "New parent", description: "Will adopt child",
      parentId: null, rootId: "NEW",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 10,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskReparented", taskId: "CH", ts: 10,
      oldParentId: "OLD", newParentId: "NEW",
      oldRootId: "OLD", newRootId: "NEW",
      source: { type: "middle", id: "test" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  assert.ok(!state.tasks["OLD"]!.children.includes("CH"), "Old parent should not list child");
  assert.ok(state.tasks["NEW"]!.children.includes("CH"), "New parent should list child");
  assert.equal(state.tasks["CH"]!.parentId, "NEW");
  assert.equal(state.tasks["CH"]!.rootId, "NEW");
});

test("TaskReparented: transitive rootId propagation to descendants", () => {
  let state = createInitialState();

  // Create: R1 (root), ORPHAN (self-rooted), GC (grandchild of ORPHAN)
  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "R1", ts: 1,
      title: "New root", description: "Root task",
      parentId: null, rootId: "R1",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 20,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskCreated", taskId: "ORPHAN", ts: 2,
      title: "Orphan parent", description: "Self-rooted, has children",
      parentId: null, rootId: "ORPHAN",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 10,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskCreated", taskId: "GC", ts: 3,
      title: "Grandchild", description: "Child of orphan",
      parentId: "ORPHAN", rootId: "ORPHAN",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 3,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskReparented", taskId: "ORPHAN", ts: 10,
      oldParentId: null, newParentId: "R1",
      oldRootId: "ORPHAN", newRootId: "R1",
      source: { type: "middle", id: "test" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  assert.equal(state.tasks["ORPHAN"]!.rootId, "R1");
  assert.equal(state.tasks["GC"]!.rootId, "R1", "Grandchild rootId should be transitively updated");
});

// ---------------------------------------------------------------------------
// TaskExhausted + BudgetIncreased reducer tests
// ---------------------------------------------------------------------------

test("TaskExhausted sets condition=exhausted, preserves phase, no terminal", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "EX1", ts: 1,
      title: "Exhaustible", description: "Will exhaust",
      parentId: null, rootId: "EX1",
      initialPhase: "execution", initialCondition: "ready",
      attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 1 }, review: { max: 2 } },
      costBudget: 5, dependencies: [], reviewConfig: null, skipAnalysis: true, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskExhausted", taskId: "EX1", ts: 2,
      reason: "budget_exhausted", phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const task = state.tasks["EX1"]!;
  assert.equal(task.condition, "exhausted");
  assert.equal(task.phase, "execution");
  assert.equal(task.terminal, null);
  assert.equal(task.leasedTo, null);
  assert.equal(task.leaseExpiresAt, null);
  assert.equal(task.retryAfter, null);
});

test("BudgetIncreased on exhausted task transitions to ready when sufficient", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "EX2", ts: 1,
      title: "Exhaustible", description: "Will exhaust",
      parentId: null, rootId: "EX2",
      initialPhase: "execution", initialCondition: "ready",
      attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 1 }, review: { max: 2 } },
      costBudget: 5, dependencies: [], reviewConfig: null, skipAnalysis: true, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskExhausted", taskId: "EX2", ts: 2,
      reason: "budget_exhausted", phase: "execution",
      source: { type: "core", id: "clock" },
    },
    {
      type: "BudgetIncreased", taskId: "EX2", ts: 3,
      attemptBudgetIncrease: { execution: { max: 4 } },
      costBudgetIncrease: 0,
      reason: "retry fix applied",
      source: { type: "middle", id: "daemon" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const task = state.tasks["EX2"]!;
  assert.equal(task.condition, "ready");
  assert.equal(task.phase, "execution");
  assert.equal(task.attempts.execution.max, 4);
});

test("BudgetIncreased on non-exhausted task updates budget, keeps condition", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "EX3", ts: 1,
      title: "Active task", description: "Not exhausted",
      parentId: null, rootId: "EX3",
      initialPhase: "execution", initialCondition: "ready",
      attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 2 }, review: { max: 2 } },
      costBudget: 5, dependencies: [], reviewConfig: null, skipAnalysis: true, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "BudgetIncreased", taskId: "EX3", ts: 2,
      attemptBudgetIncrease: { execution: { max: 6 } },
      costBudgetIncrease: 10,
      reason: "preventive increase",
      source: { type: "middle", id: "daemon" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const task = state.tasks["EX3"]!;
  assert.equal(task.condition, "ready");
  assert.equal(task.attempts.execution.max, 6);
  assert.equal(task.cost.allocated, 15);
});

test("BudgetIncreased insufficient keeps task exhausted", () => {
  let state = createInitialState();

  // Create task, lease+start it to use the attempt, then exhaust
  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "EX4", ts: 1,
      title: "Budget exhausted", description: "Will exhaust on attempts",
      parentId: null, rootId: "EX4",
      initialPhase: "execution", initialCondition: "ready",
      attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 1 }, review: { max: 2 } },
      costBudget: 5, dependencies: [], reviewConfig: null, skipAnalysis: true, metadata: {},
      source: { type: "middle", id: "test" },
    },
    // Lease → retry to use up the attempt
    {
      type: "LeaseGranted", taskId: "EX4", ts: 2,
      fenceToken: 1, agentId: "coder", phase: "execution",
      leaseTimeout: 60_000, sessionId: "s-ex4", sessionType: "fresh", contextBudget: 512,
      agentContext: { sessionId: "s-ex4", agentId: "coder", memoryRef: null, contextTokens: 400, modelId: "gpt-5" },
    },
    {
      type: "RetryScheduled", taskId: "EX4", ts: 4,
      fenceToken: 1, reason: "agent_crashed", retryAfter: 5, phase: "execution", attemptNumber: 1,
    },
    {
      type: "BackoffExpired", taskId: "EX4", ts: 5,
      phase: "execution", source: { type: "core", id: "clock" },
    },
    // Now ready with used=1, max=1 → exhaust
    {
      type: "TaskExhausted", taskId: "EX4", ts: 6,
      reason: "budget_exhausted", phase: "execution",
      source: { type: "core", id: "clock" },
    },
    // Increase cost only — not attempts
    {
      type: "BudgetIncreased", taskId: "EX4", ts: 7,
      attemptBudgetIncrease: null,
      costBudgetIncrease: 5,
      reason: "only cost, not attempts",
      source: { type: "middle", id: "daemon" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  // Still exhausted because attempts used(1) >= max(1)
  const task = state.tasks["EX4"]!;
  assert.equal(task.condition, "exhausted");
});

test("Exhausted task: no parent failure summary propagation", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "P_EX", ts: 1,
      title: "Parent", description: "Parent of exhausted child",
      parentId: null, rootId: "P_EX",
      initialPhase: "analysis", initialCondition: "ready",
      attemptBudgets: budgets, costBudget: 20,
      dependencies: [], reviewConfig: null, skipAnalysis: false, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskCreated", taskId: "C_EX", ts: 2,
      title: "Child", description: "Will exhaust",
      parentId: "P_EX", rootId: "P_EX",
      initialPhase: "execution", initialCondition: "ready",
      attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 1 }, review: { max: 2 } },
      costBudget: 5, dependencies: [], reviewConfig: null, skipAnalysis: true, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskExhausted", taskId: "C_EX", ts: 3,
      reason: "budget_exhausted", phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const parent = state.tasks["P_EX"]!;
  assert.equal(parent.failureSummaries.length, 0, "Parent should have no failure summaries from exhaustion");
});

test("Exhausted task can still receive TaskFailed and become terminal", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "EX5", ts: 1,
      title: "Exhaustible", description: "Will exhaust then fail",
      parentId: null, rootId: "EX5",
      initialPhase: "execution", initialCondition: "ready",
      attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 1 }, review: { max: 2 } },
      costBudget: 5, dependencies: [], reviewConfig: null, skipAnalysis: true, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskExhausted", taskId: "EX5", ts: 2,
      reason: "budget_exhausted", phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  // Now fail it explicitly
  const failEvent: Event = {
    type: "TaskFailed", taskId: "EX5", ts: 3,
    reason: "budget_exhausted", phase: "execution",
    summary: summary(),
  };

  // TaskFailed on exhausted should be rejected because condition is not ready/etc.
  // Actually, TaskFailed doesn't check condition in validator — it just checks terminal absorption.
  // Since the task isn't terminal, it should work.
  const r = reduce(state, failEvent);
  assert.equal(r.ok, true, `TaskFailed on exhausted task failed: ${!r.ok ? r.error.message : ""}`);
  state = r.ok ? r.value.state : state;

  const task = state.tasks["EX5"]!;
  assert.equal(task.terminal, "failed");
  assert.equal(task.phase, null);
  assert.equal(task.condition, null);
});

test("Exhausted task can receive TaskCanceled and become terminal", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated", taskId: "EX6", ts: 1,
      title: "Exhaustible", description: "Will exhaust then cancel",
      parentId: null, rootId: "EX6",
      initialPhase: "execution", initialCondition: "ready",
      attemptBudgets: { analysis: { max: 2 }, decomposition: { max: 2 }, execution: { max: 1 }, review: { max: 2 } },
      costBudget: 5, dependencies: [], reviewConfig: null, skipAnalysis: true, metadata: {},
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskExhausted", taskId: "EX6", ts: 2,
      reason: "budget_exhausted", phase: "execution",
      source: { type: "core", id: "clock" },
    },
    {
      type: "TaskCanceled", taskId: "EX6", ts: 3,
      reason: "manual",
      source: { type: "middle", id: "test" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const task = state.tasks["EX6"]!;
  assert.equal(task.terminal, "canceled");
});

// ---------------------------------------------------------------------------
// MetadataUpdated
// ---------------------------------------------------------------------------

test("MetadataUpdated merges patch into task metadata", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated",
      taskId: "M1",
      ts: 1,
      title: "Metadata test",
      description: "Test metadata update",
      parentId: null,
      rootId: "M1",
      initialPhase: "analysis",
      initialCondition: "ready",
      attemptBudgets: { analysis: { max: 3 }, decomposition: { max: 2 }, execution: { max: 3 }, review: { max: 2 } },
      costBudget: 10,
      dependencies: [],
      reviewConfig: null,
      skipAnalysis: false,
      metadata: { priority: "medium", assignee: "coder" },
      source: { type: "middle", id: "test" },
    },
    {
      type: "MetadataUpdated",
      taskId: "M1",
      ts: 2,
      patch: { priority: "critical", reviewer: "hermes" },
      reason: "Urgent reprioritization",
      source: { type: "middle", id: "test" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const task = state.tasks["M1"]!;
  assert.equal(task.metadata["priority"], "critical");
  assert.equal(task.metadata["assignee"], "coder");  // unchanged
  assert.equal(task.metadata["reviewer"], "hermes");  // added
});

test("MetadataUpdated with null value deletes metadata key", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated",
      taskId: "M2",
      ts: 1,
      title: "Metadata delete test",
      description: "Test null removes key",
      parentId: null,
      rootId: "M2",
      initialPhase: "analysis",
      initialCondition: "ready",
      attemptBudgets: { analysis: { max: 3 }, decomposition: { max: 2 }, execution: { max: 3 }, review: { max: 2 } },
      costBudget: 10,
      dependencies: [],
      reviewConfig: null,
      skipAnalysis: false,
      metadata: { priority: "high", consulted: "analyst" },
      source: { type: "middle", id: "test" },
    },
    {
      type: "MetadataUpdated",
      taskId: "M2",
      ts: 2,
      patch: { consulted: null },
      reason: "Remove consulted",
      source: { type: "middle", id: "test" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const task = state.tasks["M2"]!;
  assert.equal(task.metadata["priority"], "high");
  assert.equal(task.metadata["consulted"], undefined);
});

test("MetadataUpdated works on terminal tasks", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated",
      taskId: "M3",
      ts: 1,
      title: "Terminal metadata test",
      description: "Test on completed task",
      parentId: null,
      rootId: "M3",
      initialPhase: "execution",
      initialCondition: "ready",
      attemptBudgets: { analysis: { max: 3 }, decomposition: { max: 2 }, execution: { max: 3 }, review: { max: 2 } },
      costBudget: 10,
      dependencies: [],
      reviewConfig: null,
      skipAnalysis: true,
      metadata: { priority: "low" },
      source: { type: "middle", id: "test" },
    },
    {
      type: "TaskCompleted",
      taskId: "M3",
      ts: 2,
      stateRef: stateRef(),
    },
    {
      type: "MetadataUpdated",
      taskId: "M3",
      ts: 3,
      patch: { priority: "high", notes: "Reclassified after completion" },
      reason: "Post-completion reclassification",
      source: { type: "middle", id: "test" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const task = state.tasks["M3"]!;
  assert.equal(task.terminal, "done");
  assert.equal(task.metadata["priority"], "high");
  assert.equal(task.metadata["notes"], "Reclassified after completion");
});

test("MetadataUpdated rejects invalid priority", () => {
  let state = createInitialState();

  const create: Event = {
    type: "TaskCreated",
    taskId: "M4",
    ts: 1,
    title: "Invalid priority test",
    description: "Test validation",
    parentId: null,
    rootId: "M4",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 3 }, decomposition: { max: 2 }, execution: { max: 3 }, review: { max: 2 } },
    costBudget: 10,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  const r1 = reduce(state, create);
  assert.equal(r1.ok, true);
  state = r1.ok ? r1.value.state : state;

  const bad: Event = {
    type: "MetadataUpdated",
    taskId: "M4",
    ts: 2,
    patch: { priority: "super-urgent" },
    reason: "test",
    source: { type: "middle", id: "test" },
  };

  const r2 = reduce(state, bad);
  assert.equal(r2.ok, false);
  assert.equal(!r2.ok && r2.error.code, "invalid_priority");
});

test("MetadataUpdated rejects empty patch", () => {
  let state = createInitialState();

  const create: Event = {
    type: "TaskCreated",
    taskId: "M5",
    ts: 1,
    title: "Empty patch test",
    description: "Test validation",
    parentId: null,
    rootId: "M5",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 3 }, decomposition: { max: 2 }, execution: { max: 3 }, review: { max: 2 } },
    costBudget: 10,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  const r1 = reduce(state, create);
  assert.equal(r1.ok, true);
  state = r1.ok ? r1.value.state : state;

  const bad: Event = {
    type: "MetadataUpdated",
    taskId: "M5",
    ts: 2,
    patch: {},
    reason: "no changes",
    source: { type: "middle", id: "test" },
  };

  const r2 = reduce(state, bad);
  assert.equal(r2.ok, false);
  assert.equal(!r2.ok && r2.error.code, "empty_patch");
});

test("MetadataUpdated rejects empty reason", () => {
  let state = createInitialState();

  const create: Event = {
    type: "TaskCreated",
    taskId: "M6",
    ts: 1,
    title: "Empty reason test",
    description: "Test validation",
    parentId: null,
    rootId: "M6",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: { analysis: { max: 3 }, decomposition: { max: 2 }, execution: { max: 3 }, review: { max: 2 } },
    costBudget: 10,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  const r1 = reduce(state, create);
  assert.equal(r1.ok, true);
  state = r1.ok ? r1.value.state : state;

  const bad: Event = {
    type: "MetadataUpdated",
    taskId: "M6",
    ts: 2,
    patch: { priority: "high" },
    reason: "  ",
    source: { type: "middle", id: "test" },
  };

  const r2 = reduce(state, bad);
  assert.equal(r2.ok, false);
  assert.equal(!r2.ok && r2.error.code, "invalid_reason");
});
