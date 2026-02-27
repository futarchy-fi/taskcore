import test from "node:test";
import assert from "node:assert/strict";

import { reduce } from "../reducer.js";
import {
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

test("reducer applies create -> lease -> start -> phase transition", () => {
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
    },
    {
      type: "AgentStarted",
      taskId: "T1",
      ts: 3,
      fenceToken: 1,
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
  assert.equal(state.sequence, 4);
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
