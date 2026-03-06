import test from "node:test";
import assert from "node:assert/strict";

import { checkInvariants } from "../invariants.js";
import { reduce } from "../reducer.js";
import {
  computeCostRemaining,
  createInitialState,
  type Event,
  type Phase,
  type SystemState,
} from "../types.js";

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function mustReduce(state: SystemState, event: Event): SystemState {
  const result = reduce(state, event);
  if (!result.ok) {
    assert.fail(`${result.error.code}: ${result.error.message}`);
  }
  return result.value.state;
}

function expectReject(state: SystemState, event: Event, errorCode: string): void {
  const result = reduce(state, event);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, errorCode);
  }
}

function createTask(taskId: string, ts: number, options?: { initialPhase?: Phase; executionMax?: number; costBudget?: number }): Extract<Event, { type: "TaskCreated" }> {
  return {
    type: "TaskCreated",
    taskId,
    ts,
    title: `Task ${taskId}`,
    description: "property task",
    parentId: null,
    rootId: taskId,
    initialPhase: options?.initialPhase ?? "analysis",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 5 },
      decomposition: { max: 5 },
      execution: { max: options?.executionMax ?? 5 },
      review: { max: 5 },
    },
    costBudget: options?.costBudget ?? 100,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "planner" },
  };
}

function collectSubtreeTaskIds(state: SystemState, rootTaskId: string): string[] {
  const out: string[] = [];
  const stack = [rootTaskId];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const taskId = stack.pop();
    if (!taskId || seen.has(taskId)) {
      continue;
    }
    seen.add(taskId);
    const task = state.tasks[taskId];
    if (!task) {
      continue;
    }
    out.push(taskId);
    for (const childId of task.children) {
      stack.push(childId);
    }
  }

  return out;
}

function assertCostConservation(state: SystemState, rootTaskId: string, rootBudget: number): void {
  const taskIds = collectSubtreeTaskIds(state, rootTaskId);
  const consumed = taskIds.reduce((sum, taskId) => sum + (state.tasks[taskId]?.cost.consumed ?? 0), 0);
  const remaining = taskIds.reduce((sum, taskId) => {
    const task = state.tasks[taskId];
    if (!task) {
      return sum;
    }
    return sum + computeCostRemaining(task.cost);
  }, 0);

  assert.equal(consumed + remaining, rootBudget);
}

test("property: retry loop is bounded by execution attempt budget", () => {
  for (let seed = 1; seed <= 40; seed += 1) {
    const random = mulberry32(seed);
    const executionMax = 1 + Math.floor(random() * 4);

    let state = createInitialState();
    const taskId = `TP-${seed}`;

    state = mustReduce(state, {
      ...createTask(taskId, 1, { initialPhase: "execution", executionMax, costBudget: 100 }),
      skipAnalysis: true,
    });

    let fence = 1;
    let now = 10;

    for (let i = 0; i < executionMax; i += 1) {
      state = mustReduce(state, {
        type: "LeaseGranted",
        taskId,
        ts: now,
        fenceToken: fence,
        agentId: "coder",
        phase: "execution",
        leaseTimeout: 10_000,
        sessionId: `s-${seed}-${i}`,
        sessionType: "fresh",
        contextBudget: 500,
        agentContext: {
          sessionId: `s-${seed}-${i}`,
          agentId: "coder",
          memoryRef: null,
          contextTokens: null,
          modelId: "test",
        },
      });

      now += 1;
      now += 1;
      state = mustReduce(state, {
        type: "RetryScheduled",
        taskId,
        ts: now,
        fenceToken: fence,
        reason: "no_progress",
        retryAfter: now + 1,
        phase: "execution",
        attemptNumber: i + 1,
      });

      now += 2;
      state = mustReduce(state, {
        type: "BackoffExpired",
        taskId,
        ts: now,
        phase: "execution",
        source: { type: "core", id: "clock" },
      });

      fence += 1;

      const violations = checkInvariants(state);
      assert.equal(violations.length, 0);
    }

    expectReject(
      state,
      {
        type: "LeaseGranted",
        taskId,
        ts: now + 1,
        fenceToken: fence,
        agentId: "coder",
        phase: "execution",
        leaseTimeout: 10_000,
        sessionId: `s-${seed}-overflow`,
        sessionType: "fresh",
        contextBudget: 500,
        agentContext: {
          sessionId: `s-${seed}-overflow`,
          agentId: "coder",
          memoryRef: null,
          contextTokens: null,
          modelId: "test",
        },
      },
      "attempt_budget_exhausted",
    );
  }
});

test("property A: cost conservation", () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const random = mulberry32(seed);
    const rootBudget = 10 + Math.floor(random() * 191); // 10..200
    const childCount = 2 + Math.floor(random() * 3); // 2..4
    const rootId = `PC-${seed}`;

    let state = createInitialState();
    state = mustReduce(state, createTask(rootId, 1, { costBudget: rootBudget }));
    state = mustReduce(state, {
      type: "LeaseGranted",
      taskId: rootId,
      ts: 2,
      fenceToken: 1,
      agentId: "analyst",
      phase: "analysis",
      leaseTimeout: 10_000,
      sessionId: `pc-a-${seed}`,
      sessionType: "fresh",
      contextBudget: 500,
      agentContext: {
        sessionId: `pc-a-${seed}`,
        agentId: "analyst",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });
    state = mustReduce(state, {
      type: "PhaseTransition",
      taskId: rootId,
      ts: 4,
      from: { phase: "analysis", condition: "active" },
      to: { phase: "decomposition", condition: "ready" },
      reasonCode: "decision_decompose",
      reason: "decompose",
      fenceToken: 1,
      agentContext: {
        sessionId: `pc-a-${seed}`,
        agentId: "analyst",
        memoryRef: null,
        contextTokens: 200,
        modelId: "gpt-5",
      },
    });

    state = mustReduce(state, {
      type: "LeaseGranted",
      taskId: rootId,
      ts: 5,
      fenceToken: 2,
      agentId: "decomposer",
      phase: "decomposition",
      leaseTimeout: 10_000,
      sessionId: `pc-d-${seed}`,
      sessionType: "fresh",
      contextBudget: 500,
      agentContext: {
        sessionId: `pc-d-${seed}`,
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });
    const allocations: number[] = [];
    let remaining = rootBudget;
    for (let i = 0; i < childCount; i += 1) {
      const remainingSlots = childCount - i;
      const minLeftForRest = remainingSlots - 1;
      const maxForThis = remaining - minLeftForRest;
      const allocation = 1 + Math.floor(random() * maxForThis);
      allocations.push(allocation);
      remaining -= allocation;
    }

    const children = allocations.map((allocation, i) => ({
      taskId: `${rootId}-C${i + 1}`,
      title: `Child ${i + 1}`,
      description: `Child ${i + 1}`,
      costAllocation: allocation,
      skipAnalysis: true,
      dependencies: [],
    }));

    state = mustReduce(state, {
      type: "DecompositionCreated",
      taskId: rootId,
      ts: 7,
      fenceToken: 2,
      version: 1,
      children,
      checkpoints: [],
      completionRule: "and",
      agentContext: {
        sessionId: `pc-d-${seed}`,
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 400,
        modelId: "gpt-5",
      },
    });
    state = mustReduce(state, {
      type: "PhaseTransition",
      taskId: rootId,
      ts: 8,
      from: { phase: "decomposition", condition: "active" },
      to: { phase: "review", condition: "waiting" },
      reasonCode: "children_created",
      reason: "children created",
      fenceToken: 2,
      agentContext: {
        sessionId: `pc-d-${seed}`,
        agentId: "decomposer",
        memoryRef: null,
        contextTokens: 200,
        modelId: "gpt-5",
      },
    });
    assertCostConservation(state, rootId, rootBudget);

    let ts = 9;
    for (let i = 0; i < children.length; i += 1) {
      const childId = children[i]?.taskId;
      const allocation = allocations[i] ?? 1;
      assert.ok(childId);

      const spend = Math.min(allocation, 1 + Math.floor(random() * allocation));
      state = mustReduce(state, {
        type: "LeaseGranted",
        taskId: childId,
        ts,
        fenceToken: 1,
        agentId: "coder",
        phase: "execution",
        leaseTimeout: 10_000,
        sessionId: `${childId}-s`,
        sessionType: "fresh",
        contextBudget: 500,
        agentContext: {
          sessionId: `${childId}-s`,
          agentId: "coder",
          memoryRef: null,
          contextTokens: null,
          modelId: "test",
        },
      });
      ts += 1;
      state = mustReduce(state, {
        type: "AgentExited",
        taskId: childId,
        ts,
        fenceToken: 1,
        exitCode: 0,
        reportedCost: spend,
        agentContext: {
          sessionId: `${childId}-s`,
          agentId: "coder",
          memoryRef: null,
          contextTokens: 250,
          modelId: "gpt-5",
        },
      });
      ts += 1;
      state = mustReduce(state, {
        type: "TaskCompleted",
        taskId: childId,
        ts,
        stateRef: {
          branch: `task/${childId}`,
          commit: `c-${childId}`,
          parentCommit: `p-${childId}`,
        },
      });
      ts += 1;

      assertCostConservation(state, rootId, rootBudget);

      const recoveredAmount = allocation - spend;
      state = mustReduce(state, {
        type: "ChildCostRecovered",
        taskId: rootId,
        ts,
        childId,
        recoveredAmount,
        source: { type: "core", id: "clock" },
      });
      ts += 1;

      assertCostConservation(state, rootId, rootBudget);
    }
  }
});

test("property B: terminal absorption", () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const random = mulberry32(seed);
    const taskId = `PTA-${seed}`;
    let state = createInitialState();
    state = mustReduce(state, {
      ...createTask(taskId, 1, { initialPhase: "execution" }),
      skipAnalysis: true,
    });

    const terminalChoice = Math.floor(random() * 4);
    if (terminalChoice === 0) {
      state = mustReduce(state, {
        type: "TaskCompleted",
        taskId,
        ts: 2,
        stateRef: {
          branch: `task/${taskId}`,
          commit: `c-${taskId}`,
          parentCommit: `p-${taskId}`,
        },
      });
    } else if (terminalChoice === 1) {
      state = mustReduce(state, {
        type: "TaskFailed",
        taskId,
        ts: 2,
        reason: "budget_exhausted",
        phase: "execution",
        summary: {
          childId: null,
          approach: "attempt",
          whatFailed: "failed",
          whatWasLearned: "learned",
          artifactRef: null,
        },
      });
    } else if (terminalChoice === 2) {
      state = mustReduce(state, {
        type: "TaskBlocked",
        taskId,
        ts: 2,
        reason: "blocked",
        reasonCode: "blocked",
        summary: {
          childId: null,
          approach: "attempt",
          whatFailed: "blocked",
          whatWasLearned: "learned",
          artifactRef: null,
        },
        source: { type: "human", id: "tester" },
      });
    } else {
      state = mustReduce(state, {
        type: "TaskCanceled",
        taskId,
        ts: 2,
        reason: "manual",
        source: { type: "human", id: "tester" },
      });
    }

    for (let i = 0; i < 10; i += 1) {
      const choice = Math.floor(random() * 4);
      const ts = 10 + i;
      if (choice === 0) {
        expectReject(
          state,
          {
            type: "LeaseGranted",
            taskId,
            ts,
            fenceToken: i + 1,
            agentId: "coder",
            phase: "execution",
            leaseTimeout: 10_000,
            sessionId: `${taskId}-s-${i}`,
            sessionType: "fresh",
            contextBudget: 500,
            agentContext: {
              sessionId: `${taskId}-s-${i}`,
              agentId: "coder",
              memoryRef: null,
              contextTokens: null,
              modelId: "test",
            },
          },
          "terminal_absorption",
        );
      } else if (choice === 1) {
        expectReject(
          state,
          {
            type: "PhaseTransition",
            taskId,
            ts,
            from: { phase: "execution", condition: "active" },
            to: { phase: "analysis", condition: "ready" },
            reasonCode: "too_complex",
            reason: "too complex",
            fenceToken: 1,
            agentContext: {
              sessionId: `${taskId}-s-${i}`,
              agentId: "coder",
              memoryRef: null,
              contextTokens: 200,
              modelId: "gpt-5",
            },
          },
          "terminal_absorption",
        );
      } else if (choice === 2) {
        expectReject(
          state,
          {
            type: "TaskFailed",
            taskId,
            ts,
            reason: "budget_exhausted",
            phase: "execution",
            summary: {
              childId: null,
              approach: "attempt",
              whatFailed: "failed",
              whatWasLearned: "learned",
              artifactRef: null,
            },
          },
          "terminal_absorption",
        );
      } else {
      }
    }
  }
});

test("property C: fence token monotonicity", () => {
  for (let seed = 1; seed <= 50; seed += 1) {
    const taskId = `PF-${seed}`;
    let state = createInitialState();
    state = mustReduce(state, {
      ...createTask(taskId, 1, { initialPhase: "execution" }),
      skipAnalysis: true,
    });

    let ts = 2;
    for (let token = 1; token <= 5; token += 1) {
      state = mustReduce(state, {
        type: "LeaseGranted",
        taskId,
        ts,
        fenceToken: token,
        agentId: "coder",
        phase: "execution",
        leaseTimeout: 10_000,
        sessionId: `${taskId}-s-${token}`,
        sessionType: "fresh",
        contextBudget: 500,
        agentContext: {
          sessionId: `${taskId}-s-${token}`,
          agentId: "coder",
          memoryRef: null,
          contextTokens: null,
          modelId: "test",
        },
      });
      ts += 1;

      assert.equal(state.tasks[taskId]?.currentFenceToken, token);

      if (token > 1) {
        expectReject(
          state,
          {
            type: "AgentExited",
            taskId,
            ts,
            fenceToken: token - 1,
            exitCode: 0,
            reportedCost: 1,
            agentContext: {
              sessionId: `${taskId}-s-${token - 1}`,
              agentId: "coder",
              memoryRef: null,
              contextTokens: 200,
              modelId: "gpt-5",
            },
          },
          "stale_fence_token",
        );
      }

      state = mustReduce(state, {
        type: "RetryScheduled",
        taskId,
        ts,
        fenceToken: token,
        reason: "no_progress",
        retryAfter: ts + 1,
        phase: "execution",
        attemptNumber: token,
      });
      ts += 1;

      state = mustReduce(state, {
        type: "BackoffExpired",
        taskId,
        ts,
        phase: "execution",
        source: { type: "core", id: "clock" },
      });
      ts += 1;
    }

    assert.equal(state.tasks[taskId]?.currentFenceToken, 5);
  }
});

test("property D: attempt budget bounds", () => {
  const phases: Phase[] = ["analysis", "decomposition", "execution", "review"];

  for (let seed = 1; seed <= 50; seed += 1) {
    const random = mulberry32(seed);

    for (const phase of phases) {
      const max = 1 + Math.floor(random() * 5);
      const taskId = `PA-${seed}-${phase}`;
      let state = createInitialState();
      state = mustReduce(state, {
        ...createTask(taskId, 1, { initialPhase: phase }),
        skipAnalysis: phase === "execution",
        attemptBudgets: {
          analysis: { max: 5 },
          decomposition: { max: 5 },
          execution: { max: 5 },
          review: { max: 5 },
        },
      });
      state = mustReduce(state, {
        type: "TaskCanceled",
        taskId,
        ts: 2,
        reason: "manual",
        source: { type: "core", id: "reset" },
      });

      // Recreate task with random budget only for target phase to keep per-phase test isolated.
      state = mustReduce(state, {
        type: "TaskCreated",
        taskId: `${taskId}-run`,
        ts: 3,
        title: `Task ${taskId}-run`,
        description: "attempt bounds",
        parentId: null,
        rootId: `${taskId}-run`,
        initialPhase: phase,
        initialCondition: "ready",
        attemptBudgets: {
          analysis: { max: phase === "analysis" ? max : 5 },
          decomposition: { max: phase === "decomposition" ? max : 5 },
          execution: { max: phase === "execution" ? max : 5 },
          review: { max: phase === "review" ? max : 5 },
        },
        costBudget: 100,
        dependencies: [],
        reviewConfig: null,
        skipAnalysis: phase === "execution",
        metadata: {},
        source: { type: "middle", id: "planner" },
      });

      let ts = 4;
      for (let i = 1; i <= max; i += 1) {
        state = mustReduce(state, {
          type: "LeaseGranted",
          taskId: `${taskId}-run`,
          ts,
          fenceToken: i,
          agentId: "worker",
          phase,
          leaseTimeout: 10_000,
          sessionId: `${taskId}-run-s-${i}`,
          sessionType: "fresh",
          contextBudget: 300,
          agentContext: {
            sessionId: `${taskId}-run-s-${i}`,
            agentId: "worker",
            memoryRef: null,
            contextTokens: null,
            modelId: "test",
          },
        });
        ts += 1;

        const current = state.tasks[`${taskId}-run`];
        assert.ok(current);
        assert.ok(current.attempts[phase].used <= current.attempts[phase].max);

        state = mustReduce(state, {
          type: "RetryScheduled",
          taskId: `${taskId}-run`,
          ts,
          fenceToken: i,
          reason: "no_progress",
          retryAfter: ts + 1,
          phase,
          attemptNumber: i,
        });
        ts += 1;

        state = mustReduce(state, {
          type: "BackoffExpired",
          taskId: `${taskId}-run`,
          ts,
          phase,
          source: { type: "core", id: "clock" },
        });
        ts += 1;

        const bounded = state.tasks[`${taskId}-run`];
        assert.ok(bounded);
        assert.ok(bounded.attempts[phase].used <= bounded.attempts[phase].max);
      }

      expectReject(
        state,
        {
          type: "LeaseGranted",
          taskId: `${taskId}-run`,
          ts,
          fenceToken: max + 1,
          agentId: "worker",
          phase,
          leaseTimeout: 10_000,
          sessionId: `${taskId}-run-overflow`,
          sessionType: "fresh",
          contextBudget: 300,
          agentContext: {
            sessionId: `${taskId}-run-overflow`,
            agentId: "worker",
            memoryRef: null,
            contextTokens: null,
            modelId: "test",
          },
        },
        "attempt_budget_exhausted",
      );
    }
  }
});
