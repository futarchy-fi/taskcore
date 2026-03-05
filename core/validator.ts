import {
  type Condition,
  computeCostRemaining,
  type DecompositionChildSpec,
  DEFAULT_ATTEMPT_BUDGETS,
  type Event,
  type EventType,
  type FailureSummary,
  type Phase,
  type PhaseTransitionReason,
  type SystemState,
  type Task,
  type TaskCreated,
  type ValidationError,
} from "./types.js";

const CORE_ONLY_EVENTS = new Set<EventType>([
  "LeaseExpired",
  "BackoffExpired",
  "DependencySatisfied",
  "ChildCostRecovered",
  "CheckpointTriggered",
  "TaskExhausted",
]);

const MIDDLE_ONLY_EVENTS = new Set<EventType>(["ReviewPolicyMet"]);

const PHASE_TRANSITION_TABLE = new Set<string>([
  transitionKey("analysis", "active", "execution", "ready", "decision_execute"),
  transitionKey("analysis", "active", "decomposition", "ready", "decision_decompose"),
  transitionKey("execution", "active", "review", "ready", "work_complete"),
  transitionKey("execution", "active", "analysis", "ready", "too_complex"),
  transitionKey("execution", "active", "analysis", "ready", "approach_not_viable"),
  transitionKey("review", "active", "execution", "ready", "changes_requested"),
  transitionKey("review", "active", "analysis", "ready", "wrong_approach"),
  transitionKey("review", "active", "analysis", "ready", "needs_redecomp"),
  transitionKey("review", "active", "decomposition", "ready", "add_children"),
  transitionKey("decomposition", "active", "review", "waiting", "children_created"),
  transitionKey("review", "waiting", "review", "ready", "children_complete"),
  transitionKey("review", "waiting", "analysis", "ready", "children_all_failed"),
]);

function transitionKey(
  fromPhase: Phase,
  fromCondition: Condition,
  toPhase: Phase,
  toCondition: Condition,
  reason: PhaseTransitionReason,
): string {
  return `${fromPhase}.${fromCondition}->${toPhase}.${toCondition}:${reason}`;
}

function mkError(event: Event, code: string, message: string, details?: Record<string, unknown>): ValidationError {
  const error: ValidationError = {
    code,
    message,
    taskId: event.taskId,
    eventType: event.type,
  };

  if (details !== undefined) {
    error.details = details;
  }

  return error;
}

function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

function nonEmptyText(value: string): boolean {
  return value.trim().length > 0;
}

function validFailureSummary(summary: FailureSummary | undefined): boolean {
  if (!summary) {
    return false;
  }

  return (
    nonEmptyText(summary.approach) &&
    nonEmptyText(summary.whatFailed) &&
    nonEmptyText(summary.whatWasLearned)
  );
}

function duplicateIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) {
      dup.add(id);
    }
    seen.add(id);
  }
  return [...dup];
}

function validateAttemptBudgetShape(event: TaskCreated): ValidationError | null {
  const budgets = event.attemptBudgets ?? DEFAULT_ATTEMPT_BUDGETS;
  if (
    !isPositiveInt(budgets.analysis.max) ||
    !isPositiveInt(budgets.decomposition.max) ||
    !isPositiveInt(budgets.execution.max) ||
    !isPositiveInt(budgets.review.max)
  ) {
    return mkError(event, "invalid_attempt_budget", "All attempt budget maxima must be positive integers.");
  }
  return null;
}

function validateTaskCreated(state: SystemState, event: TaskCreated): ValidationError | null {
  if (state.tasks[event.taskId]) {
    return mkError(event, "task_exists", `Task ${event.taskId} already exists.`);
  }

  if (!nonEmptyText(event.title) || !nonEmptyText(event.description)) {
    return mkError(event, "invalid_task_payload", "Task title and description must be non-empty.");
  }

  if (!isPositiveInt(event.costBudget)) {
    return mkError(event, "invalid_cost_budget", "Task costBudget must be a positive integer.");
  }

  const budgetError = validateAttemptBudgetShape(event);
  if (budgetError) {
    return budgetError;
  }

  if (event.parentId === event.taskId) {
    return mkError(event, "invalid_parent", "Task cannot be its own parent.");
  }

  if (event.parentId !== null) {
    const parent = state.tasks[event.parentId];
    if (!parent) {
      return mkError(event, "parent_missing", `Parent task ${event.parentId} does not exist.`);
    }

    if (event.rootId !== parent.rootId) {
      return mkError(event, "invalid_root", "Child rootId must match parent rootId.");
    }
  } else if (event.rootId !== event.taskId) {
    return mkError(event, "invalid_root", "Root task must use rootId equal to its own taskId.");
  }

  if (event.initialCondition !== "ready" && event.initialCondition !== "waiting") {
    return mkError(event, "invalid_initial_condition", "TaskCreated.initialCondition must be ready or waiting.");
  }

  const depIds = event.dependencies.map((dependency) => dependency.id);
  const dup = duplicateIds(depIds);
  if (dup.length > 0) {
    return mkError(event, "duplicate_dependency", "Task dependencies must have unique ids.", { duplicateIds: dup });
  }

  for (const dependency of event.dependencies) {
    if (dependency.type === "task" && dependency.target === event.taskId) {
      return mkError(event, "self_dependency", "Task cannot depend on itself.", { dependencyId: dependency.id });
    }
  }

  return null;
}

function requireTask(state: SystemState, event: Event): Task | ValidationError {
  const task = state.tasks[event.taskId];
  if (!task) {
    return mkError(event, "task_missing", `Task ${event.taskId} does not exist.`);
  }
  return task;
}

function validateCoreSource(event: Event): ValidationError | null {
  const requiresSource =
    CORE_ONLY_EVENTS.has(event.type) ||
    MIDDLE_ONLY_EVENTS.has(event.type) ||
    event.type === "TaskBlocked" ||
    event.type === "TaskCanceled" ||
    event.type === "WaitResolved";

  if (!("source" in event)) {
    if (!requiresSource) {
      return null;
    }
    return mkError(event, "missing_source", `Event ${event.type} requires source metadata.`);
  }

  if (CORE_ONLY_EVENTS.has(event.type) && event.source.type !== "core") {
    return mkError(event, "forbidden_source", `Event ${event.type} can only be emitted by core.`);
  }

  if (MIDDLE_ONLY_EVENTS.has(event.type) && event.source.type !== "middle") {
    return mkError(event, "forbidden_source", `Event ${event.type} can only be emitted by middle.`);
  }

  return null;
}
function validatePhaseTransition(event: Extract<Event, { type: "PhaseTransition" }>, task: Task): ValidationError | null {
  if (task.phase === null || task.condition === null) {
    return mkError(event, "terminal_task", "PhaseTransition cannot be applied to a terminal task.");
  }

  if (event.fenceToken !== task.currentFenceToken) {
    return mkError(event, "stale_fence_token", "PhaseTransition fence token mismatch.", {
      expected: task.currentFenceToken,
      got: event.fenceToken,
    });
  }

  if (event.from.phase !== task.phase || event.from.condition !== task.condition) {
    return mkError(event, "from_mismatch", "PhaseTransition.from must match current task state.", {
      taskPhase: task.phase,
      taskCondition: task.condition,
      from: event.from,
    });
  }

  const key = transitionKey(
    event.from.phase,
    event.from.condition,
    event.to.phase,
    event.to.condition,
    event.reasonCode,
  );

  if (!PHASE_TRANSITION_TABLE.has(key)) {
    return mkError(event, "illegal_phase_transition", "Phase transition is not legal for this reason code.", {
      key,
    });
  }

  return null;
}

function validateChildren(
  event: Extract<Event, { type: "DecompositionCreated" }>,
  state: SystemState,
  task: Task,
): ValidationError | null {
  const ids = event.children.map((child) => child.taskId);
  const dup = duplicateIds(ids);
  if (dup.length > 0) {
    return mkError(event, "duplicate_child_id", "Decomposition children must have unique task ids.", {
      duplicateIds: dup,
    });
  }

  for (const child of event.children) {
    if (state.tasks[child.taskId]) {
      return mkError(event, "child_exists", `Child task ${child.taskId} already exists.`);
    }

    if (!nonEmptyText(child.title) || !nonEmptyText(child.description)) {
      return mkError(event, "invalid_child_payload", "Child title and description must be non-empty.", {
        childId: child.taskId,
      });
    }

    if (!isPositiveInt(child.costAllocation)) {
      return mkError(event, "invalid_child_cost", "Child cost allocations must be positive integers.", {
        childId: child.taskId,
      });
    }

    const depDup = duplicateIds(child.dependencies.map((dependency) => dependency.id));
    if (depDup.length > 0) {
      return mkError(event, "duplicate_dependency", "Child dependencies must have unique ids.", {
        childId: child.taskId,
        duplicateIds: depDup,
      });
    }
  }

  const checkpointsNotChild = event.checkpoints.filter((checkpoint) => !ids.includes(checkpoint));
  if (checkpointsNotChild.length > 0) {
    return mkError(event, "invalid_checkpoint_set", "All checkpoints must reference decomposition children.", {
      checkpointIds: checkpointsNotChild,
    });
  }

  const totalAllocation = event.children.reduce((sum, child) => sum + child.costAllocation, 0);
  if (totalAllocation > computeCostRemaining(task.cost)) {
    return mkError(event, "cost_over_allocation", "Child allocation exceeds parent remaining cost.", {
      totalAllocation,
      remaining: computeCostRemaining(task.cost),
    });
  }

  return null;
}

function validateSessionPolicy(
  event: Extract<Event, { type: "LeaseGranted" }>,
  task: Task,
): ValidationError | null {
  if (task.sessionPolicy === "fresh" && event.sessionType !== "fresh") {
    return mkError(event, "session_policy_violation", "Task requires fresh sessions.");
  }
  if (event.sessionType === "continued") {
    if (task.sessionPolicy !== "continuable") {
      return mkError(event, "session_policy_violation", "Task session policy does not allow continuation.");
    }
    if (task.currentSessionId === null) {
      return mkError(event, "missing_prior_session", "Cannot continue session without existing session id.");
    }
    if (event.phase === "execution" && task.attempts.execution.used === 0) {
      return mkError(
        event,
        "missing_prior_session",
        "Cannot continue execution session before any prior execution lease exists.",
      );
  }
  }

  return null;
}

function validateWaitAction(event: Extract<Event, { type: "WaitResolved" }>): ValidationError | null {
  if (event.action === "block" && !validFailureSummary(event.summary)) {
    return mkError(
      event,
      "missing_failure_summary",
      "WaitResolved(action=block) requires a non-empty failure summary in summary field.",
    );
  }

  return null;
}

function validateTaskReparented(
  state: SystemState,
  event: Extract<Event, { type: "TaskReparented" }>,
  task: Task,
): ValidationError | null {
  // Stale guard: oldParentId and oldRootId must match current task state
  if (event.oldParentId !== task.parentId) {
    return mkError(event, "stale_parent", "TaskReparented.oldParentId does not match current parentId.", {
      expected: task.parentId,
      got: event.oldParentId,
    });
  }
  if (event.oldRootId !== task.rootId) {
    return mkError(event, "stale_root", "TaskReparented.oldRootId does not match current rootId.", {
      expected: task.rootId,
      got: event.oldRootId,
    });
  }

  // Self-reparent
  if (event.taskId === event.newParentId) {
    return mkError(event, "self_reparent", "Task cannot be reparented under itself.");
  }

  // New parent must exist
  const newParent = state.tasks[event.newParentId];
  if (!newParent) {
    return mkError(event, "parent_missing", `New parent task ${event.newParentId} does not exist.`);
  }

  // newRootId must match new parent's rootId
  if (event.newRootId !== newParent.rootId) {
    return mkError(event, "invalid_root", "TaskReparented.newRootId must match new parent rootId.", {
      newRootId: event.newRootId,
      parentRootId: newParent.rootId,
    });
  }

  // Cycle detection: walk ancestors from newParentId up; reject if taskId found
  let cursor: Task | undefined = newParent;
  const visited = new Set<string>();
  while (cursor && cursor.parentId !== null) {
    if (cursor.parentId === event.taskId) {
      return mkError(event, "cycle_detected", "Reparenting would create a cycle in the parent chain.");
    }
    if (visited.has(cursor.id)) {
      break; // existing cycle in data, don't loop forever
    }
    visited.add(cursor.id);
    cursor = state.tasks[cursor.parentId];
  }

  return null;
}

const VALID_PRIORITIES = new Set(["backlog", "low", "medium", "high", "critical"]);

function validateMetadataUpdated(event: Extract<Event, { type: "MetadataUpdated" }>): ValidationError | null {
  if (!event.patch || typeof event.patch !== "object" || Object.keys(event.patch).length === 0) {
    return mkError(event, "empty_patch", "MetadataUpdated.patch must be a non-empty object.");
  }

  if (!nonEmptyText(event.reason)) {
    return mkError(event, "invalid_reason", "MetadataUpdated.reason must be non-empty.");
  }

  // Validate well-known fields
  if ("priority" in event.patch && event.patch["priority"] !== null) {
    if (!VALID_PRIORITIES.has(event.patch["priority"] as string)) {
      return mkError(event, "invalid_priority", "priority must be one of: backlog, low, medium, high, critical.", {
        got: event.patch["priority"],
      });
    }
  }

  return null;
}

function validateCommonTaskRules(task: Task, event: Event): ValidationError | null {
  if (task.terminal !== null) {
    return mkError(event, "terminal_absorption", "Cannot apply non-creation events to a terminal task.");
  }

  return null;
}

export function validateEvent(state: SystemState, event: Event): ValidationError | null {
  if (event.type === "TaskCreated") {
    return validateTaskCreated(state, event);
  }

  const taskOrError = requireTask(state, event);
  if ("code" in taskOrError) {
    return taskOrError;
  }
  const task = taskOrError;

  // TaskReparented bypasses terminal check — it's structural, not lifecycle
  if (event.type === "TaskReparented") {
    return validateTaskReparented(state, event, task);
  }

  // MetadataUpdated bypasses terminal check — metadata is informational
  if (event.type === "MetadataUpdated") {
    return validateMetadataUpdated(event);
  }

  // TaskRevived requires terminal state — it reverts a failed/blocked task back to active
  if (event.type === "TaskRevived") {
    if (!task.terminal) {
      return mkError(event, "not_terminal", "TaskRevived requires task to be in a terminal state (failed/blocked).");
    }
    if (task.terminal !== "failed" && task.terminal !== "blocked") {
      return mkError(event, "invalid_terminal", "TaskRevived only works on failed or blocked tasks, not " + task.terminal + ".");
    }
    return null;
  }

  const commonError = validateCommonTaskRules(task, event);
  if (commonError) {
    return commonError;
  }

  const sourceError = validateCoreSource(event);
  if (sourceError) {
    return sourceError;
  }

  switch (event.type) {
    case "LeaseGranted": {
      if (task.phase === null || task.condition === null) {
        return mkError(event, "terminal_task", "Lease cannot be granted to terminal task.");
      }
      if (task.condition !== "ready") {
        return mkError(event, "invalid_condition", "LeaseGranted requires task condition ready.");
      }
      if (task.phase !== event.phase) {
        return mkError(event, "phase_mismatch", "LeaseGranted.phase must match current task phase.");
      }
      if (event.fenceToken <= task.currentFenceToken) {
        return mkError(event, "fence_not_monotonic", "LeaseGranted fenceToken must strictly increase.", {
          current: task.currentFenceToken,
          proposed: event.fenceToken,
        });
      }
      if (!isPositiveInt(event.leaseTimeout)) {
        return mkError(event, "invalid_lease_timeout", "Lease timeout must be a positive integer duration.");
      }
      if (!isPositiveInt(event.contextBudget)) {
        return mkError(event, "invalid_context_budget", "Context budget must be a positive integer.");
      }

      const attempt = task.attempts[event.phase];
      if (attempt.used >= attempt.max) {
        return mkError(event, "attempt_budget_exhausted", "Attempt budget exhausted for current phase.", {
          phase: event.phase,
          used: attempt.used,
          max: attempt.max,
        });
      }

      if (computeCostRemaining(task.cost) <= 0) {
        return mkError(event, "cost_budget_exhausted", "Cost budget exhausted for task tree.");
      }

      return validateSessionPolicy(event, task);
    }

    case "LeaseExpired": {
      if (task.condition !== "leased" && task.condition !== "active") {
        return mkError(event, "invalid_condition", "LeaseExpired requires leased or active condition.");
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "LeaseExpired fence token mismatch.");
      }
      return null;
    }

    case "LeaseReleased": {
      if (task.condition !== "leased" && task.condition !== "active") {
        return mkError(event, "invalid_condition", "LeaseReleased requires leased or active condition.");
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "LeaseReleased fence token mismatch.");
      }
      if (event.phase !== task.phase) {
        return mkError(event, "phase_mismatch", "LeaseReleased.phase must match current task phase.");
      }
      if (!nonEmptyText(event.reason)) {
        return mkError(event, "missing_release_reason", "LeaseReleased.reason must be non-empty.");
      }
      return null;
    }

    case "LeaseExtended": {
      if (task.condition !== "leased" && task.condition !== "active") {
        return mkError(event, "invalid_condition", "LeaseExtended requires leased or active condition.");
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "LeaseExtended fence token mismatch.");
      }
      if (!isPositiveInt(event.leaseTimeout)) {
        return mkError(event, "invalid_lease_timeout", "LeaseExtended.leaseTimeout must be a positive integer duration.");
      }
      return null;
    }

    case "AgentStarted": {
      if (task.condition !== "leased") {
        return mkError(event, "invalid_condition", "AgentStarted requires leased condition.");
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "AgentStarted fence token mismatch.");
      }
      if (task.leasedTo !== null && task.leasedTo !== event.agentContext.agentId) {
        return mkError(event, "agent_mismatch", "AgentStarted agentContext.agentId must match leased agent.");
      }
      return null;
    }

    case "AgentExited": {
      if (task.condition !== "active") {
        return mkError(event, "invalid_condition", "AgentExited requires active condition.");
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "AgentExited fence token mismatch.");
      }
      if (event.reportedCost < 0) {
        return mkError(event, "invalid_cost", "AgentExited.reportedCost must be >= 0.");
      }
      return null;
    }

    case "CostReported": {
      if (task.condition !== "active" && task.condition !== "leased") {
        return mkError(event, "invalid_condition", "CostReported requires leased or active condition.");
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "CostReported fence token mismatch.");
      }
      if (event.reportedCost < 0) {
        return mkError(event, "invalid_cost", "CostReported.reportedCost must be >= 0.");
      }
      return null;
    }

    case "PhaseTransition":
      return validatePhaseTransition(event, task);

    case "WaitRequested": {
      const canRedirectWhileWaiting = task.condition === "waiting" && task.waitState === null;
      if (task.condition !== "active" && !canRedirectWhileWaiting) {
        return mkError(
          event,
          "invalid_condition",
          "WaitRequested requires active condition, or waiting condition with cleared waitState for redirect.",
        );
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "WaitRequested fence token mismatch.");
      }
      if (task.dependencies.some((dependency) => dependency.id === event.dependency.id)) {
        return mkError(event, "duplicate_dependency", "WaitRequested dependency id already exists on task.");
      }
      return null;
    }

    case "WaitResolved": {
      if (task.condition !== "waiting") {
        return mkError(event, "invalid_condition", "WaitResolved requires waiting condition.");
      }
      const dep = task.dependencies.find((dependency) => dependency.id === event.dependencyId);
      if (!dep) {
        return mkError(event, "dependency_missing", `Dependency ${event.dependencyId} not found on task.`);
      }
      return validateWaitAction(event);
    }

    case "DependencySatisfied": {
      const dep = task.dependencies.find((dependency) => dependency.id === event.dependencyId);
      if (!dep) {
        return mkError(event, "dependency_missing", `Dependency ${event.dependencyId} not found on task.`);
      }
      return null;
    }

    case "RetryScheduled": {
      if (task.condition !== "active" && task.condition !== "leased") {
        return mkError(event, "invalid_condition", "RetryScheduled requires active or leased condition.");
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "RetryScheduled fence token mismatch.");
      }
      if (task.phase !== event.phase) {
        return mkError(event, "phase_mismatch", "RetryScheduled.phase must match task phase.");
      }
      if (event.retryAfter <= event.ts) {
        return mkError(event, "invalid_retry_after", "RetryScheduled.retryAfter must be greater than event.ts.");
      }
      if (!isPositiveInt(event.attemptNumber)) {
        return mkError(event, "invalid_attempt_number", "RetryScheduled.attemptNumber must be positive integer.");
      }
      return null;
    }

    case "BackoffExpired": {
      if (task.condition !== "retryWait") {
        return mkError(event, "invalid_condition", "BackoffExpired requires retryWait condition.");
      }
      if (task.phase !== event.phase) {
        return mkError(event, "phase_mismatch", "BackoffExpired.phase must match task phase.");
      }
      return null;
    }

    case "DecompositionCreated": {
      if (task.phase !== "decomposition" || task.condition !== "active") {
        return mkError(
          event,
          "invalid_state",
          "DecompositionCreated requires task in decomposition.active state.",
        );
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "DecompositionCreated fence token mismatch.");
      }
      if (event.version !== task.decompositionVersion + 1) {
        return mkError(event, "version_mismatch", "Decomposition version must increment by exactly 1.", {
          current: task.decompositionVersion,
          proposed: event.version,
        });
      }
      if (event.completionRule !== "and") {
        return mkError(event, "unsupported_completion_rule", "Only AND completion rule is supported.");
      }
      return validateChildren(event, state, task);
    }

    case "ChildCostRecovered": {
      if (!task.children.includes(event.childId)) {
        return mkError(event, "unknown_child", "Recovered child is not attached to task.", {
          childId: event.childId,
        });
      }

      const child = state.tasks[event.childId];
      if (!child) {
        return mkError(event, "missing_child", "Recovered child task does not exist.", {
          childId: event.childId,
        });
      }

      if (child.terminal === null) {
        return mkError(event, "child_not_terminal", "ChildCostRecovered requires terminal child task.", {
          childId: event.childId,
        });
      }

      if (child.costRecoveredToParent) {
        return mkError(
          event,
          "child_cost_already_recovered",
          "Cost for child " + event.childId + " has already been recovered to parent.",
        );
      }

      if (event.recoveredAmount < 0) {
        return mkError(event, "invalid_recovery", "Recovered amount cannot be negative.");
      }

      const childRemaining = computeCostRemaining(child.cost);
      if (event.recoveredAmount > childRemaining) {
        return mkError(event, "invalid_recovery", "Recovered amount cannot exceed child remaining cost.", {
          childId: event.childId,
          recoveredAmount: event.recoveredAmount,
          childRemaining,
        });
      }

      return null;
    }

    case "CheckpointTriggered": {
      if (!task.checkpoints.includes(event.childId)) {
        return mkError(event, "unknown_checkpoint_child", "CheckpointTriggered child is not a checkpoint child.");
      }
      return null;
    }

    case "CheckpointCreated": {
      if (task.phase === null || task.condition === null) {
        return mkError(event, "terminal_task", "Checkpoint cannot be created for terminal task.");
      }
      if (event.phase !== task.phase || event.condition !== task.condition) {
        return mkError(event, "checkpoint_state_mismatch", "Checkpoint phase/condition must match task state.");
      }
      if (task.checkpointRefs.some((checkpoint) => checkpoint.id === event.checkpointId)) {
        return mkError(event, "duplicate_checkpoint", "Checkpoint id already exists for task.");
      }
      return null;
    }

    case "StateReverted": {
      const checkpoint = task.checkpointRefs.find((item) => item.id === event.revertTo);
      if (!checkpoint) {
        return mkError(event, "checkpoint_missing", `Checkpoint ${event.revertTo} not found.`);
      }
      return null;
    }

    case "ReviewVerdictSubmitted": {
      if (task.phase !== "review" || task.condition !== "active") {
        return mkError(event, "invalid_state", "ReviewVerdictSubmitted requires review.active state.");
      }
      if (event.fenceToken !== task.currentFenceToken) {
        return mkError(event, "stale_fence_token", "ReviewVerdictSubmitted fence token mismatch.");
      }
      if (!nonEmptyText(event.reasoning)) {
        return mkError(event, "invalid_reasoning", "Review verdict reasoning must be non-empty.");
      }
      return null;
    }

    case "ReviewPolicyMet": {
      if (task.phase !== "review") {
        return mkError(event, "invalid_phase", "ReviewPolicyMet can only be applied in review phase.");
      }
      if (!nonEmptyText(event.summary)) {
        return mkError(event, "invalid_summary", "ReviewPolicyMet summary must be non-empty.");
      }
      return null;
    }

    case "TaskCompleted": {
      if (task.reviewConfig !== null) {
        if (task.phase !== "review") {
          return mkError(event, "invalid_phase", "TaskCompleted requires review phase when review is configured.");
        }
      } else if (task.phase !== "execution" && task.phase !== "review") {
        return mkError(event, "invalid_phase", "TaskCompleted without review requires execution or review phase.");
      }
      return null;
    }

    case "TaskFailed": {
      if (!validFailureSummary(event.summary)) {
        return mkError(event, "missing_failure_summary", "TaskFailed requires a non-empty failure summary.");
      }
      return null;
    }

    case "TaskBlocked": {
      if (!validFailureSummary(event.summary)) {
        return mkError(event, "missing_failure_summary", "TaskBlocked requires a non-empty failure summary.");
      }
      if (!nonEmptyText(event.reason) || !nonEmptyText(event.reasonCode)) {
        return mkError(event, "invalid_block_reason", "TaskBlocked requires reason and reasonCode.");
      }
      return null;
    }

    case "TaskExhausted": {
      if (task.condition !== "ready" && task.condition !== "retryWait") {
        return mkError(event, "invalid_condition", "TaskExhausted requires ready or retryWait condition.");
      }
      if (task.phase !== event.phase) {
        return mkError(event, "phase_mismatch", "TaskExhausted.phase must match current task phase.");
      }
      return null;
    }

    case "BudgetIncreased": {
      if (event.costBudgetIncrease < 0) {
        return mkError(event, "invalid_cost_increase", "BudgetIncreased.costBudgetIncrease must be >= 0.");
      }
      if (!nonEmptyText(event.reason)) {
        return mkError(event, "invalid_reason", "BudgetIncreased.reason must be non-empty.");
      }
      if (event.attemptBudgetIncrease) {
        for (const phase of ["analysis", "decomposition", "execution", "review"] as const) {
          const entry = event.attemptBudgetIncrease[phase];
          if (entry && !isPositiveInt(entry.max)) {
            return mkError(event, "invalid_attempt_budget", `BudgetIncreased attempt budget max for ${phase} must be a positive integer.`);
          }
        }
      }
      return null;
    }

    case "TaskCanceled":
      return null;

    default: {
      const neverEvent: never = event;
      return mkError(neverEvent, "unknown_event", "Unsupported event type.");
    }
  }
}

export function validateChildrenForCreation(children: DecompositionChildSpec[]): ValidationError | null {
  const ids = children.map((child) => child.taskId);
  const dup = duplicateIds(ids);
  if (dup.length > 0) {
    return {
      code: "duplicate_child_id",
      message: "Decomposition child ids must be unique.",
      details: { duplicateIds: dup },
    };
  }
  return null;
}
