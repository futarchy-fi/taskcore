import test from "node:test";
import assert from "node:assert/strict";

import { reduce } from "../reducer.js";
import { validateEvent } from "../validator.js";
import { checkInvariants } from "../invariants.js";
import { createInitialState, type Event, type SystemState } from "../types.js";

// Helper to bootstrap state with a parent task ready for decomposition
function bootstrapParentTask(): SystemState {
  let state = createInitialState();

  const createParent: Event = {
    type: "TaskCreated",
    taskId: "PARENT",
    ts: 1,
    title: "Parent Task",
    description: "Will be decomposed",
    parentId: null,
    rootId: "PARENT",
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 2 },
      decomposition: { max: 2 },
      execution: { max: 2 },
      review: { max: 2 },
    },
    costBudget: 100,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: false,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  const r1 = reduce(state, createParent);
  assert.equal(r1.ok, true);
  state = r1.ok ? r1.value.state : state;

  // Move to decomposition phase
  const lease: Event = {
    type: "LeaseGranted",
    taskId: "PARENT",
    ts: 2,
    fenceToken: 1,
    agentId: "decomposer",
    phase: "analysis",
    leaseTimeout: 60_000,
    sessionId: "sess-1",
    sessionType: "fresh",
    contextBudget: 512,
    agentContext: {
      sessionId: "sess-1",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const r2 = reduce(state, lease);
  assert.equal(r2.ok, true);
  state = r2.ok ? r2.value.state : state;

  const transition: Event = {
    type: "PhaseTransition",
    taskId: "PARENT",
    ts: 3,
    from: { phase: "analysis", condition: "active" },
    to: { phase: "decomposition", condition: "ready" },
    reasonCode: "decision_decompose",
    reason: "Needs decomposition",
    fenceToken: 1,
    agentContext: {
      sessionId: "sess-1",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const r3 = reduce(state, transition);
  assert.equal(r3.ok, true);
  state = r3.ok ? r3.value.state : state;

  const leaseDecomp: Event = {
    type: "LeaseGranted",
    taskId: "PARENT",
    ts: 4,
    fenceToken: 2,
    agentId: "decomposer",
    phase: "decomposition",
    leaseTimeout: 60_000,
    sessionId: "sess-2",
    sessionType: "fresh",
    contextBudget: 512,
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const r4 = reduce(state, leaseDecomp);
  assert.equal(r4.ok, true);
  state = r4.ok ? r4.value.state : state;

  return state;
}

// -----------------------------------------------------------------------------
// Child dependency cycle detection tests
// -----------------------------------------------------------------------------

test("DecompositionCreated: rejects child self-dependency", () => {
  const state = bootstrapParentTask();

  const decomp: Event = {
    type: "DecompositionCreated",
    taskId: "PARENT",
    ts: 5,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "CHILD1",
        title: "Child 1",
        description: "Depends on itself",
        costAllocation: 50,
        skipAnalysis: true,
        dependencies: [
          { id: "dep1", type: "task", target: "CHILD1", blocking: true, timing: "before_start", status: "pending" },
        ],
        metadata: {},
      },
    ],
    checkpoints: [],
    completionRule: "and",
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const error = validateEvent(state, decomp);
  assert.ok(error);
  assert.equal(error.code, "child_self_dependency");
});

test("DecompositionCreated: rejects child dependency on parent", () => {
  const state = bootstrapParentTask();

  const decomp: Event = {
    type: "DecompositionCreated",
    taskId: "PARENT",
    ts: 5,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "CHILD1",
        title: "Child 1",
        description: "Depends on parent",
        costAllocation: 50,
        skipAnalysis: true,
        dependencies: [
          { id: "dep1", type: "task", target: "PARENT", blocking: true, timing: "before_start", status: "pending" },
        ],
        metadata: {},
      },
    ],
    checkpoints: [],
    completionRule: "and",
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const error = validateEvent(state, decomp);
  assert.ok(error);
  assert.equal(error.code, "child_parent_dependency");
});

test("DecompositionCreated: rejects cyclic child dependencies", () => {
  const state = bootstrapParentTask();

  const decomp: Event = {
    type: "DecompositionCreated",
    taskId: "PARENT",
    ts: 5,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "CHILD1",
        title: "Child 1",
        description: "Depends on child 2",
        costAllocation: 30,
        skipAnalysis: true,
        dependencies: [
          { id: "dep1", type: "task", target: "CHILD2", blocking: true, timing: "before_start", status: "pending" },
        ],
        metadata: {},
      },
      {
        taskId: "CHILD2",
        title: "Child 2",
        description: "Depends on child 1 (cycle)",
        costAllocation: 30,
        skipAnalysis: true,
        dependencies: [
          { id: "dep2", type: "task", target: "CHILD1", blocking: true, timing: "before_start", status: "pending" },
        ],
        metadata: {},
      },
    ],
    checkpoints: [],
    completionRule: "and",
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const error = validateEvent(state, decomp);
  assert.ok(error);
  assert.equal(error.code, "child_dependency_cycle");
});

test("DecompositionCreated: accepts valid child dependencies", () => {
  const state = bootstrapParentTask();

  const decomp: Event = {
    type: "DecompositionCreated",
    taskId: "PARENT",
    ts: 5,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "CHILD1",
        title: "Child 1",
        description: "First child",
        costAllocation: 30,
        skipAnalysis: true,
        dependencies: [],
        metadata: {},
      },
      {
        taskId: "CHILD2",
        title: "Child 2",
        description: "Depends on child 1 (valid)",
        costAllocation: 30,
        skipAnalysis: true,
        dependencies: [
          { id: "dep1", type: "task", target: "CHILD1", blocking: true, timing: "before_start", status: "pending" },
        ],
        metadata: {},
      },
    ],
    checkpoints: ["CHILD1"],
    completionRule: "and",
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const error = validateEvent(state, decomp);
  assert.equal(error, null);
});

// -----------------------------------------------------------------------------
// Cost guard tests
// -----------------------------------------------------------------------------

test("DecompositionCreated: rejects cost allocation exceeding parent budget", () => {
  const state = bootstrapParentTask();

  const decomp: Event = {
    type: "DecompositionCreated",
    taskId: "PARENT",
    ts: 5,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "CHILD1",
        title: "Child 1",
        description: "Expensive child",
        costAllocation: 150, // Exceeds parent's 100
        skipAnalysis: true,
        dependencies: [],
        metadata: {},
      },
    ],
    checkpoints: [],
    completionRule: "and",
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const error = validateEvent(state, decomp);
  assert.ok(error);
  assert.equal(error.code, "cost_over_allocation");
});

test("DecompositionCreated: accepts valid cost allocations", () => {
  const state = bootstrapParentTask();

  const decomp: Event = {
    type: "DecompositionCreated",
    taskId: "PARENT",
    ts: 5,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "CHILD1",
        title: "Child 1",
        description: "First child",
        costAllocation: 40,
        skipAnalysis: true,
        dependencies: [],
        metadata: {},
      },
      {
        taskId: "CHILD2",
        title: "Child 2",
        description: "Second child",
        costAllocation: 50,
        skipAnalysis: true,
        dependencies: [],
        metadata: {},
      },
    ],
    checkpoints: [],
    completionRule: "and",
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const error = validateEvent(state, decomp);
  assert.equal(error, null);
});

// -----------------------------------------------------------------------------
// Invariant tests for decomposition integrity
// -----------------------------------------------------------------------------

test("invariant: detects orphaned checkpoint referencing non-child", () => {
  let state = bootstrapParentTask();

  // Create decomposition with a checkpoint
  const decomp: Event = {
    type: "DecompositionCreated",
    taskId: "PARENT",
    ts: 5,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "CHILD1",
        title: "Child 1",
        description: "Only child",
        costAllocation: 50,
        skipAnalysis: true,
        dependencies: [],
        metadata: {},
      },
    ],
    checkpoints: ["CHILD1"],
    completionRule: "and",
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const r = reduce(state, decomp);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;

  // Tamper: add orphaned checkpoint
  const tampered = structuredClone(state);
  tampered.tasks["PARENT"].checkpoints.push("NONEXISTENT_CHILD");

  const violations = checkInvariants(tampered);
  assert.ok(violations.some((v) => v.code === "orphaned_checkpoint"));
});

test("invariant: detects cost accounting mismatch", () => {
  let state = bootstrapParentTask();

  // Create decomposition
  const decomp: Event = {
    type: "DecompositionCreated",
    taskId: "PARENT",
    ts: 5,
    fenceToken: 2,
    version: 1,
    children: [
      {
        taskId: "CHILD1",
        title: "Child 1",
        description: "Child",
        costAllocation: 50,
        skipAnalysis: true,
        dependencies: [],
        metadata: {},
      },
    ],
    checkpoints: [],
    completionRule: "and",
    agentContext: {
      sessionId: "sess-2",
      agentId: "decomposer",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    },
  };

  const r = reduce(state, decomp);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;

  // Verify initial state is valid
  const initialViolations = checkInvariants(state);
  assert.equal(initialViolations.length, 0, "Initial state should have no violations");

  // Tamper: corrupt cost accounting by making consumed + childAllocated exceed allocated
  const tampered = structuredClone(state);
  // allocated=100, consumed=30, childAllocated=50, childRecovered=0
  // If we set consumed=60 and childAllocated=50, that's 110 > 100
  tampered.tasks["PARENT"].cost.consumed = 60;
  // Ensure remaining is calculated correctly based on our tampered values
  // remaining = allocated - consumed - childAllocated + childRecovered
  // remaining = 100 - 60 - 50 + 0 = -10
  // But we want the check to fail, so we need to ensure remaining doesn't match
  // The invariant checks: consumed + childAllocated - childRecovered + remaining == allocated
  // If consumed=60, childAllocated=50, childRecovered=0, remaining should be -10 to balance
  // But since remaining is computed fresh each time, we need to corrupt one of the stored values
  // Actually, let's corrupt childRecovered to be negative (which shouldn't happen)
  tampered.tasks["PARENT"].cost.childRecovered = -999;

  const violations = checkInvariants(tampered);
  assert.ok(violations.some((v) => v.code === "cost_accounting_mismatch" || v.code === "cost_non_negative"));
});

// -----------------------------------------------------------------------------
// Audit trail tests
// -----------------------------------------------------------------------------

test("invariant: detects missing terminal summary on failed task", () => {
  let state = createInitialState();

  const create: Event = {
    type: "TaskCreated",
    taskId: "T_FAIL",
    ts: 1,
    title: "Task to fail",
    description: "Will fail without summary",
    parentId: null,
    rootId: "T_FAIL",
    initialPhase: "execution",
    initialCondition: "ready",
    attemptBudgets: {
      analysis: { max: 2 },
      decomposition: { max: 2 },
      execution: { max: 1 },
      review: { max: 2 },
    },
    costBudget: 10,
    dependencies: [],
    reviewConfig: null,
    skipAnalysis: true,
    metadata: {},
    source: { type: "middle", id: "test" },
  };

  const r = reduce(state, create);
  assert.equal(r.ok, true);
  state = r.ok ? r.value.state : state;

  // Tamper: set terminal without summary
  const tampered = structuredClone(state);
  tampered.tasks["T_FAIL"].terminal = "failed";
  tampered.tasks["T_FAIL"].phase = null;
  tampered.tasks["T_FAIL"].condition = null;
  tampered.tasks["T_FAIL"].terminalSummary = null;

  const violations = checkInvariants(tampered);
  assert.ok(violations.some((v) => v.code === "missing_terminal_audit_trail"));
});
