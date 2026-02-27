import test from "node:test";
import assert from "node:assert/strict";

import { reduce } from "../reducer.js";
import { validateEvent } from "../validator.js";
import { createInitialState, type Event, type SystemState } from "../types.js";

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
