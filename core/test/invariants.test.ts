import test from "node:test";
import assert from "node:assert/strict";

import { checkInvariants } from "../invariants.js";
import { reduce } from "../reducer.js";
import { createInitialState, type Event } from "../types.js";

test("invariants pass for valid minimal state", () => {
  const create: Event = {
    type: "TaskCreated",
    taskId: "T20",
    ts: 1,
    title: "Invariant task",
    description: "Invariant baseline",
    parentId: null,
    rootId: "T20",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 2 },
      decomposition: { max: 2 },
      execution: { max: 2 },
      review: { max: 2 },
    },
    costBudget: 3,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };

  const result = reduce(createInitialState(), create);
  assert.equal(result.ok, true);
  const state = result.ok ? result.value.state : createInitialState();

  const violations = checkInvariants(state);
  assert.deepEqual(violations, []);
});

// ---------------------------------------------------------------------------
// Exhausted invariant tests
// ---------------------------------------------------------------------------

test("exhausted task with lingering lease triggers exhausted_dangling_lease", () => {
  const create: Event = {
    type: "TaskCreated",
    taskId: "T_EX_INV",
    ts: 1,
    title: "Exhausted inv test",
    description: "Test exhausted invariant",
    parentId: null,
    rootId: "T_EX_INV",
    initialPhase: "execution",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 2 },
      decomposition: { max: 2 },
      execution: { max: 1 },
      review: { max: 2 },
    },
    costBudget: 5,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: true,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };

  const result = reduce(createInitialState(), create);
  assert.equal(result.ok, true);
  const state = result.ok ? result.value.state : createInitialState();

  // Tamper: set to exhausted but leave lease fields populated
  const tampered = structuredClone(state);
  const task = tampered.tasks["T_EX_INV"];
  assert.ok(task);
  task.condition = "exhausted";
  task.leasedTo = "some-agent";
  task.leaseExpiresAt = 99999;

  const violations = checkInvariants(tampered);
  assert.ok(violations.some((v) => v.code === "exhausted_dangling_lease"));
});

test("properly formed exhausted task has zero violations", () => {
  let state = createInitialState();

  const events: Event[] = [
    {
      type: "TaskCreated",
      taskId: "T_EX_OK",
      ts: 1,
      title: "Clean exhausted task",
      description: "Should pass invariants",
      parentId: null,
      rootId: "T_EX_OK",
      initialPhase: "execution",
      initialCondition: "ready",
      attemptBudgets: {
        analysis: { max: 2 },
        decomposition: { max: 2 },
        execution: { max: 1 },
        review: { max: 2 },
      },
      costBudget: 5,
      dependencies: [],
      reviewConfig: null,
      skipAnalysis: true,
      metadata: {},
      source: { type: "middle", id: "planner" },
    },
    {
      type: "TaskExhausted",
      taskId: "T_EX_OK",
      ts: 2,
      reason: "budget_exhausted",
      phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  for (const e of events) {
    const r = reduce(state, e);
    assert.equal(r.ok, true, `Event ${e.type} failed: ${!r.ok ? r.error.message : ""}`);
    state = r.ok ? r.value.state : state;
  }

  const violations = checkInvariants(state);
  assert.deepEqual(violations, []);
});

test("invariants detect terminal shape violations", () => {
  const create: Event = {
    type: "TaskCreated",
    taskId: "T21",
    ts: 1,
    title: "Invariant break",
    description: "Invariant break baseline",
    parentId: null,
    rootId: "T21",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 2 },
      decomposition: { max: 2 },
      execution: { max: 2 },
      review: { max: 2 },
    },
    costBudget: 3,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };

  const created = reduce(createInitialState(), create);
  assert.equal(created.ok, true);
  const state = created.ok ? created.value.state : createInitialState();

  const tampered = structuredClone(state);
  const task = tampered.tasks.T21;
  assert.ok(task);
  task.terminal = "done";
  task.phase = "review";

  const violations = checkInvariants(tampered);
  assert.ok(violations.some((v) => v.code === "terminal_shape"));
});
