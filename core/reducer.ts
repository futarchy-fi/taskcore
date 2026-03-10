import {
  cloneAttemptBudgets,
  computeCostRemaining,
  createInitialState,
  DEFAULT_ATTEMPT_BUDGETS,
  type Event,
  type FailureSummary,
  isDependencyWait,
  type Phase,
  type ReduceResult,
  type Result,
  type SystemState,
  type Task,
  type TaskCreated,
  type TaskId,
  type Terminal,
  type ValidationError,
} from "./types.js";
import { validateEvent } from "./validator.js";

function deepCloneTask(task: Task): Task {
  return structuredClone(task);
}

function cloneState(state: SystemState): SystemState {
  return {
    tasks: { ...state.tasks },
    events: state.events.slice(),
    sequence: state.sequence,
  };
}

function withEvent(state: SystemState, event: Event): SystemState {
  const next = cloneState(state);
  const sequence = state.sequence + 1;
  next.sequence = sequence;
  next.events.push({ sequence, event });
  return next;
}

function sessionPolicyForPhase(phase: Phase): "fresh" | "continuable" {
  if (phase === "execution") {
    return "continuable";
  }
  return "fresh";
}

function toFailureSummary(summary: FailureSummary, childId: TaskId | null): FailureSummary {
  if (summary.childId !== null) {
    return summary;
  }
  return {
    ...summary,
    childId,
  };
}

function setTerminal(task: Task, terminal: Terminal, ts: number): void {
  task.phase = null;
  task.condition = null;
  task.terminal = terminal;
  task.leasedTo = null;
  task.leaseExpiresAt = null;
  task.retryAfter = null;
  task.waitState = null;
  task.lastAgentExitAt = null;
  task.updatedAt = ts;
}

function addParentFailureSummary(state: SystemState, task: Task, summary: FailureSummary, ts: number): void {
  if (task.parentId === null) {
    return;
  }

  const parent = state.tasks[task.parentId];
  if (!parent) {
    return;
  }

  const parentClone = deepCloneTask(parent);
  parentClone.failureSummaries.push(toFailureSummary(summary, task.id));
  parentClone.updatedAt = ts;
  state.tasks[parentClone.id] = parentClone;
}

function allBlockingBeforeStartDepsSatisfied(task: Task): boolean {
  return task.dependencies
    .filter((dependency) => dependency.blocking && dependency.timing === "before_start")
    .every((dependency) => dependency.status === "fulfilled");
}

function createTaskFromTaskCreated(event: TaskCreated): Task {
  const startPhase = event.skipAnalysis && event.initialPhase === "analysis" ? "execution" : event.initialPhase;
  const startCondition =
    event.initialCondition === "waiting" || allBlockingBeforeStartDepsSatisfied({
      id: event.taskId,
      title: event.title,
      description: event.description,
      parentId: event.parentId,
      rootId: event.rootId,
      phase: startPhase,
      condition: event.initialCondition,
      terminal: null,
      currentFenceToken: 0,
      leasedTo: null,
      leaseExpiresAt: null,
      retryAfter: null,
      lastAgentExitAt: null,
      attempts: cloneAttemptBudgets(event.attemptBudgets),
      cost: { allocated: event.costBudget, consumed: 0, childAllocated: 0, childRecovered: 0 },
      decompositionVersion: 0,
      children: [],
      checkpoints: [],
      costRecoveredToParent: false,
      triggeredCheckpoints: [],
      completionRule: "and",
      dependencies: event.dependencies,
      approachHistory: [],
      failureSummaries: [],
      failureDigestVersion: 0,
      terminalSummary: null,
      stateRef: null,
      checkpointRefs: [],
      reviewConfig: event.reviewConfig,
      reviewState: null,
      sessionPolicy: sessionPolicyForPhase(startPhase),
      currentSessionId: null,
      contextIsolation: event.reviewConfig?.isolationRules ?? [],
      contextBudget: 0,
      waitState: null,
      coordination: null,
      lastCompletionVerification: null,
      createdAt: event.ts,
      updatedAt: event.ts,
      metadata: event.metadata,
    })
      ? event.initialCondition
      : "waiting";

  return {
    id: event.taskId,
    title: event.title,
    description: event.description,
    parentId: event.parentId,
    rootId: event.rootId,
    phase: startPhase,
    condition: startCondition,
    terminal: null,
    currentFenceToken: 0,
    leasedTo: null,
    leaseExpiresAt: null,
    retryAfter: null,
    lastAgentExitAt: null,
    attempts: cloneAttemptBudgets(event.attemptBudgets),
    cost: {
      allocated: event.costBudget,
      consumed: 0,
      childAllocated: 0,
      childRecovered: 0,
    },
    decompositionVersion: 0,
    children: [],
    checkpoints: [],
    costRecoveredToParent: false,
    triggeredCheckpoints: [],
    completionRule: "and",
    dependencies: structuredClone(event.dependencies),
    approachHistory: [],
    failureSummaries: [],
    failureDigestVersion: 0,
    terminalSummary: null,
    stateRef: null,
    checkpointRefs: [],
    reviewConfig: event.reviewConfig,
    reviewState: null,
    sessionPolicy: sessionPolicyForPhase(startPhase),
    currentSessionId: null,
    contextIsolation: event.reviewConfig?.isolationRules ?? [],
    contextBudget: 0,
    waitState: null,
    coordination: null,
    lastCompletionVerification: null,
    createdAt: event.ts,
    updatedAt: event.ts,
    metadata: structuredClone(event.metadata),
  };
}

function createChildTaskFromDecomposition(parent: Task, event: Extract<Event, { type: "DecompositionCreated" }>, child: Extract<Event, { type: "DecompositionCreated" }>["children"][number]): Task {
  const attemptBudgets = child.attemptBudgets ?? DEFAULT_ATTEMPT_BUDGETS;
  const phase: Phase = child.skipAnalysis ? "execution" : "analysis";
  const condition = child.dependencies.some(
    (dependency) => dependency.blocking && dependency.timing === "before_start" && dependency.status !== "fulfilled",
  )
    ? "waiting"
    : "ready";

  return {
    id: child.taskId,
    title: child.title,
    description: child.description,
    parentId: parent.id,
    rootId: parent.rootId,
    phase,
    condition,
    terminal: null,
    currentFenceToken: 0,
    leasedTo: null,
    leaseExpiresAt: null,
    retryAfter: null,
    lastAgentExitAt: null,
    attempts: cloneAttemptBudgets(attemptBudgets),
    cost: {
      allocated: child.costAllocation,
      consumed: 0,
      childAllocated: 0,
      childRecovered: 0,
    },
    decompositionVersion: 0,
    children: [],
    checkpoints: [],
    costRecoveredToParent: false,
    triggeredCheckpoints: [],
    completionRule: "and",
    dependencies: structuredClone(child.dependencies),
    approachHistory: [],
    failureSummaries: [],
    failureDigestVersion: 0,
    terminalSummary: null,
    stateRef: null,
    checkpointRefs: [],
    reviewConfig: child.reviewConfig ?? null,
    reviewState: null,
    sessionPolicy: sessionPolicyForPhase(phase),
    currentSessionId: null,
    contextIsolation: child.reviewConfig?.isolationRules ?? [],
    contextBudget: 0,
    waitState: null,
    coordination: null,
    lastCompletionVerification: null,
    createdAt: event.ts,
    updatedAt: event.ts,
    metadata: structuredClone(child.metadata ?? {}),
  };
}

function applyTaskCreated(state: SystemState, event: Extract<Event, { type: "TaskCreated" }>): void {
  const task = createTaskFromTaskCreated(event);
  state.tasks[task.id] = task;

  if (task.parentId !== null) {
    const parent = state.tasks[task.parentId];
    if (parent) {
      const parentClone = deepCloneTask(parent);
      if (!parentClone.children.includes(task.id)) {
        parentClone.children.push(task.id);
      }
      parentClone.updatedAt = event.ts;
      state.tasks[parentClone.id] = parentClone;
    }
  }
}

function applyLeaseGranted(state: SystemState, event: Extract<Event, { type: "LeaseGranted" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.currentFenceToken = event.fenceToken;
  t.leasedTo = event.agentId;
  t.leaseExpiresAt = event.ts + event.leaseTimeout;
  t.phase = event.phase;
  t.condition = "active";
  t.retryAfter = null;
  t.waitState = null;
  t.currentSessionId = event.agentContext.sessionId;
  t.contextBudget = event.contextBudget;
  t.attempts[event.phase].used += 1;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyLeaseExpired(state: SystemState, event: Extract<Event, { type: "LeaseExpired" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.condition = "retryWait";
  t.leasedTo = null;
  t.leaseExpiresAt = null;
  t.retryAfter = event.ts;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyLeaseReleased(state: SystemState, event: Extract<Event, { type: "LeaseReleased" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.condition = "ready";
  t.leasedTo = null;
  t.leaseExpiresAt = null;
  t.retryAfter = null;
  t.currentSessionId = null;
  t.lastAgentExitAt = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyLeaseExtended(state: SystemState, event: Extract<Event, { type: "LeaseExtended" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.leaseExpiresAt = event.ts + event.leaseTimeout;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

// Legacy no-op: AgentStarted is now absorbed into LeaseGranted.
// Kept for backward compatibility with existing event journals.
function applyAgentStarted(_state: SystemState, _event: Extract<Event, { type: "AgentStarted" }>, _task: Task): void {
  // no-op
}

function applyCostReported(state: SystemState, event: Extract<Event, { type: "CostReported" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.cost.consumed += event.reportedCost;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyAgentExited(state: SystemState, event: Extract<Event, { type: "AgentExited" }>, task: Task): void {
  const t = deepCloneTask(task);
  const costToConsume = Math.max(1, Math.floor(event.reportedCost));
  t.cost.consumed += costToConsume;
  t.lastAgentExitAt = event.ts;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyPhaseTransition(state: SystemState, event: Extract<Event, { type: "PhaseTransition" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.phase = event.to.phase;
  t.condition = event.to.condition;
  t.sessionPolicy = sessionPolicyForPhase(event.to.phase);
  t.leasedTo = null;
  t.leaseExpiresAt = null;
  t.retryAfter = null;
  t.waitState = null;
  t.lastAgentExitAt = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyWaitRequested(state: SystemState, event: Extract<Event, { type: "WaitRequested" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.dependencies.push(structuredClone(event.dependency));
  t.condition = "waiting";
  t.waitState = {
    dependencyId: event.dependency.id,
    returnPhase: event.returnPhase,
    returnCondition: event.returnCondition,
  };
  t.lastAgentExitAt = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyWaitResolved(state: SystemState, event: Extract<Event, { type: "WaitResolved" }>, task: Task): void {
  const t = deepCloneTask(task);
  const dependency = t.dependencies.find((item) => item.id === event.dependencyId);
  if (dependency) {
    if (event.resolution === "fulfilled") {
      dependency.status = "fulfilled";
    } else if (event.resolution === "timed_out") {
      dependency.status = "timed_out";
    } else {
      dependency.status = "skipped";
    }
  }

  if (event.action === "resume") {
    if (t.waitState && isDependencyWait(t.waitState)) {
      const ws = t.waitState;
      t.phase = ws.returnPhase;
      t.condition = ws.returnCondition;
      t.sessionPolicy = sessionPolicyForPhase(ws.returnPhase);
    } else {
      t.condition = "active";
    }
    t.waitState = null;
    t.lastAgentExitAt = null;
  } else if (event.action === "redirect_to_analysis") {
    t.phase = "analysis";
    t.condition = "ready";
    t.sessionPolicy = sessionPolicyForPhase("analysis");
    t.waitState = null;
  } else if (event.action === "redirect_wait") {
    t.waitState = null;
  } else if (event.action === "block") {
    setTerminal(t, "blocked", event.ts);
    if (event.summary) {
      t.terminalSummary = event.summary;
      t.failureSummaries.push(toFailureSummary(event.summary, null));
    }
  }

  t.updatedAt = event.ts;
  state.tasks[t.id] = t;

  if (event.action === "block" && event.summary) {
    addParentFailureSummary(state, t, event.summary, event.ts);
  }
}

function applyDependencySatisfied(state: SystemState, event: Extract<Event, { type: "DependencySatisfied" }>, task: Task): void {
  const t = deepCloneTask(task);
  const dependency = t.dependencies.find((item) => item.id === event.dependencyId);
  if (dependency) {
    dependency.status = "fulfilled";
  }

  if (t.condition === "waiting" && allBlockingBeforeStartDepsSatisfied(t)) {
    if (t.waitState && isDependencyWait(t.waitState)) {
      const ws = t.waitState;
      t.phase = ws.returnPhase;
      t.condition = ws.returnCondition;
      t.sessionPolicy = sessionPolicyForPhase(ws.returnPhase);
      t.waitState = null;
    } else if (!t.waitState) {
      t.condition = "ready";
    }
    // If waitState is sibling_turn, don't change condition — wait for ChildActivated
  }

  t.lastAgentExitAt = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyRetryScheduled(state: SystemState, event: Extract<Event, { type: "RetryScheduled" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.condition = "retryWait";
  t.retryAfter = event.retryAfter;
  t.leasedTo = null;
  t.leaseExpiresAt = null;
  t.waitState = null;
  t.lastAgentExitAt = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyBackoffExpired(state: SystemState, event: Extract<Event, { type: "BackoffExpired" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.condition = "ready";
  t.retryAfter = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyDecompositionCreated(state: SystemState, event: Extract<Event, { type: "DecompositionCreated" }>, task: Task): void {
  const t = deepCloneTask(task);

  if (event.version > 1) {
    for (const childId of t.children) {
      const child = state.tasks[childId];
      if (!child || child.terminal !== null) {
        continue;
      }
      const childClone = deepCloneTask(child);
      childClone.terminal = "canceled";
      childClone.phase = null;
      childClone.condition = null;
      childClone.updatedAt = event.ts;
      state.tasks[childClone.id] = childClone;
    }

    for (const approach of t.approachHistory) {
      if (approach.outcome === "active") {
        approach.outcome = "superseded";
      }
    }
  }

  const totalChildCost = event.children.reduce((sum, child) => sum + child.costAllocation, 0);
  t.cost.childAllocated += totalChildCost;
  t.decompositionVersion = event.version;
  t.checkpoints = [...event.checkpoints];
  t.triggeredCheckpoints = [];
  t.completionRule = event.completionRule;

  const childIds: TaskId[] = [];
  for (const childSpec of event.children) {
    const childTask = createChildTaskFromDecomposition(t, event, childSpec);
    childIds.push(childTask.id);
    t.children.push(childTask.id);
    state.tasks[childTask.id] = childTask;
  }

  t.approachHistory.push({
    version: event.version,
    description: `decomposition v${event.version}`,
    childIds,
    outcome: "active",
    failureSummary: null,
  });

  // Sequential coordination: park all children except the first
  if (event.coordinationMode?.mode === "sequential_children" && childIds.length > 0) {
    const firstChildId = childIds[0]!;
    for (let i = 1; i < childIds.length; i++) {
      const childId = childIds[i]!;
      const child = state.tasks[childId];
      if (child) {
        const childClone = deepCloneTask(child);
        childClone.condition = "waiting";
        childClone.waitState = { kind: "sibling_turn", parentId: t.id };
        childClone.updatedAt = event.ts;
        state.tasks[childClone.id] = childClone;
      }
    }

    t.coordination = {
      mode: "sequential_children",
      reviewBetweenChildren: event.coordinationMode.reviewBetweenChildren,
      childOrder: [...childIds],
      nextChildIndex: 1,
      activeChildId: firstChildId,
      lastCompletedChildId: null,
    };
  }

  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyChildActivated(state: SystemState, event: Extract<Event, { type: "ChildActivated" }>, task: Task): void {
  // task = the child being activated (event.taskId)
  const childClone = deepCloneTask(task);
  childClone.condition = "ready";
  childClone.waitState = null;
  childClone.updatedAt = event.ts;
  state.tasks[childClone.id] = childClone;

  // Update parent's coordination state
  const parent = state.tasks[event.parentId];
  if (parent && parent.coordination) {
    const parentClone = deepCloneTask(parent);
    parentClone.coordination = { ...parentClone.coordination! };
    parentClone.coordination.lastCompletedChildId = parentClone.coordination.activeChildId;
    parentClone.coordination.activeChildId = event.taskId;
    parentClone.coordination.nextChildIndex = event.index + 1;
    parentClone.updatedAt = event.ts;
    state.tasks[parentClone.id] = parentClone;
  }
}

function applyChildReviewDecisionSubmitted(
  state: SystemState,
  event: Extract<Event, { type: "ChildReviewDecisionSubmitted" }>,
  task: Task,
): void {
  const t = deepCloneTask(task);

  if (!t.coordination) return;
  const coord = { ...t.coordination };

  coord.lastCompletedChildId = event.childId;

  switch (event.decision) {
    case "continue_next_child": {
      if (coord.nextChildIndex < coord.childOrder.length) {
        const nextChildId = coord.childOrder[coord.nextChildIndex]!;
        const nextChild = state.tasks[nextChildId];

        // Activate the next child
        if (nextChild && nextChild.terminal === null) {
          const nextClone = deepCloneTask(nextChild);
          nextClone.condition = "ready";
          nextClone.waitState = null;
          nextClone.updatedAt = event.ts;
          state.tasks[nextClone.id] = nextClone;
        }

        coord.activeChildId = nextChildId;
        coord.nextChildIndex += 1;

        // Parent goes back to waiting for the next child
        t.condition = "waiting";
        t.leasedTo = null;
        t.leaseExpiresAt = null;
        t.retryAfter = null;
        t.lastAgentExitAt = null;
      }
      // If no more children, parent stays analysis.active — agent decides next
      break;
    }

    case "redecompose_remaining": {
      // Cancel remaining non-terminal children
      for (let i = coord.nextChildIndex; i < coord.childOrder.length; i++) {
        const childId = coord.childOrder[i]!;
        const child = state.tasks[childId];
        if (child && child.terminal === null) {
          const childClone = deepCloneTask(child);
          childClone.terminal = "canceled";
          childClone.phase = null;
          childClone.condition = null;
          childClone.waitState = null;
          childClone.updatedAt = event.ts;
          state.tasks[childClone.id] = childClone;
        }
      }

      // Parent transitions to decomposition.ready
      t.phase = "decomposition";
      t.condition = "ready";
      t.sessionPolicy = sessionPolicyForPhase("decomposition");
      t.leasedTo = null;
      t.leaseExpiresAt = null;
      t.retryAfter = null;
      t.lastAgentExitAt = null;
      break;
    }

    case "stop_children": {
      // Parent stays analysis.active — agent decides what to do next
      break;
    }
  }

  t.coordination = coord;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyChildCostRecovered(state: SystemState, event: Extract<Event, { type: "ChildCostRecovered" }>, task: Task): void {
  const t = deepCloneTask(task);

  const child = state.tasks[event.childId];
  let recoveredAmount = event.recoveredAmount;
  if (child) {
    const childClone = deepCloneTask(child);
    const childRemaining = Math.max(0, computeCostRemaining(childClone.cost));
    recoveredAmount = Math.min(recoveredAmount, childRemaining);
    childClone.cost.allocated = Math.max(0, childClone.cost.allocated - recoveredAmount);
    childClone.costRecoveredToParent = true;
    childClone.updatedAt = event.ts;
    state.tasks[childClone.id] = childClone;
  }

  t.cost.childRecovered += recoveredAmount;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyCheckpointTriggered(state: SystemState, event: Extract<Event, { type: "CheckpointTriggered" }>, task: Task): void {
  const t = deepCloneTask(task);
  if (!t.triggeredCheckpoints.includes(event.childId)) {
    t.triggeredCheckpoints.push(event.childId);
  }
  t.phase = "analysis";
  t.condition = "ready";
  t.sessionPolicy = sessionPolicyForPhase("analysis");
  t.waitState = null;
  t.leasedTo = null;
  t.leaseExpiresAt = null;
  t.retryAfter = null;
  t.lastAgentExitAt = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyCheckpointCreated(state: SystemState, event: Extract<Event, { type: "CheckpointCreated" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.checkpointRefs.push({
    id: event.checkpointId,
    stateRef: structuredClone(event.stateRef),
    createdAt: event.ts,
    reason: event.reason,
    phase: event.phase,
    condition: event.condition,
  });
  t.stateRef = structuredClone(event.stateRef);
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyStateReverted(state: SystemState, event: Extract<Event, { type: "StateReverted" }>, task: Task): void {
  const t = deepCloneTask(task);
  const checkpoint = t.checkpointRefs.find((item) => item.id === event.revertTo);
  t.stateRef = structuredClone(event.targetStateRef);
  if (checkpoint) {
    t.phase = checkpoint.phase;
    t.condition = checkpoint.condition;
    t.sessionPolicy = sessionPolicyForPhase(checkpoint.phase);
  } else {
    t.phase = "analysis";
    t.condition = "ready";
    t.sessionPolicy = sessionPolicyForPhase("analysis");
  }
  t.leasedTo = null;
  t.leaseExpiresAt = null;
  t.retryAfter = null;
  t.waitState = null;
  t.lastAgentExitAt = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyReviewVerdictSubmitted(
  state: SystemState,
  event: Extract<Event, { type: "ReviewVerdictSubmitted" }>,
  task: Task,
): void {
  const t = deepCloneTask(task);
  const reviewState =
    t.reviewState ?? {
      round: event.round,
      verdicts: [],
      status: "collecting" as const,
    };

  reviewState.round = Math.max(reviewState.round, event.round);
  reviewState.verdicts.push({
    reviewer: event.reviewer,
    round: event.round,
    verdict: event.verdict,
    reasoning: event.reasoning,
  });

  t.reviewState = reviewState;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyReviewPolicyMet(state: SystemState, event: Extract<Event, { type: "ReviewPolicyMet" }>, task: Task): void {
  const t = deepCloneTask(task);
  const reviewState =
    t.reviewState ?? {
      round: 1,
      verdicts: [],
      status: "collecting" as const,
    };

  if (event.outcome === "approved") {
    reviewState.status = "consensus";
  } else if (event.outcome === "escalated") {
    reviewState.status = "escalated";
  } else {
    reviewState.status = "collecting";
  }

  t.reviewState = reviewState;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyTaskCompleted(state: SystemState, event: Extract<Event, { type: "TaskCompleted" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.stateRef = structuredClone(event.stateRef);
  setTerminal(t, "done", event.ts);

  const activeApproach = t.approachHistory.find((approach) => approach.outcome === "active");
  if (activeApproach) {
    activeApproach.outcome = "succeeded";
  }

  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyTaskFailed(state: SystemState, event: Extract<Event, { type: "TaskFailed" }>, task: Task): void {
  const t = deepCloneTask(task);
  const summary = toFailureSummary(event.summary, null);
  t.terminalSummary = summary;
  t.failureSummaries.push(summary);
  const activeApproach = t.approachHistory.find((approach) => approach.outcome === "active");
  if (activeApproach) {
    activeApproach.outcome = "failed";
    activeApproach.failureSummary = summary.whatFailed;
  }
  setTerminal(t, "failed", event.ts);
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
  addParentFailureSummary(state, t, summary, event.ts);
}

function applyTaskBlocked(state: SystemState, event: Extract<Event, { type: "TaskBlocked" }>, task: Task): void {
  const t = deepCloneTask(task);
  const summary = toFailureSummary(event.summary, null);
  t.terminalSummary = summary;
  t.failureSummaries.push(summary);
  const activeApproach = t.approachHistory.find((approach) => approach.outcome === "active");
  if (activeApproach) {
    activeApproach.outcome = "failed";
    activeApproach.failureSummary = summary.whatFailed;
  }
  setTerminal(t, "blocked", event.ts);
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
  addParentFailureSummary(state, t, summary, event.ts);
}

function applyTaskExhausted(state: SystemState, event: Extract<Event, { type: "TaskExhausted" }>, task: Task): void {
  const t = deepCloneTask(task);
  t.condition = "exhausted";
  t.leasedTo = null;
  t.leaseExpiresAt = null;
  t.retryAfter = null;
  t.waitState = null;
  t.lastAgentExitAt = null;
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyBudgetIncreased(state: SystemState, event: Extract<Event, { type: "BudgetIncreased" }>, task: Task): void {
  const t = deepCloneTask(task);

  if (event.costBudgetIncrease > 0) {
    t.cost.allocated += event.costBudgetIncrease;
  }

  if (event.attemptBudgetIncrease) {
    for (const phase of ["analysis", "decomposition", "execution", "review"] as const) {
      const entry = event.attemptBudgetIncrease[phase];
      if (entry) {
        t.attempts[phase].max = entry.max;
      }
    }
  }

  // If task is exhausted and budget is now sufficient, transition back to ready
  if (t.condition === "exhausted" && t.phase !== null) {
    const attempt = t.attempts[t.phase];
    const hasAttempts = attempt.used < attempt.max;
    const hasCost = computeCostRemaining(t.cost) > 0;
    if (hasAttempts && hasCost) {
      t.condition = "ready";
    }
  }

  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyTaskCanceled(state: SystemState, event: Extract<Event, { type: "TaskCanceled" }>, task: Task): void {
  const t = deepCloneTask(task);
  setTerminal(t, "canceled", event.ts);
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyTaskRevived(state: SystemState, event: Extract<Event, { type: "TaskRevived" }>, task: Task): void {
  const t = deepCloneTask(task);

  // Clear terminal state, restore to ready condition at the specified phase
  t.terminal = null;
  t.phase = event.phase;
  t.condition = "ready";
  t.retryAfter = null;
  t.leasedTo = null;
  t.leaseExpiresAt = null;
  t.lastAgentExitAt = null;

  // Reset attempt counters for specified phases
  for (const phase of event.resetAttempts) {
    if (t.attempts[phase]) {
      t.attempts[phase].used = 0;
    }
  }

  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyMetadataUpdated(state: SystemState, event: Extract<Event, { type: "MetadataUpdated" }>, task: Task): void {
  const t = deepCloneTask(task);

  for (const [key, value] of Object.entries(event.patch)) {
    if (value === null) {
      delete t.metadata[key];
    } else {
      t.metadata[key] = value;
    }
  }

  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyCompletionVerificationRecorded(
  state: SystemState,
  event: Extract<Event, { type: "CompletionVerificationRecorded" }>,
  task: Task,
): void {
  const t = deepCloneTask(task);
  t.lastCompletionVerification = structuredClone(event.verification);
  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyTaskReparented(state: SystemState, event: Extract<Event, { type: "TaskReparented" }>, task: Task): void {
  const t = deepCloneTask(task);

  // Remove from old parent's children[]
  if (t.parentId !== null) {
    const oldParent = state.tasks[t.parentId];
    if (oldParent) {
      const oldParentClone = deepCloneTask(oldParent);
      oldParentClone.children = oldParentClone.children.filter((id) => id !== t.id);
      oldParentClone.updatedAt = event.ts;
      state.tasks[oldParentClone.id] = oldParentClone;
    }
  }

  // Update task's parentId and rootId
  t.parentId = event.newParentId;
  t.rootId = event.newRootId;

  // Add to new parent's children[]
  const newParent = state.tasks[event.newParentId];
  if (newParent) {
    const newParentClone = deepCloneTask(newParent);
    if (!newParentClone.children.includes(t.id)) {
      newParentClone.children.push(t.id);
    }
    newParentClone.updatedAt = event.ts;
    state.tasks[newParentClone.id] = newParentClone;
  }

  // Transitively update rootId for all descendants (BFS)
  const queue: TaskId[] = [...t.children];
  while (queue.length > 0) {
    const childId = queue.shift()!;
    const child = state.tasks[childId];
    if (!child) continue;
    if (child.rootId !== event.newRootId) {
      const childClone = deepCloneTask(child);
      childClone.rootId = event.newRootId;
      childClone.updatedAt = event.ts;
      state.tasks[childClone.id] = childClone;
      queue.push(...childClone.children);
    }
  }

  t.updatedAt = event.ts;
  state.tasks[t.id] = t;
}

function applyUnchecked(state: SystemState, event: Event): void {
  if (event.type === "TaskCreated") {
    applyTaskCreated(state, event);
    return;
  }

  const task = state.tasks[event.taskId];
  if (!task) {
    return;
  }

  switch (event.type) {
    case "LeaseGranted":
      applyLeaseGranted(state, event, task);
      break;
    case "LeaseExpired":
      applyLeaseExpired(state, event, task);
      break;
    case "LeaseReleased":
      applyLeaseReleased(state, event, task);
      break;
    case "LeaseExtended":
      applyLeaseExtended(state, event, task);
      break;
    case "AgentStarted":
      applyAgentStarted(state, event, task);
      break;
    case "AgentExited":
      applyAgentExited(state, event, task);
      break;
    case "CostReported":
      applyCostReported(state, event, task);
      break;
    case "PhaseTransition":
      applyPhaseTransition(state, event, task);
      break;
    case "WaitRequested":
      applyWaitRequested(state, event, task);
      break;
    case "WaitResolved":
      applyWaitResolved(state, event, task);
      break;
    case "DependencySatisfied":
      applyDependencySatisfied(state, event, task);
      break;
    case "RetryScheduled":
      applyRetryScheduled(state, event, task);
      break;
    case "BackoffExpired":
      applyBackoffExpired(state, event, task);
      break;
    case "DecompositionCreated":
      applyDecompositionCreated(state, event, task);
      break;
    case "ChildActivated":
      applyChildActivated(state, event, task);
      break;
    case "ChildReviewDecisionSubmitted":
      applyChildReviewDecisionSubmitted(state, event, task);
      break;
    case "ChildCostRecovered":
      applyChildCostRecovered(state, event, task);
      break;
    case "CheckpointTriggered":
      applyCheckpointTriggered(state, event, task);
      break;
    case "CheckpointCreated":
      applyCheckpointCreated(state, event, task);
      break;
    case "StateReverted":
      applyStateReverted(state, event, task);
      break;
    case "ReviewVerdictSubmitted":
      applyReviewVerdictSubmitted(state, event, task);
      break;
    case "ReviewPolicyMet":
      applyReviewPolicyMet(state, event, task);
      break;
    case "TaskCompleted":
      applyTaskCompleted(state, event, task);
      break;
    case "TaskFailed":
      applyTaskFailed(state, event, task);
      break;
    case "TaskExhausted":
      applyTaskExhausted(state, event, task);
      break;
    case "BudgetIncreased":
      applyBudgetIncreased(state, event, task);
      break;
    case "TaskBlocked":
      applyTaskBlocked(state, event, task);
      break;
    case "TaskCanceled":
      applyTaskCanceled(state, event, task);
      break;
    case "TaskRevived":
      applyTaskRevived(state, event, task);
      break;
    case "TaskReparented":
      applyTaskReparented(state, event, task);
      break;
    case "MetadataUpdated":
      applyMetadataUpdated(state, event, task);
      break;
    case "CompletionVerificationRecorded":
      applyCompletionVerificationRecorded(state, event, task);
      break;
    default: {
      const neverEvent: never = event;
      throw new Error(`Unhandled event type ${(neverEvent as { type: string }).type}`);
    }
  }
}

export function reduce(state: SystemState, event: Event): Result<ReduceResult, ValidationError> {
  const validation = validateEvent(state, event);
  if (validation) {
    return { ok: false, error: validation };
  }

  const withLog = withEvent(state, event);
  applyUnchecked(withLog, event);

  return {
    ok: true,
    value: {
      state: withLog,
      emitted: [],
    },
  };
}

export function replay(events: Event[]): Result<SystemState, ValidationError> {
  let state = createInitialState();
  for (const event of events) {
    const result = reduce(state, event);
    if (!result.ok) {
      return result;
    }
    state = result.value.state;
  }
  return { ok: true, value: state };
}

export function getRemainingCost(task: Task): number {
  return computeCostRemaining(task.cost);
}
