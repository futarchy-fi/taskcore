import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CoreClock } from "../clock.js";
import { createCore } from "../index.js";
import { checkInvariants } from "../invariants.js";
import { reduce, replay } from "../reducer.js";
import {
  computeCostRemaining,
  createInitialState,
  type Condition,
  type Event,
  type FailureSummary,
  type Phase,
  type SystemState,
} from "../types.js";


type ReviewConfigInput = {
  required: boolean;
  attemptBudget: number;
  isolationRules: { exclude: string; reason: string }[];
} | null;
const defaultBudgets = {
  analysis: { max: 6 },
  decomposition: { max: 6 },
  execution: { max: 6 },
  review: { max: 6 },
};

function failureSummary(artifactRef: { branch: string; commit: string; parentCommit: string } | null = null): FailureSummary {
  return {
    childId: null,
    approach: "attempted approach",
    whatFailed: "approach failed",
    whatWasLearned: "need alternate strategy",
    artifactRef,
  };
}
function createTask(
  taskId: string,
  ts: number,
  options?: {
    parentId?: string | null;
    rootId?: string;
    initialPhase?: Phase;
    initialCondition?: Condition;
    attemptBudgets?: typeof defaultBudgets;
    costBudget?: number;
    reviewConfig?: ReviewConfigInput;
    skipAnalysis?: boolean;
  },
): Event {
  return {
    type: "TaskCreated",
    taskId,
    ts,
    title: `Task ${taskId}`,
    description: `Scenario task ${taskId}`,
    parentId: options?.parentId ?? null,
    rootId: options?.rootId ?? taskId,
    initialPhase: options?.initialPhase ?? "analysis",
    initialCondition: options?.initialCondition ?? "ready",
    attemptBudgets: options?.attemptBudgets ?? defaultBudgets,
    costBudget: options?.costBudget ?? 100,
    dependencies: [],
    reviewConfig: options?.reviewConfig ?? null,
    skipAnalysis: options?.skipAnalysis ?? false,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };
}

function lease(
  taskId: string,
  ts: number,
  fenceToken: number,
  phase: Phase,
  agentId: string,
  sessionId: string,
  sessionType: "fresh" | "continued" = "fresh",
): Event {
  return {
    type: "LeaseGranted",
    taskId,
    ts,
    fenceToken,
    agentId,
    phase,
    leaseTimeout: 60_000,
    sessionId,
    sessionType,
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

function exited(taskId: string, ts: number, fenceToken: number, agentId: string, sessionId: string, reportedCost: number): Event {
  return {
    type: "AgentExited",
    taskId,
    ts,
    fenceToken,
    exitCode: 0,
    reportedCost,
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
  fromPhase: Phase,
  fromCondition: Condition,
  toPhase: Phase,
  toCondition: Condition,
  reasonCode:
    | "decision_execute"
    | "decision_decompose"
    | "work_complete"
    | "too_complex"
    | "approach_not_viable"
    | "changes_requested"
    | "wrong_approach"
    | "needs_redecomp"
    | "add_children"
    | "children_created"
    | "children_complete"
    | "children_all_failed",
  fenceToken: number,
  agentId: string,
  sessionId: string,
): Event {
  return {
    type: "PhaseTransition",
    taskId,
    ts,
    from: { phase: fromPhase, condition: fromCondition },
    to: { phase: toPhase, condition: toCondition },
    reasonCode,
    reason: reasonCode,
    fenceToken,
    agentContext: {
      sessionId,
      agentId,
      memoryRef: null,
      contextTokens: 200,
      modelId: "gpt-5",
    },
  };
}

function reviewVerdict(
  taskId: string,
  ts: number,
  fenceToken: number,
  reviewer: string,
  sessionId: string,
  verdict: "approve" | "changes_requested" | "reject" | "needs_discussion",
): Event {
  return {
    type: "ReviewVerdictSubmitted",
    taskId,
    ts,
    fenceToken,
    reviewer,
    round: 1,
    verdict,
    reasoning: `verdict=${verdict}`,
    agentContext: {
      sessionId,
      agentId: reviewer,
      memoryRef: null,
      contextTokens: 300,
      modelId: "gpt-5",
    },
  };
}

function reviewPolicy(taskId: string, ts: number, outcome: "approved" | "changes_requested" | "escalated"): Event {
  return {
    type: "ReviewPolicyMet",
    taskId,
    ts,
    outcome,
    summary: outcome,
    source: { type: "middle", id: "review" },
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
    verification: {
      mode: "code-task",
      verifiedAt: ts,
      proof: {
        kind: "code-task",
        commitRef: `c-${taskId}-${ts}`,
        changedFiles: ["src/index.ts"],
        testsPassed: true,
      },
    },
  };
}

function mustReplay(events: Event[]): SystemState {
  const result = replay(events);
  if (!result.ok) {
    assert.fail(result.error.message);
  }
  return result.value;
}

function mustReduce(state: SystemState, event: Event): SystemState {
  const result = reduce(state, event);
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.value.state;
}
function mustReject(state: SystemState, event: Event, expectedCode: string): void {
  const result = reduce(state, event);
  assert.equal(result.ok, false);
  if (result.ok) {
    return;
  }
  assert.equal(result.error.code, expectedCode);
}

function sumConsumed(state: SystemState, taskIds: string[]): number {
  return taskIds.reduce((sum, taskId) => sum + (state.tasks[taskId]?.cost.consumed ?? 0), 0);
}

function sumRemaining(state: SystemState, taskIds: string[]): number {
  return taskIds.reduce((sum, taskId) => {
    const task = state.tasks[taskId];
    if (!task) {
      return sum;
    }
    return sum + computeCostRemaining(task.cost);
  }, 0);
}

function reviewConfigRequired() {
  return { required: true, attemptBudget: 3, isolationRules: [] };
}

test("Scenario A: review reject -> revise -> approve", () => {
  const events: Event[] = [
    createTask("T100", 1, { reviewConfig: reviewConfigRequired() }),
    lease("T100", 2, 1, "analysis", "analyst", "a-1"),
    started("T100", 3, 1, "analyst", "a-1"),
    transition("T100", 4, "analysis", "active", "execution", "ready", "decision_execute", 1, "analyst", "a-1"),

    lease("T100", 5, 2, "execution", "coder", "e-1"),
    started("T100", 6, 2, "coder", "e-1"),
    exited("T100", 7, 2, "coder", "e-1", 2),
    transition("T100", 8, "execution", "active", "review", "ready", "work_complete", 2, "coder", "e-1"),

    lease("T100", 9, 3, "review", "reviewer", "r-1"),
    started("T100", 10, 3, "reviewer", "r-1"),
    reviewVerdict("T100", 11, 3, "reviewer", "r-1", "changes_requested"),
    reviewPolicy("T100", 12, "changes_requested"),
    transition("T100", 13, "review", "active", "execution", "ready", "changes_requested", 3, "reviewer", "r-1"),

    lease("T100", 14, 4, "execution", "coder", "e-2"),
    started("T100", 15, 4, "coder", "e-2"),
    exited("T100", 16, 4, "coder", "e-2", 1),
    transition("T100", 17, "execution", "active", "review", "ready", "work_complete", 4, "coder", "e-2"),

    lease("T100", 18, 5, "review", "reviewer", "r-2"),
    started("T100", 19, 5, "reviewer", "r-2"),
    reviewVerdict("T100", 20, 5, "reviewer", "r-2", "approve"),
    reviewPolicy("T100", 21, "approved"),
    complete("T100", 22),
  ];

  const state = mustReplay(events);
  const task = state.tasks.T100;
  assert.ok(task);
  assert.equal(task.terminal, "done");
  assert.equal(task.attempts.review.used, 2);
  assert.equal(task.attempts.execution.used, 2);
});

test("Scenario B: decomposition -> children complete -> integration review -> done", () => {
  const prefix: Event[] = [
    createTask("T200", 1, { reviewConfig: reviewConfigRequired(), costBudget: 50 }),
    lease("T200", 2, 1, "analysis", "analyst", "a-200"),
    started("T200", 3, 1, "analyst", "a-200"),
    transition("T200", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-200"),

    lease("T200", 5, 2, "decomposition", "decomposer", "d-200"),
    started("T200", 6, 2, "decomposer", "d-200"),
    {
      type: "DecompositionCreated",
      taskId: "T200",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T201",
          title: "Child 1",
          description: "Child 1",
          costAllocation: 10,
          skipAnalysis: true,
          dependencies: [],
          reviewConfig: reviewConfigRequired(),
        },
        {
          taskId: "T202",
          title: "Child 2",
          description: "Child 2",
          costAllocation: 10,
          skipAnalysis: true,
          dependencies: [],
          reviewConfig: reviewConfigRequired(),
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-200",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 500,
        modelId: "gpt-5",
      },
    },
    transition("T200", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-200"),

    lease("T201", 9, 1, "execution", "coder", "e-201"),
    started("T201", 10, 1, "coder", "e-201"),
    exited("T201", 11, 1, "coder", "e-201", 2),
    transition("T201", 12, "execution", "active", "review", "ready", "work_complete", 1, "coder", "e-201"),
    lease("T201", 13, 2, "review", "reviewer", "r-201"),
    started("T201", 14, 2, "reviewer", "r-201"),
    reviewVerdict("T201", 15, 2, "reviewer", "r-201", "approve"),
    reviewPolicy("T201", 16, "approved"),
    complete("T201", 17),

    lease("T202", 18, 1, "execution", "coder", "e-202"),
    started("T202", 19, 1, "coder", "e-202"),
    exited("T202", 20, 1, "coder", "e-202", 2),
    transition("T202", 21, "execution", "active", "review", "ready", "work_complete", 1, "coder", "e-202"),
    lease("T202", 22, 2, "review", "reviewer", "r-202"),
    started("T202", 23, 2, "reviewer", "r-202"),
    reviewVerdict("T202", 24, 2, "reviewer", "r-202", "approve"),
    reviewPolicy("T202", 25, "approved"),
    complete("T202", 26),
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();

  const due = clock.collectDueEvents(state, 30);
  const childrenComplete = due.find(
    (event) =>
      event.type === "PhaseTransition" &&
      event.taskId === "T200" &&
      event.reasonCode === "children_complete",
  );
  assert.ok(childrenComplete, "expected children_complete auto transition");

  for (const event of due) {
    state = mustReduce(state, event);
  }

  const dueAfter = clock.collectDueEvents(state, 31);
  assert.equal(
    dueAfter.some(
      (event) =>
        event.type === "PhaseTransition" &&
        event.taskId === "T200" &&
        event.reasonCode === "children_complete",
    ),
    false,
  );

  const suffix: Event[] = [
    lease("T200", 32, 3, "review", "reviewer", "r-200"),
    started("T200", 33, 3, "reviewer", "r-200"),
    reviewVerdict("T200", 34, 3, "reviewer", "r-200", "approve"),
    reviewPolicy("T200", 35, "approved"),
    complete("T200", 36),
  ];

  for (const event of suffix) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T200?.terminal, "done");
  assert.equal(state.tasks.T201?.terminal, "done");
  assert.equal(state.tasks.T202?.terminal, "done");
  assert.equal(state.tasks.T200?.cost.childAllocated, 20);
  assert.equal(state.tasks.T200?.decompositionVersion, 1);
  assert.equal(state.tasks.T200?.approachHistory[0]?.outcome, "succeeded");
});

test("Scenario C: cost conservation across tree", () => {
  const events: Event[] = [
    createTask("T300", 1, { costBudget: 50 }),
    lease("T300", 2, 1, "analysis", "analyst", "a-300"),
    started("T300", 3, 1, "analyst", "a-300"),
    transition("T300", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-300"),

    lease("T300", 5, 2, "decomposition", "decomposer", "d-300"),
    started("T300", 6, 2, "decomposer", "d-300"),
    {
      type: "DecompositionCreated",
      taskId: "T300",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T301",
          title: "Child 301",
          description: "Child 301",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T302",
          title: "Child 302",
          description: "Child 302",
          costAllocation: 15,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-300",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T300", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-300"),

    lease("T301", 9, 1, "execution", "coder", "e-301"),
    started("T301", 10, 1, "coder", "e-301"),
    exited("T301", 11, 1, "coder", "e-301", 3),
    complete("T301", 12),
    {
      type: "ChildCostRecovered",
      taskId: "T300",
      ts: 13,
      childId: "T301",
      recoveredAmount: 17,
      source: { type: "core", id: "clock" },
    },

    lease("T302", 14, 1, "execution", "coder", "e-302"),
    started("T302", 15, 1, "coder", "e-302"),
    exited("T302", 16, 1, "coder", "e-302", 5),
    complete("T302", 17),
    {
      type: "ChildCostRecovered",
      taskId: "T300",
      ts: 18,
      childId: "T302",
      recoveredAmount: 10,
      source: { type: "core", id: "clock" },
    },
  ];

  const state = mustReplay(events);
  const root = state.tasks.T300;
  assert.ok(root);

  assert.equal(root.cost.allocated, 50);
  assert.equal(root.cost.childAllocated, 35);
  assert.equal(root.cost.childRecovered, 27);
  assert.equal(computeCostRemaining(root.cost), 50 - root.cost.consumed - 35 + 27);

  const taskIds = ["T300", "T301", "T302"];
  const consumed = sumConsumed(state, taskIds);
  const remaining = sumRemaining(state, taskIds);
  assert.equal(consumed, (state.tasks.T300?.cost.consumed ?? 0) + 3 + 5);
  assert.equal(consumed + remaining, 50);
});

test("Scenario D: checkpoint triggers parent re-analysis", () => {
  const prefix: Event[] = [
    createTask("T400", 1, { reviewConfig: reviewConfigRequired(), costBudget: 40 }),
    lease("T400", 2, 1, "analysis", "analyst", "a-400"),
    started("T400", 3, 1, "analyst", "a-400"),
    transition("T400", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-400"),

    lease("T400", 5, 2, "decomposition", "decomposer", "d-400"),
    started("T400", 6, 2, "decomposer", "d-400"),
    {
      type: "DecompositionCreated",
      taskId: "T400",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T401",
          title: "Checkpoint child",
          description: "Checkpoint child",
          costAllocation: 10,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T402",
          title: "Regular child",
          description: "Regular child",
          costAllocation: 10,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: ["T401"],
      completionRule: "and",
      agentContext: {
        sessionId: "d-400",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T400", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-400"),

    lease("T401", 9, 1, "execution", "coder", "e-401"),
    started("T401", 10, 1, "coder", "e-401"),
    exited("T401", 11, 1, "coder", "e-401", 2),
    complete("T401", 12),
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();

  const dueAfterCheckpoint = clock.collectDueEvents(state, 13);
  assert.ok(
    dueAfterCheckpoint.some(
      (event) => event.type === "CheckpointTriggered" && event.taskId === "T400" && event.childId === "T401",
    ),
  );
  for (const event of dueAfterCheckpoint) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T400?.phase, "analysis");
  assert.equal(state.tasks.T400?.condition, "ready");
  assert.equal(state.tasks.T400?.attempts.analysis.used, 1);

  const continuation: Event[] = [
    lease("T400", 20, 3, "analysis", "analyst", "a-401"),
    started("T400", 21, 3, "analyst", "a-401"),
    transition("T400", 22, "analysis", "active", "decomposition", "ready", "decision_decompose", 3, "analyst", "a-401"),
    lease("T400", 23, 4, "decomposition", "decomposer", "d-401"),
    started("T400", 24, 4, "decomposer", "d-401"),
    transition("T400", 25, "decomposition", "active", "review", "waiting", "children_created", 4, "decomposer", "d-401"),

    lease("T402", 26, 1, "execution", "coder", "e-402"),
    started("T402", 27, 1, "coder", "e-402"),
    exited("T402", 28, 1, "coder", "e-402", 2),
    complete("T402", 29),
  ];

  for (const event of continuation) {
    state = mustReduce(state, event);
  }

  const dueAfterSecondChild = clock.collectDueEvents(state, 30);
  assert.ok(
    dueAfterSecondChild.some(
      (event) =>
        event.type === "PhaseTransition" &&
        event.taskId === "T400" &&
        event.reasonCode === "children_complete",
    ),
  );
  for (const event of dueAfterSecondChild) {
    state = mustReduce(state, event);
  }

  state = mustReduce(state, lease("T400", 31, 5, "review", "reviewer", "r-400"));
  state = mustReduce(state, started("T400", 32, 5, "reviewer", "r-400"));
  state = mustReduce(state, reviewVerdict("T400", 33, 5, "reviewer", "r-400", "approve"));
  state = mustReduce(state, reviewPolicy("T400", 34, "approved"));
  state = mustReduce(state, complete("T400", 35));

  assert.equal(state.tasks.T400?.terminal, "done");
  assert.ok((state.tasks.T400?.attempts.analysis.used ?? 0) >= 2);
});

test("Scenario E: execution -> too_complex -> re-analysis -> decompose", () => {
  const events: Event[] = [
    createTask("T500", 1, { costBudget: 30 }),
    lease("T500", 2, 1, "analysis", "analyst", "a-500"),
    started("T500", 3, 1, "analyst", "a-500"),
    transition("T500", 4, "analysis", "active", "execution", "ready", "decision_execute", 1, "analyst", "a-500"),

    lease("T500", 5, 2, "execution", "coder", "e-500"),
    started("T500", 6, 2, "coder", "e-500"),
    transition("T500", 7, "execution", "active", "analysis", "ready", "too_complex", 2, "coder", "e-500"),

    lease("T500", 8, 3, "analysis", "analyst", "a-501"),
    started("T500", 9, 3, "analyst", "a-501"),
    transition("T500", 10, "analysis", "active", "decomposition", "ready", "decision_decompose", 3, "analyst", "a-501"),

    lease("T500", 11, 4, "decomposition", "decomposer", "d-500"),
    started("T500", 12, 4, "decomposer", "d-500"),
    {
      type: "DecompositionCreated",
      taskId: "T500",
      ts: 13,
      fenceToken: 4,
      version: 1,
      children: [
        {
          taskId: "T501",
          title: "Child 501",
          description: "Child 501",
          costAllocation: 10,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-500",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T500", 14, "decomposition", "active", "review", "waiting", "children_created", 4, "decomposer", "d-500"),

    lease("T501", 15, 1, "execution", "coder", "e-501"),
    started("T501", 16, 1, "coder", "e-501"),
    exited("T501", 17, 1, "coder", "e-501", 1),
    complete("T501", 18),

    {
      type: "PhaseTransition",
      taskId: "T500",
      ts: 19,
      from: { phase: "review", condition: "waiting" },
      to: { phase: "review", condition: "ready" },
      reasonCode: "children_complete",
      reason: "All children reached terminal state",
      fenceToken: 4,
      agentContext: {
        sessionId: "core",
        agentId: "core",
        memoryRef: null,
        contextTokens: null,
        modelId: "core",
      },
    },
    complete("T500", 20),
  ];

  const state = mustReplay(events);
  const task = state.tasks.T500;
  assert.ok(task);
  assert.equal(task.terminal, "done");
  assert.ok(task.attempts.analysis.used >= 2);
  assert.ok(task.attempts.execution.used >= 1);
});

test("Scenario F: task exhaustion from budget exhaustion", () => {
  const prefix: Event[] = [
    createTask("T600", 1, {
      costBudget: 100,
      attemptBudgets: {
        analysis: { max: 3 },
        decomposition: { max: 2 },
        execution: { max: 2 },
        review: { max: 2 },
      },
    }),
    lease("T600", 2, 1, "analysis", "analyst", "a-600"),
    started("T600", 3, 1, "analyst", "a-600"),
    transition("T600", 4, "analysis", "active", "execution", "ready", "decision_execute", 1, "analyst", "a-600"),

    lease("T600", 5, 2, "execution", "coder", "e-601"),
    started("T600", 6, 2, "coder", "e-601"),
    {
      type: "RetryScheduled",
      taskId: "T600",
      ts: 7,
      fenceToken: 2,
      reason: "agent_crashed",
      retryAfter: 8,
      phase: "execution",
      attemptNumber: 1,
    },
    {
      type: "BackoffExpired",
      taskId: "T600",
      ts: 8,
      phase: "execution",
      source: { type: "core", id: "clock" },
    },

    lease("T600", 9, 3, "execution", "coder", "e-602"),
    started("T600", 10, 3, "coder", "e-602"),
    {
      type: "RetryScheduled",
      taskId: "T600",
      ts: 11,
      fenceToken: 3,
      reason: "agent_crashed",
      retryAfter: 12,
      phase: "execution",
      attemptNumber: 2,
    },
    {
      type: "BackoffExpired",
      taskId: "T600",
      ts: 12,
      phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  let state = mustReplay(prefix);
  mustReject(
    state,
    lease("T600", 13, 4, "execution", "coder", "e-603"),
    "attempt_budget_exhausted",
  );

  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 14);
  const exhaustEvent = due.find((event) => event.type === "TaskExhausted" && event.taskId === "T600");
  assert.ok(exhaustEvent);

  for (const event of due) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T600?.condition, "exhausted");
  assert.equal(state.tasks.T600?.terminal, null);
});

test("Scenario G: session policy enforcement", () => {
  let state = createInitialState();

  // T700: continued execution allowed after prior execution attempt.
  state = mustReduce(state, createTask("T700", 1));
  state = mustReduce(state, lease("T700", 2, 1, "analysis", "analyst", "a-700", "fresh"));
  state = mustReduce(state, started("T700", 3, 1, "analyst", "a-700"));
  state = mustReduce(
    state,
    transition("T700", 4, "analysis", "active", "execution", "ready", "decision_execute", 1, "analyst", "a-700"),
  );

  state = mustReduce(state, lease("T700", 5, 2, "execution", "coder", "e-700", "fresh"));
  state = mustReduce(state, started("T700", 6, 2, "coder", "e-700"));
  state = mustReduce(state, {
    type: "RetryScheduled",
    taskId: "T700",
    ts: 7,
    fenceToken: 2,
    reason: "no_progress",
    retryAfter: 8,
    phase: "execution",
    attemptNumber: 1,
  });
  state = mustReduce(state, {
    type: "BackoffExpired",
    taskId: "T700",
    ts: 8,
    phase: "execution",
    source: { type: "core", id: "clock" },
  });
  state = mustReduce(state, lease("T700", 9, 3, "execution", "coder", "e-700", "continued"));

  // T701: analysis requires fresh sessions.
  state = mustReduce(state, createTask("T701", 20));
  mustReject(
    state,
    lease("T701", 21, 1, "analysis", "analyst", "a-701", "continued"),
    "session_policy_violation",
  );

  // T702: first execution lease cannot be continued.
  state = mustReduce(state, createTask("T702", 30));
  state = mustReduce(state, lease("T702", 31, 1, "analysis", "analyst", "a-702", "fresh"));
  state = mustReduce(state, started("T702", 32, 1, "analyst", "a-702"));
  state = mustReduce(
    state,
    transition("T702", 33, "analysis", "active", "execution", "ready", "decision_execute", 1, "analyst", "a-702"),
  );
  mustReject(
    state,
    lease("T702", 34, 2, "execution", "coder", "e-702", "continued"),
    "missing_prior_session",
  );
});

test("Scenario H: terminal absorption rejects any further mutation", () => {
  let state = createInitialState();
  state = mustReduce(
    state,
    createTask("T800", 1, {
      initialPhase: "execution",
      skipAnalysis: true,
      reviewConfig: null,
    }),
  );
  state = mustReduce(state, complete("T800", 2));

  mustReject(state, lease("T800", 3, 1, "execution", "coder", "e-800"), "terminal_absorption");
  mustReject(
    state,
    {
      type: "TaskFailed",
      taskId: "T800",
      ts: 4,
      reason: "budget_exhausted",
      phase: "execution",
      summary: failureSummary(),
    },
    "terminal_absorption",
  );
  mustReject(
    state,
    transition("T800", 5, "execution", "active", "analysis", "ready", "too_complex", 1, "coder", "e-800"),
    "terminal_absorption",
  );
});

test("Scenario I: fence token enforcement", () => {
  let state = createInitialState();
  state = mustReduce(state, createTask("T900", 1, { initialPhase: "execution", skipAnalysis: true }));
  state = mustReduce(state, lease("T900", 2, 1, "execution", "coder", "e-900"));
  state = mustReduce(state, started("T900", 3, 1, "coder", "e-900"));
  state = mustReduce(state, {
    type: "RetryScheduled",
    taskId: "T900",
    ts: 4,
    fenceToken: 1,
    reason: "no_progress",
    retryAfter: 5,
    phase: "execution",
    attemptNumber: 1,
  });
  state = mustReduce(state, {
    type: "BackoffExpired",
    taskId: "T900",
    ts: 5,
    phase: "execution",
    source: { type: "core", id: "clock" },
  });
  state = mustReduce(state, lease("T900", 6, 2, "execution", "coder", "e-901"));
  state = mustReduce(state, started("T900", 7, 2, "coder", "e-901"));

  mustReject(state, exited("T900", 8, 1, "coder", "e-900", 1), "stale_fence_token");
  state = mustReduce(state, exited("T900", 9, 2, "coder", "e-901", 1));
  assert.equal(state.tasks.T900?.cost.consumed, 1);
});

test("Scenario J: wait/consultation flow", () => {
  const events: Event[] = [
    createTask("T1000", 1),
    lease("T1000", 2, 1, "analysis", "analyst", "a-1000"),
    started("T1000", 3, 1, "analyst", "a-1000"),
    transition("T1000", 4, "analysis", "active", "execution", "ready", "decision_execute", 1, "analyst", "a-1000"),

    lease("T1000", 5, 2, "execution", "coder", "e-1000"),
    started("T1000", 6, 2, "coder", "e-1000"),
    {
      type: "WaitRequested",
      taskId: "T1000",
      ts: 7,
      fenceToken: 2,
      dependency: {
        id: "dep-consult-1",
        type: "consultation",
        target: "analyst",
        blocking: true,
        timing: "during",
        status: "pending",
      },
      returnPhase: "execution",
      returnCondition: "active",
      agentContext: {
        sessionId: "e-1000",
        agentId: "coder",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    {
      type: "WaitResolved",
      taskId: "T1000",
      ts: 8,
      dependencyId: "dep-consult-1",
      resolution: "fulfilled",
      action: "resume",
      payload: "answer",
      source: { type: "middle", id: "consultation" },
    },

    exited("T1000", 9, 2, "coder", "e-1000", 1),
    transition("T1000", 10, "execution", "active", "review", "ready", "work_complete", 2, "coder", "e-1000"),
    complete("T1000", 11),
  ];

  const state = mustReplay(events);
  const task = state.tasks.T1000;
  assert.ok(task);
  assert.equal(task.terminal, "done");
  const dep = task.dependencies.find((dependency) => dependency.id === "dep-consult-1");
  assert.ok(dep);
  assert.equal(dep.status, "fulfilled");
});

test("Scenario K: WaitResolved redirect_to_analysis", () => {
  const events: Event[] = [
    createTask("T1100", 1, { initialPhase: "execution", skipAnalysis: true }),
    lease("T1100", 2, 1, "execution", "coder", "e-1100"),
    started("T1100", 3, 1, "coder", "e-1100"),
    {
      type: "WaitRequested",
      taskId: "T1100",
      ts: 4,
      fenceToken: 1,
      dependency: {
        id: "dep-consult-2",
        type: "consultation",
        target: "analyst",
        blocking: true,
        timing: "during",
        status: "pending",
      },
      returnPhase: "execution",
      returnCondition: "active",
      agentContext: {
        sessionId: "e-1100",
        agentId: "coder",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    {
      type: "WaitResolved",
      taskId: "T1100",
      ts: 5,
      dependencyId: "dep-consult-2",
      resolution: "redirected",
      action: "redirect_to_analysis",
      payload: "need different approach",
      source: { type: "middle", id: "consultation" },
    },
  ];

  const state = mustReplay(events);
  const task = state.tasks.T1100;
  assert.ok(task);
  assert.equal(task.phase, "analysis");
  assert.equal(task.condition, "ready");
});

test("Scenario L: proactive cost exhaustion pauses task as exhausted", () => {
  const events: Event[] = [
    createTask("T1200", 1, { costBudget: 1 }),
    lease("T1200", 2, 1, "analysis", "analyst", "a-1200"),
    started("T1200", 3, 1, "analyst", "a-1200"),
    transition("T1200", 4, "analysis", "active", "execution", "ready", "decision_execute", 1, "analyst", "a-1200"),
    lease("T1200", 5, 2, "execution", "coder", "e-1200"),
    started("T1200", 6, 2, "coder", "e-1200"),
    exited("T1200", 7, 2, "coder", "e-1200", 1),
    transition("T1200", 8, "execution", "active", "analysis", "ready", "too_complex", 2, "coder", "e-1200"),
  ];

  let state = mustReplay(events);
  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 9);
  const exhaustEvent = due.find(
    (event) => event.type === "TaskExhausted" && event.taskId === "T1200" && event.reason === "cost_exhausted",
  );
  assert.ok(exhaustEvent);

  for (const event of due) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T1200?.condition, "exhausted");
  assert.equal(state.tasks.T1200?.terminal, null);
});

test("Scenario M: ChildCostRecovered auto-emission and single-shot recovery", () => {
  const prefix: Event[] = [
    createTask("T1200", 1, { costBudget: 100 }),
    lease("T1200", 2, 1, "analysis", "analyst", "a-1200"),
    started("T1200", 3, 1, "analyst", "a-1200"),
    transition("T1200", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-1200"),
    lease("T1200", 5, 2, "decomposition", "decomposer", "d-1200"),
    started("T1200", 6, 2, "decomposer", "d-1200"),
    {
      type: "DecompositionCreated",
      taskId: "T1200",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T1201",
          title: "Child 1201",
          description: "Child 1201",
          costAllocation: 40,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T1202",
          title: "Child 1202",
          description: "Child 1202",
          costAllocation: 30,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-1200",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T1200", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-1200"),

    lease("T1201", 9, 1, "execution", "coder", "e-1201"),
    started("T1201", 10, 1, "coder", "e-1201"),
    exited("T1201", 11, 1, "coder", "e-1201", 10),
    complete("T1201", 12),
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();

  const dueAfterFirstChild = clock.collectDueEvents(state, 13);
  const recoverFirst = dueAfterFirstChild.find(
    (event): event is Extract<Event, { type: "ChildCostRecovered" }> =>
      event.type === "ChildCostRecovered" && event.taskId === "T1200" && event.childId === "T1201",
  );
  assert.ok(recoverFirst);
  assert.equal(recoverFirst.recoveredAmount, 30);

  for (const event of dueAfterFirstChild) {
    state = mustReduce(state, event);
  }

  state = mustReduce(state, lease("T1202", 14, 1, "execution", "coder", "e-1202"));
  state = mustReduce(state, started("T1202", 15, 1, "coder", "e-1202"));
  state = mustReduce(state, exited("T1202", 16, 1, "coder", "e-1202", 5));
  state = mustReduce(state, complete("T1202", 17));

  const dueAfterSecondChild = clock.collectDueEvents(state, 18);
  const recoverSecond = dueAfterSecondChild.find(
    (event): event is Extract<Event, { type: "ChildCostRecovered" }> =>
      event.type === "ChildCostRecovered" && event.taskId === "T1200" && event.childId === "T1202",
  );
  assert.ok(recoverSecond);
  assert.equal(recoverSecond.recoveredAmount, 25);

  for (const event of dueAfterSecondChild) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T1200?.cost.childRecovered, 55);
  assert.equal(state.tasks.T1201?.costRecoveredToParent, true);
  assert.equal(state.tasks.T1202?.costRecoveredToParent, true);

  const consumed = sumConsumed(state, ["T1200", "T1201", "T1202"]);
  const remaining = sumRemaining(state, ["T1200", "T1201", "T1202"]);
  assert.equal(consumed + remaining, 100);

  const thirdTick = clock.collectDueEvents(state, 19);
  assert.equal(
    thirdTick.some(
      (event) => event.type === "ChildCostRecovered" && (event.childId === "T1201" || event.childId === "T1202"),
    ),
    false,
  );
});

test("Scenario N: WaitResolved redirect_wait supports consultant handoff", () => {
  const events: Event[] = [
    createTask("T1300", 1, { initialPhase: "execution", skipAnalysis: true }),
    lease("T1300", 2, 1, "execution", "coder", "e-1300"),
    started("T1300", 3, 1, "coder", "e-1300"),
    {
      type: "WaitRequested",
      taskId: "T1300",
      ts: 4,
      fenceToken: 1,
      dependency: {
        id: "dep-1300-a",
        type: "consultation",
        target: "analyst",
        blocking: true,
        timing: "during",
        status: "pending",
      },
      returnPhase: "execution",
      returnCondition: "active",
      agentContext: {
        sessionId: "e-1300",
        agentId: "coder",
        memoryRef: null,
        contextTokens: 200,
        modelId: "gpt-5",
      },
    },
    {
      type: "WaitResolved",
      taskId: "T1300",
      ts: 5,
      dependencyId: "dep-1300-a",
      resolution: "redirected",
      action: "redirect_wait",
      payload: "ask senior dev",
      source: { type: "middle", id: "consult" },
    },
    {
      type: "WaitRequested",
      taskId: "T1300",
      ts: 6,
      fenceToken: 1,
      dependency: {
        id: "dep-1300-b",
        type: "consultation",
        target: "senior-dev",
        blocking: true,
        timing: "during",
        status: "pending",
      },
      returnPhase: "execution",
      returnCondition: "active",
      agentContext: {
        sessionId: "e-1300",
        agentId: "coder",
        memoryRef: null,
        contextTokens: 200,
        modelId: "gpt-5",
      },
    },
    {
      type: "WaitResolved",
      taskId: "T1300",
      ts: 7,
      dependencyId: "dep-1300-b",
      resolution: "fulfilled",
      action: "resume",
      payload: "continue",
      source: { type: "middle", id: "consult" },
    },
  ];

  const state = mustReplay(events);
  const task = state.tasks.T1300;
  assert.ok(task);
  assert.equal(task.phase, "execution");
  assert.equal(task.condition, "active");
  assert.equal(task.dependencies.length, 2);
  assert.equal(task.dependencies[0]?.status, "skipped");
  assert.equal(task.dependencies[1]?.status, "fulfilled");
});

test("Scenario O: all children failed routes parent back to analysis", () => {
  const prefix: Event[] = [
    createTask("T1400", 1, { costBudget: 100 }),
    lease("T1400", 2, 1, "analysis", "analyst", "a-1400"),
    started("T1400", 3, 1, "analyst", "a-1400"),
    transition("T1400", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-1400"),
    lease("T1400", 5, 2, "decomposition", "decomposer", "d-1400"),
    started("T1400", 6, 2, "decomposer", "d-1400"),
    {
      type: "DecompositionCreated",
      taskId: "T1400",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T1401",
          title: "Child 1401",
          description: "Child 1401",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T1402",
          title: "Child 1402",
          description: "Child 1402",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-1400",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T1400", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-1400"),
    {
      type: "TaskFailed",
      taskId: "T1401",
      ts: 9,
      reason: "budget_exhausted",
      phase: "execution",
      summary: failureSummary(),
    },
    {
      type: "TaskFailed",
      taskId: "T1402",
      ts: 10,
      reason: "budget_exhausted",
      phase: "execution",
      summary: failureSummary(),
    },
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 11);

  assert.equal(
    due.some(
      (event) => event.type === "PhaseTransition" && event.taskId === "T1400" && event.reasonCode === "children_complete",
    ),
    false,
  );
  assert.ok(
    due.some(
      (event) => event.type === "PhaseTransition" && event.taskId === "T1400" && event.reasonCode === "children_all_failed",
    ),
  );

  for (const event of due) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T1400?.phase, "analysis");
  assert.equal(state.tasks.T1400?.condition, "ready");
  assert.equal(state.tasks.T1400?.terminal, null);
});

test("Scenario P: checkpoint trigger does not double-charge analysis attempts", () => {
  const budgets = {
    analysis: { max: 3 },
    decomposition: { max: 4 },
    execution: { max: 4 },
    review: { max: 4 },
  };

  const prefix: Event[] = [
    createTask("T1500", 1, { attemptBudgets: budgets, costBudget: 80 }),
    lease("T1500", 2, 1, "analysis", "analyst", "a-1500"),
    started("T1500", 3, 1, "analyst", "a-1500"),
    transition("T1500", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-1500"),
    lease("T1500", 5, 2, "decomposition", "decomposer", "d-1500"),
    started("T1500", 6, 2, "decomposer", "d-1500"),
    {
      type: "DecompositionCreated",
      taskId: "T1500",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T1501",
          title: "Checkpoint child",
          description: "Checkpoint child",
          costAllocation: 15,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T1502",
          title: "Regular child",
          description: "Regular child",
          costAllocation: 15,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: ["T1501"],
      completionRule: "and",
      agentContext: {
        sessionId: "d-1500",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T1500", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-1500"),
    complete("T1501", 9),
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 10);
  assert.ok(due.some((event) => event.type === "CheckpointTriggered" && event.taskId === "T1500"));

  for (const event of due) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T1500?.attempts.analysis.used, 1);

  state = mustReduce(state, lease("T1500", 11, 3, "analysis", "analyst", "a-1501"));
  assert.equal(state.tasks.T1500?.attempts.analysis.used, 2);
});

test("Scenario Q: AgentExited followup timeout schedules retry", () => {
  let state = createInitialState();
  state = mustReduce(state, createTask("T1600", 1, { initialPhase: "execution", skipAnalysis: true }));
  state = mustReduce(state, lease("T1600", 2, 1, "execution", "coder", "e-1600"));
  state = mustReduce(state, started("T1600", 3, 1, "coder", "e-1600"));
  state = mustReduce(state, exited("T1600", 4, 1, "coder", "e-1600", 1));

  const clock = new CoreClock();
  const beforeTimeout = clock.collectDueEvents(state, 34_000);
  assert.equal(
    beforeTimeout.some((event) => event.type === "RetryScheduled" && event.taskId === "T1600"),
    false,
  );

  const afterTimeout = clock.collectDueEvents(state, 65_500);
  const timeoutRetry = afterTimeout.find(
    (event) =>
      event.type === "RetryScheduled" &&
      event.taskId === "T1600" &&
      event.reason === "agent_exit_followup_timeout",
  );
  assert.ok(timeoutRetry);

  state = mustReduce(state, timeoutRetry);
  assert.equal(state.tasks.T1600?.condition, "retryWait");
  assert.equal(state.tasks.T1600?.lastAgentExitAt, null);
});

test("Scenario R: retryWait budget exhaustion pauses before BackoffExpired", () => {
  let state = createInitialState();
  state = mustReduce(
    state,
    createTask("T1700", 1, {
      initialPhase: "execution",
      skipAnalysis: true,
      attemptBudgets: {
        analysis: { max: 3 },
        decomposition: { max: 2 },
        execution: { max: 2 },
        review: { max: 2 },
      },
    }),
  );

  state = mustReduce(state, lease("T1700", 2, 1, "execution", "coder", "e-1700"));
  state = mustReduce(state, started("T1700", 3, 1, "coder", "e-1700"));
  state = mustReduce(state, {
    type: "RetryScheduled",
    taskId: "T1700",
    ts: 4,
    fenceToken: 1,
    reason: "agent_crashed",
    retryAfter: 5,
    phase: "execution",
    attemptNumber: 1,
  });
  state = mustReduce(state, {
    type: "BackoffExpired",
    taskId: "T1700",
    ts: 5,
    phase: "execution",
    source: { type: "core", id: "clock" },
  });

  state = mustReduce(state, lease("T1700", 6, 2, "execution", "coder", "e-1701"));
  state = mustReduce(state, started("T1700", 7, 2, "coder", "e-1701"));
  state = mustReduce(state, {
    type: "RetryScheduled",
    taskId: "T1700",
    ts: 8,
    fenceToken: 2,
    reason: "agent_crashed",
    retryAfter: 9,
    phase: "execution",
    attemptNumber: 2,
  });

  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 10);
  assert.ok(due.some((event) => event.type === "TaskExhausted" && event.taskId === "T1700" && event.reason === "budget_exhausted"));
  assert.equal(due.some((event) => event.type === "BackoffExpired" && event.taskId === "T1700"), false);

  for (const event of due) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T1700?.condition, "exhausted");
  assert.equal(state.tasks.T1700?.terminal, null);
});

test("Scenario S: LeaseExpired auto-emission transitions leased task to retryWait", () => {
  let state = createInitialState();
  state = mustReduce(state, createTask("T1800", 1));
  state = mustReduce(state, {
    type: "LeaseGranted",
    taskId: "T1800",
    ts: 2,
    fenceToken: 1,
    agentId: "analyst",
    phase: "analysis",
    leaseTimeout: 5_000,
    sessionId: "a-1800",
    sessionType: "fresh",
    contextBudget: 512,
  });

  const clock = new CoreClock();
  const early = clock.collectDueEvents(state, 4_000);
  assert.equal(early.some((event) => event.type === "LeaseExpired" && event.taskId === "T1800"), false);

  const due = clock.collectDueEvents(state, 6_000);
  const leaseExpired = due.find((event) => event.type === "LeaseExpired" && event.taskId === "T1800");
  assert.ok(leaseExpired);

  state = mustReduce(state, leaseExpired);
  assert.equal(state.tasks.T1800?.condition, "retryWait");
  assert.equal(state.tasks.T1800?.leasedTo, null);
});

test("Scenario T: WaitResolved(block) blocks task and propagates summary to parent", () => {
  let state = createInitialState();
  state = mustReduce(state, createTask("T1900", 1));
  state = mustReduce(
    state,
    createTask("T1901", 2, {
      parentId: "T1900",
      rootId: "T1900",
      initialPhase: "execution",
      skipAnalysis: true,
    }),
  );

  state = mustReduce(state, lease("T1901", 3, 1, "execution", "coder", "e-1901"));
  state = mustReduce(state, started("T1901", 4, 1, "coder", "e-1901"));
  state = mustReduce(state, {
    type: "WaitRequested",
    taskId: "T1901",
    ts: 5,
    fenceToken: 1,
    dependency: {
      id: "dep-1901",
      type: "consultation",
      target: "analyst",
      blocking: true,
      timing: "during",
      status: "pending",
    },
    returnPhase: "execution",
    returnCondition: "active",
    agentContext: {
      sessionId: "e-1901",
      agentId: "coder",
      memoryRef: null,
      contextTokens: 250,
      modelId: "gpt-5",
    },
  });

  const blockSummary = failureSummary();
  state = mustReduce(state, {
    type: "WaitResolved",
    taskId: "T1901",
    ts: 6,
    dependencyId: "dep-1901",
    resolution: "timed_out",
    action: "block",
    payload: "cannot proceed",
    source: { type: "middle", id: "consult" },
    summary: blockSummary,
  });

  assert.equal(state.tasks.T1901?.terminal, "blocked");
  assert.ok(state.tasks.T1901?.terminalSummary);
  assert.equal(state.tasks.T1900?.failureSummaries.length, 1);
  assert.equal(state.tasks.T1900?.failureSummaries[0]?.childId, "T1901");
});

test("Scenario U: DependencySatisfied auto-emission unblocks before_start dependency", () => {
  let state = createInitialState();

  state = mustReduce(state, {
    type: "TaskCreated",
    taskId: "T2000",
    ts: 1,
    title: "Dependent task",
    description: "Waits on T2001",
    parentId: null,
    rootId: "T2000",
    initialPhase: "analysis",
    initialCondition: "waiting",
    attemptBudgets: defaultBudgets,
    costBudget: 20,
    dependencies: [
      {
        id: "dep-t2001",
        type: "task",
        target: "T2001",
        blocking: true,
        timing: "before_start",
        status: "pending",
      },
    ],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "planner" },
  });

  state = mustReduce(
    state,
    createTask("T2001", 2, {
      initialPhase: "execution",
      skipAnalysis: true,
      costBudget: 10,
    }),
  );
  state = mustReduce(state, complete("T2001", 3));

  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 4);
  const depSatisfied = due.find(
    (event) => event.type === "DependencySatisfied" && event.taskId === "T2000" && event.satisfiedBy === "T2001",
  );
  assert.ok(depSatisfied);

  state = mustReduce(state, depSatisfied);
  assert.equal(state.tasks.T2000?.condition, "ready");
  assert.equal(state.tasks.T2000?.dependencies[0]?.status, "fulfilled");
});

test("Scenario V: DecompositionCreated rejects cost over-allocation", () => {
  let state = createInitialState();
  state = mustReduce(state, createTask("T2100", 1, { costBudget: 50 }));
  state = mustReduce(state, lease("T2100", 2, 1, "analysis", "analyst", "a-2100"));
  state = mustReduce(state, started("T2100", 3, 1, "analyst", "a-2100"));
  state = mustReduce(state, exited("T2100", 4, 1, "analyst", "a-2100", 10));
  state = mustReduce(
    state,
    transition("T2100", 5, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-2100"),
  );
  state = mustReduce(state, lease("T2100", 6, 2, "decomposition", "decomposer", "d-2100"));
  state = mustReduce(state, started("T2100", 7, 2, "decomposer", "d-2100"));

  mustReject(state, {
    type: "DecompositionCreated",
    taskId: "T2100",
    ts: 8,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "T2101",
        title: "Child 2101",
        description: "Child 2101",
        costAllocation: 25,
        skipAnalysis: true,
        dependencies: [],
      },
      {
        taskId: "T2102",
        title: "Child 2102",
        description: "Child 2102",
        costAllocation: 20,
        skipAnalysis: true,
        dependencies: [],
      },
    ],
    checkpoints: [],
    completionRule: "and",
    agentContext: {
      sessionId: "d-2100",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: 300,
      modelId: "gpt-5",
    },
  }, "cost_over_allocation");
});

test("Scenario W: canceled child full recovery keeps invariants valid", () => {
  const prefix: Event[] = [
    createTask("T2200", 1, { costBudget: 100 }),
    lease("T2200", 2, 1, "analysis", "analyst", "a-2200"),
    started("T2200", 3, 1, "analyst", "a-2200"),
    transition("T2200", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-2200"),
    lease("T2200", 5, 2, "decomposition", "decomposer", "d-2200"),
    started("T2200", 6, 2, "decomposer", "d-2200"),
    {
      type: "DecompositionCreated",
      taskId: "T2200",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T2201",
          title: "Child 2201",
          description: "Child 2201",
          costAllocation: 30,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T2202",
          title: "Child 2202",
          description: "Child 2202",
          costAllocation: 30,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-2200",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    {
      type: "TaskCanceled",
      taskId: "T2201",
      ts: 8,
      reason: "manual",
      source: { type: "middle", id: "planner" },
    },
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 9);
  const recovered = due.find(
    (event): event is Extract<Event, { type: "ChildCostRecovered" }> =>
      event.type === "ChildCostRecovered" && event.taskId === "T2200" && event.childId === "T2201",
  );
  assert.ok(recovered);
  assert.equal(recovered.recoveredAmount, 30);

  for (const event of due) {
    state = mustReduce(state, event);
  }

  const violations = checkInvariants(state);
  assert.equal(violations.length, 0, JSON.stringify(violations));
  assert.equal(state.tasks.T2201?.cost.allocated, 0);
  assert.equal(state.tasks.T2201?.costRecoveredToParent, true);

  const consumed = sumConsumed(state, ["T2200", "T2201", "T2202"]);
  const remaining = sumRemaining(state, ["T2200", "T2201", "T2202"]);
  assert.equal(consumed + remaining, 100);
});

test("Scenario X: duplicate ChildCostRecovered is rejected", () => {
  const prefix: Event[] = [
    createTask("T2300", 1, { costBudget: 100 }),
    lease("T2300", 2, 1, "analysis", "analyst", "a-2300"),
    started("T2300", 3, 1, "analyst", "a-2300"),
    transition("T2300", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-2300"),
    lease("T2300", 5, 2, "decomposition", "decomposer", "d-2300"),
    started("T2300", 6, 2, "decomposer", "d-2300"),
    {
      type: "DecompositionCreated",
      taskId: "T2300",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T2301",
          title: "Child 2301",
          description: "Child 2301",
          costAllocation: 40,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-2300",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    lease("T2301", 8, 1, "execution", "coder", "e-2301"),
    started("T2301", 9, 1, "coder", "e-2301"),
    exited("T2301", 10, 1, "coder", "e-2301", 10),
    complete("T2301", 11),
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 12);
  for (const event of due) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T2301?.costRecoveredToParent, true);

  mustReject(
    state,
    {
      type: "ChildCostRecovered",
      taskId: "T2300",
      ts: 13,
      childId: "T2301",
      recoveredAmount: 30,
      source: { type: "core", id: "core-clock" },
    },
    "child_cost_already_recovered",
  );
});

test("Scenario Y: WaitRequested clears stale lastAgentExitAt", () => {
  let state = createInitialState();
  state = mustReduce(state, createTask("T2400", 1, { initialPhase: "execution", skipAnalysis: true }));
  state = mustReduce(state, lease("T2400", 2, 1, "execution", "coder", "e-2400"));
  state = mustReduce(state, started("T2400", 3, 1, "coder", "e-2400"));
  state = mustReduce(state, exited("T2400", 4, 1, "coder", "e-2400", 1));
  assert.equal(state.tasks.T2400?.lastAgentExitAt, 4);

  state = mustReduce(state, {
    type: "WaitRequested",
    taskId: "T2400",
    ts: 5,
    fenceToken: 1,
    dependency: {
      id: "dep-2400",
      type: "consultation",
      target: "analyst",
      blocking: true,
      timing: "during",
      status: "pending",
    },
    returnPhase: "execution",
    returnCondition: "active",
    agentContext: {
      sessionId: "e-2400",
      agentId: "coder",
      memoryRef: null,
      contextTokens: 200,
      modelId: "gpt-5",
    },
  });

  assert.equal(state.tasks.T2400?.lastAgentExitAt, null);

  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 120_000);
  assert.equal(
    due.some(
      (event) =>
        event.type === "RetryScheduled" &&
        event.taskId === "T2400" &&
        event.reason === "agent_exit_followup_timeout",
    ),
    false,
  );
});

test("Scenario Z: WaitResolved(resume) keeps lastAgentExitAt cleared", () => {
  let state = createInitialState();
  state = mustReduce(state, createTask("T2500", 1, { initialPhase: "execution", skipAnalysis: true }));
  state = mustReduce(state, lease("T2500", 2, 1, "execution", "coder", "e-2500"));
  state = mustReduce(state, started("T2500", 3, 1, "coder", "e-2500"));
  state = mustReduce(state, exited("T2500", 4, 1, "coder", "e-2500", 1));

  state = mustReduce(state, {
    type: "WaitRequested",
    taskId: "T2500",
    ts: 5,
    fenceToken: 1,
    dependency: {
      id: "dep-2500",
      type: "consultation",
      target: "analyst",
      blocking: true,
      timing: "during",
      status: "pending",
    },
    returnPhase: "execution",
    returnCondition: "active",
    agentContext: {
      sessionId: "e-2500",
      agentId: "coder",
      memoryRef: null,
      contextTokens: 200,
      modelId: "gpt-5",
    },
  });

  state = mustReduce(state, {
    type: "WaitResolved",
    taskId: "T2500",
    ts: 6,
    dependencyId: "dep-2500",
    resolution: "fulfilled",
    action: "resume",
    payload: "ok",
    source: { type: "middle", id: "consult" },
  });

  assert.equal(state.tasks.T2500?.condition, "active");
  assert.equal(state.tasks.T2500?.lastAgentExitAt, null);
});

test("Scenario AA: re-decomposition v2 cancels old children and supersedes approach", () => {
  const events: Event[] = [
    createTask("T2600", 1, { costBudget: 100 }),
    lease("T2600", 2, 1, "analysis", "analyst", "a-2600"),
    started("T2600", 3, 1, "analyst", "a-2600"),
    transition("T2600", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-2600"),
    lease("T2600", 5, 2, "decomposition", "decomposer", "d-2600"),
    started("T2600", 6, 2, "decomposer", "d-2600"),
    {
      type: "DecompositionCreated",
      taskId: "T2600",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T2601",
          title: "Child 2601",
          description: "Child 2601",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T2602",
          title: "Child 2602",
          description: "Child 2602",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-2600",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    lease("T2601", 8, 1, "execution", "coder", "e-2601"),
    started("T2601", 9, 1, "coder", "e-2601"),
    {
      type: "DecompositionCreated",
      taskId: "T2600",
      ts: 10,
      fenceToken: 2,
      version: 2,
      children: [
        {
          taskId: "T2603",
          title: "Child 2603",
          description: "Child 2603",
          costAllocation: 25,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T2604",
          title: "Child 2604",
          description: "Child 2604",
          costAllocation: 25,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-2600",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
  ];

  const state = mustReplay(events);

  assert.equal(state.tasks.T2601?.terminal, "canceled");
  assert.equal(state.tasks.T2602?.terminal, "canceled");
  assert.ok(state.tasks.T2603);
  assert.ok(state.tasks.T2604);
  assert.equal(state.tasks.T2600?.children.includes("T2601"), true);
  assert.equal(state.tasks.T2600?.children.includes("T2602"), true);
  assert.equal(state.tasks.T2600?.children.includes("T2603"), true);
  assert.equal(state.tasks.T2600?.children.includes("T2604"), true);
  assert.equal(state.tasks.T2600?.cost.childAllocated, 90);
  assert.equal(state.tasks.T2600?.decompositionVersion, 2);
  assert.equal(state.tasks.T2600?.approachHistory[0]?.outcome, "superseded");

  const consumed = sumConsumed(state, ["T2600", "T2601", "T2602", "T2603", "T2604"]);
  const remaining = sumRemaining(state, ["T2600", "T2601", "T2602", "T2603", "T2604"]);
  assert.equal(consumed + remaining, 100);
});

test("Scenario AB: mixed child terminals (done + failed) still produce children_complete", () => {
  const prefix: Event[] = [
    createTask("T2700", 1, { costBudget: 100 }),
    lease("T2700", 2, 1, "analysis", "analyst", "a-2700"),
    started("T2700", 3, 1, "analyst", "a-2700"),
    transition("T2700", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-2700"),
    lease("T2700", 5, 2, "decomposition", "decomposer", "d-2700"),
    started("T2700", 6, 2, "decomposer", "d-2700"),
    {
      type: "DecompositionCreated",
      taskId: "T2700",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T2701",
          title: "Child 2701",
          description: "Child 2701",
          costAllocation: 30,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T2702",
          title: "Child 2702",
          description: "Child 2702",
          costAllocation: 30,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-2700",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T2700", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-2700"),
    complete("T2701", 9),
    {
      type: "TaskFailed",
      taskId: "T2702",
      ts: 10,
      reason: "budget_exhausted",
      phase: "execution",
      summary: failureSummary(),
    },
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 11);
  assert.ok(
    due.some(
      (event) => event.type === "PhaseTransition" && event.taskId === "T2700" && event.reasonCode === "children_complete",
    ),
  );
  assert.equal(
    due.some(
      (event) => event.type === "PhaseTransition" && event.taskId === "T2700" && event.reasonCode === "children_all_failed",
    ),
    false,
  );

  for (const event of due) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T2700?.phase, "review");
  assert.equal(state.tasks.T2700?.condition, "ready");
});

test("Scenario AC: all children canceled emits children_all_failed", () => {
  const prefix: Event[] = [
    createTask("T2800", 1, { costBudget: 100 }),
    lease("T2800", 2, 1, "analysis", "analyst", "a-2800"),
    started("T2800", 3, 1, "analyst", "a-2800"),
    transition("T2800", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-2800"),
    lease("T2800", 5, 2, "decomposition", "decomposer", "d-2800"),
    started("T2800", 6, 2, "decomposer", "d-2800"),
    {
      type: "DecompositionCreated",
      taskId: "T2800",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T2801",
          title: "Child 2801",
          description: "Child 2801",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T2802",
          title: "Child 2802",
          description: "Child 2802",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-2800",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T2800", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-2800"),
    {
      type: "TaskCanceled",
      taskId: "T2801",
      ts: 9,
      reason: "manual",
      source: { type: "middle", id: "planner" },
    },
    {
      type: "TaskCanceled",
      taskId: "T2802",
      ts: 10,
      reason: "manual",
      source: { type: "middle", id: "planner" },
    },
  ];

  let state = mustReplay(prefix);
  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 11);
  assert.ok(
    due.some(
      (event) => event.type === "PhaseTransition" && event.taskId === "T2800" && event.reasonCode === "children_all_failed",
    ),
  );
  assert.equal(
    due.some(
      (event) => event.type === "PhaseTransition" && event.taskId === "T2800" && event.reasonCode === "children_complete",
    ),
    false,
  );

  for (const event of due) {
    state = mustReduce(state, event);
  }

  assert.equal(state.tasks.T2800?.phase, "analysis");
  assert.equal(state.tasks.T2800?.condition, "ready");
});

test("Scenario AD: no ChildCostRecovered emitted when parent is terminal", () => {
  const prefix: Event[] = [
    createTask("T2900", 1, { costBudget: 100 }),
    lease("T2900", 2, 1, "analysis", "analyst", "a-2900"),
    started("T2900", 3, 1, "analyst", "a-2900"),
    transition("T2900", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-2900"),
    lease("T2900", 5, 2, "decomposition", "decomposer", "d-2900"),
    started("T2900", 6, 2, "decomposer", "d-2900"),
    {
      type: "DecompositionCreated",
      taskId: "T2900",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T2901",
          title: "Child 2901",
          description: "Child 2901",
          costAllocation: 40,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-2900",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    {
      type: "TaskBlocked",
      taskId: "T2900",
      ts: 8,
      reason: "manual block",
      reasonCode: "human_block",
      summary: failureSummary(),
      source: { type: "middle", id: "planner" },
    },
    complete("T2901", 9),
  ];

  const state = mustReplay(prefix);
  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 10);
  assert.equal(
    due.some((event) => event.type === "ChildCostRecovered" && event.taskId === "T2900" && event.childId === "T2901"),
    false,
  );
  assert.equal(state.tasks.T2901?.costRecoveredToParent, false);
});

test("Scenario AE: redirect_wait intermediate state is explicit and sequential", () => {
  let state = createInitialState();
  state = mustReduce(state, createTask("T3000", 1, { initialPhase: "execution", skipAnalysis: true }));
  state = mustReduce(state, lease("T3000", 2, 1, "execution", "coder", "e-3000"));
  state = mustReduce(state, started("T3000", 3, 1, "coder", "e-3000"));

  state = mustReduce(state, {
    type: "WaitRequested",
    taskId: "T3000",
    ts: 4,
    fenceToken: 1,
    dependency: {
      id: "dep-3000-a",
      type: "consultation",
      target: "consultant-1",
      blocking: true,
      timing: "during",
      status: "pending",
    },
    returnPhase: "execution",
    returnCondition: "active",
    agentContext: {
      sessionId: "e-3000",
      agentId: "coder",
      memoryRef: null,
      contextTokens: 200,
      modelId: "gpt-5",
    },
  });

  assert.equal(state.tasks.T3000?.condition, "waiting");
  assert.notEqual(state.tasks.T3000?.waitState, null);

  state = mustReduce(state, {
    type: "WaitResolved",
    taskId: "T3000",
    ts: 5,
    dependencyId: "dep-3000-a",
    resolution: "redirected",
    action: "redirect_wait",
    payload: "ask consultant 2",
    source: { type: "middle", id: "consult" },
  });

  assert.equal(state.tasks.T3000?.condition, "waiting");
  assert.equal(state.tasks.T3000?.waitState, null);

  state = mustReduce(state, {
    type: "WaitRequested",
    taskId: "T3000",
    ts: 6,
    fenceToken: 1,
    dependency: {
      id: "dep-3000-b",
      type: "consultation",
      target: "consultant-2",
      blocking: true,
      timing: "during",
      status: "pending",
    },
    returnPhase: "execution",
    returnCondition: "active",
    agentContext: {
      sessionId: "e-3000",
      agentId: "coder",
      memoryRef: null,
      contextTokens: 200,
      modelId: "gpt-5",
    },
  });

  assert.equal(state.tasks.T3000?.condition, "waiting");
  assert.notEqual(state.tasks.T3000?.waitState, null);
  assert.equal(state.tasks.T3000?.waitState?.dependencyId, "dep-3000-b");

  state = mustReduce(state, {
    type: "WaitResolved",
    taskId: "T3000",
    ts: 7,
    dependencyId: "dep-3000-b",
    resolution: "fulfilled",
    action: "resume",
    payload: "done",
    source: { type: "middle", id: "consult" },
  });

  assert.equal(state.tasks.T3000?.condition, "active");
  assert.equal(state.tasks.T3000?.waitState, null);
});

test("Scenario AF: CheckpointCreated and StateReverted preserve search state", () => {
  const cpRef = {
    branch: "task/T3100",
    commit: "abc123",
    parentCommit: "abc122",
  };

  let state = createInitialState();
  state = mustReduce(state, createTask("T3100", 1, { initialPhase: "execution", skipAnalysis: true, reviewConfig: reviewConfigRequired() }));
  state = mustReduce(state, lease("T3100", 2, 1, "execution", "coder", "e-3100"));
  state = mustReduce(state, started("T3100", 3, 1, "coder", "e-3100"));
  state = mustReduce(state, {
    type: "CheckpointCreated",
    taskId: "T3100",
    ts: 4,
    checkpointId: "cp1",
    stateRef: cpRef,
    reason: "before risky change",
    phase: "execution",
    condition: "active",
  });

  assert.equal(state.tasks.T3100?.checkpointRefs.length, 1);
  assert.equal(state.tasks.T3100?.checkpointRefs[0]?.id, "cp1");

  state = mustReduce(state, createTask("T3101", 5, { parentId: "T3100", rootId: "T3100", initialPhase: "execution", skipAnalysis: true }));
  state = mustReduce(state, {
    type: "TaskFailed",
    taskId: "T3101",
    ts: 6,
    reason: "budget_exhausted",
    phase: "execution",
    summary: failureSummary(),
  });

  state = mustReduce(state, exited("T3100", 7, 1, "coder", "e-3100", 4));
  state = mustReduce(state, transition("T3100", 8, "execution", "active", "review", "ready", "work_complete", 1, "coder", "e-3100"));
  state = mustReduce(state, lease("T3100", 9, 2, "review", "reviewer", "r-3100"));
  state = mustReduce(state, started("T3100", 10, 2, "reviewer", "r-3100"));
  state = mustReduce(state, reviewVerdict("T3100", 11, 2, "reviewer", "r-3100", "changes_requested"));
  state = mustReduce(state, reviewPolicy("T3100", 12, "changes_requested"));
  state = mustReduce(state, transition("T3100", 13, "review", "active", "execution", "ready", "changes_requested", 2, "reviewer", "r-3100"));

  const consumedBeforeRevert = state.tasks.T3100?.cost.consumed;
  const summariesBeforeRevert = state.tasks.T3100?.failureSummaries.length;

  state = mustReduce(state, {
    type: "StateReverted",
    taskId: "T3100",
    ts: 14,
    revertTo: "cp1",
    targetStateRef: cpRef,
    reason: "rollback",
    preserving: ["search_state"],
    source: { type: "core", id: "core-clock" },
  });

  assert.equal(state.tasks.T3100?.stateRef?.commit, "abc123");
  assert.equal(state.tasks.T3100?.cost.consumed, consumedBeforeRevert);
  assert.equal(state.tasks.T3100?.failureSummaries.length, summariesBeforeRevert);
});

test("Scenario AG: submit invariant error is returned and invalid event is not persisted", () => {
  const tempDir = mkdtempSync(join(tmpdir(), "orchestration-core-round5-"));
  const dbPath = join(tempDir, "core.db");

  const core = createCore({ dbPath, invariantChecks: true, snapshotEvery: 0 });
  let coreClosed = false;
  let reopened: ReturnType<typeof createCore> | null = null;

  try {
    const created = core.submit(createTask("T3200", 1));
    assert.equal(created.ok, true);

    const internal = core as unknown as { state: SystemState };
    const originalState = structuredClone(internal.state);
    const tamperedTask = internal.state.tasks.T3200;
    assert.ok(tamperedTask);
    tamperedTask.cost.allocated = -1;

    const result = core.submit({
      type: "TaskCanceled",
      taskId: "T3200",
      ts: 2,
      reason: "manual",
      source: { type: "middle", id: "planner" },
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "cost_allocated_negative");
    }

    internal.state = originalState;

    const stateAfter = core.getState();
    assert.equal(stateAfter.sequence, 1);
    assert.equal(stateAfter.events.length, 1);
    assert.equal(stateAfter.tasks.T3200?.condition, "ready");

    core.close();
    coreClosed = true;

    reopened = createCore({ dbPath, invariantChecks: true, snapshotEvery: 0 });
    const restored = reopened.getState();
    assert.equal(restored.sequence, 1);
    assert.equal(restored.events.length, 1);
    assert.equal(restored.tasks.T3200?.condition, "ready");
  } finally {
    if (reopened) {
      reopened.close();
    }
    if (!coreClosed) {
      core.close();
    }
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test("Scenario AH: review.waiting with all terminal children passes invariants before tick", () => {
  const events: Event[] = [
    createTask("T3300", 1, { costBudget: 80 }),
    lease("T3300", 2, 1, "analysis", "analyst", "a-3300"),
    started("T3300", 3, 1, "analyst", "a-3300"),
    transition("T3300", 4, "analysis", "active", "decomposition", "ready", "decision_decompose", 1, "analyst", "a-3300"),
    lease("T3300", 5, 2, "decomposition", "decomposer", "d-3300"),
    started("T3300", 6, 2, "decomposer", "d-3300"),
    {
      type: "DecompositionCreated",
      taskId: "T3300",
      ts: 7,
      fenceToken: 2,
      version: 1,
      children: [
        {
          taskId: "T3301",
          title: "Child 3301",
          description: "Child 3301",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
        {
          taskId: "T3302",
          title: "Child 3302",
          description: "Child 3302",
          costAllocation: 20,
          skipAnalysis: true,
          dependencies: [],
        },
      ],
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: "d-3300",
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 300,
        modelId: "gpt-5",
      },
    },
    transition("T3300", 8, "decomposition", "active", "review", "waiting", "children_created", 2, "decomposer", "d-3300"),
    complete("T3301", 9),
    complete("T3302", 10),
  ];

  const state = mustReplay(events);
  assert.equal(state.tasks.T3300?.phase, "review");
  assert.equal(state.tasks.T3300?.condition, "waiting");
  assert.equal(state.tasks.T3301?.terminal, "done");
  assert.equal(state.tasks.T3302?.terminal, "done");

  const violations = checkInvariants(state);
  assert.equal(violations.length, 0, JSON.stringify(violations));
});

// ---------------------------------------------------------------------------
// TaskExhausted + BudgetIncreased scenario tests
// ---------------------------------------------------------------------------

test("Clock emits TaskExhausted (not TaskFailed) for attempt budget exhaustion", () => {
  const events: Event[] = [
    createTask("TEX100", 1, {
      costBudget: 100,
      attemptBudgets: {
        analysis: { max: 6 },
        decomposition: { max: 6 },
        execution: { max: 1 },
        review: { max: 6 },
      },
      skipAnalysis: true,
    }),
    lease("TEX100", 2, 1, "execution", "coder", "e-tex100"),
    started("TEX100", 3, 1, "coder", "e-tex100"),
    {
      type: "RetryScheduled",
      taskId: "TEX100",
      ts: 4,
      fenceToken: 1,
      reason: "agent_crashed",
      retryAfter: 5,
      phase: "execution",
      attemptNumber: 1,
    },
    {
      type: "BackoffExpired",
      taskId: "TEX100",
      ts: 5,
      phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  const state = mustReplay(events);
  // execution.used=1, execution.max=1 → exhausted
  assert.equal(state.tasks["TEX100"]!.condition, "ready");

  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 100);
  const exhaustEvents = due.filter((e) => e.type === "TaskExhausted" && e.taskId === "TEX100");
  assert.equal(exhaustEvents.length, 1, "Should emit TaskExhausted");
  assert.equal((exhaustEvents[0] as { reason: string }).reason, "budget_exhausted");

  // Verify no TaskFailed is emitted
  const failEvents = due.filter((e) => e.type === "TaskFailed" && e.taskId === "TEX100");
  assert.equal(failEvents.length, 0, "Should NOT emit TaskFailed");
});

test("Clock emits TaskExhausted for cost exhaustion", () => {
  const events: Event[] = [
    createTask("TEX101", 1, {
      costBudget: 2,
      attemptBudgets: {
        analysis: { max: 6 },
        decomposition: { max: 6 },
        execution: { max: 6 },
        review: { max: 6 },
      },
      skipAnalysis: true,
    }),
    lease("TEX101", 2, 1, "execution", "coder", "e-tex101"),
    started("TEX101", 3, 1, "coder", "e-tex101"),
    exited("TEX101", 4, 1, "coder", "e-tex101", 2),
    {
      type: "RetryScheduled",
      taskId: "TEX101",
      ts: 5,
      fenceToken: 1,
      reason: "agent_crashed",
      retryAfter: 6,
      phase: "execution",
      attemptNumber: 1,
    },
    {
      type: "BackoffExpired",
      taskId: "TEX101",
      ts: 6,
      phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  const state = mustReplay(events);
  // cost.consumed=2, cost.allocated=2 → remaining=0
  assert.equal(computeCostRemaining(state.tasks["TEX101"]!.cost), 0);

  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 100);
  const exhaustEvents = due.filter((e) => e.type === "TaskExhausted" && e.taskId === "TEX101");
  assert.equal(exhaustEvents.length, 1, "Should emit TaskExhausted for cost");
  assert.equal((exhaustEvents[0] as { reason: string }).reason, "cost_exhausted");
});

test("Clock skips already-exhausted tasks", () => {
  const events: Event[] = [
    createTask("TEX102", 1, {
      costBudget: 100,
      attemptBudgets: {
        analysis: { max: 6 },
        decomposition: { max: 6 },
        execution: { max: 1 },
        review: { max: 6 },
      },
      skipAnalysis: true,
    }),
    {
      type: "TaskExhausted",
      taskId: "TEX102",
      ts: 2,
      reason: "budget_exhausted",
      phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  const state = mustReplay(events);
  assert.equal(state.tasks["TEX102"]!.condition, "exhausted");

  const clock = new CoreClock();
  const due = clock.collectDueEvents(state, 100);
  const taskEvents = due.filter((e) => e.taskId === "TEX102");
  assert.equal(taskEvents.length, 0, "Clock should skip exhausted tasks");
});

test("Full lifecycle: exhaust → budget increase → dispatch → complete", () => {
  const events: Event[] = [
    createTask("TEX103", 1, {
      costBudget: 100,
      attemptBudgets: {
        analysis: { max: 6 },
        decomposition: { max: 6 },
        execution: { max: 1 },
        review: { max: 6 },
      },
      skipAnalysis: true,
    }),
    // Exhaust via clock path
    {
      type: "TaskExhausted",
      taskId: "TEX103",
      ts: 2,
      reason: "budget_exhausted",
      phase: "execution",
      source: { type: "core", id: "clock" },
    },
  ];

  let state = mustReplay(events);

  // Verify exhausted
  assert.equal(state.tasks["TEX103"]!.condition, "exhausted");
  let v = checkInvariants(state);
  assert.equal(v.length, 0, `Pre-budget invariants: ${JSON.stringify(v)}`);

  // Increase budget
  state = mustReduce(state, {
    type: "BudgetIncreased",
    taskId: "TEX103",
    ts: 3,
    attemptBudgetIncrease: { execution: { max: 4 } },
    costBudgetIncrease: 0,
    reason: "retry fix",
    source: { type: "middle", id: "daemon" },
  });

  assert.equal(state.tasks["TEX103"]!.condition, "ready");
  v = checkInvariants(state);
  assert.equal(v.length, 0, `Post-budget invariants: ${JSON.stringify(v)}`);

  // Dispatch: lease → start → work complete → complete
  state = mustReduce(state, lease("TEX103", 4, 1, "execution", "coder", "e-tex103-2"));
  state = mustReduce(state, started("TEX103", 5, 1, "coder", "e-tex103-2"));
  state = mustReduce(state, exited("TEX103", 6, 1, "coder", "e-tex103-2", 1));
  state = mustReduce(state, transition(
    "TEX103", 7, "execution", "active", "review", "ready", "work_complete", 1, "coder", "e-tex103-2",
  ));
  state = mustReduce(state, lease("TEX103", 8, 2, "review", "reviewer", "r-tex103"));
  state = mustReduce(state, started("TEX103", 9, 2, "reviewer", "r-tex103"));
  state = mustReduce(state, reviewVerdict("TEX103", 10, 2, "reviewer", "r-tex103", "approve"));
  state = mustReduce(state, reviewPolicy("TEX103", 11, "approved"));
  state = mustReduce(state, complete("TEX103", 12));

  assert.equal(state.tasks["TEX103"]!.terminal, "done");
  v = checkInvariants(state);
  assert.equal(v.length, 0, `Final invariants: ${JSON.stringify(v)}`);
});
