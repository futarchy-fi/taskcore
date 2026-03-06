import {
  computeCostRemaining,
  PHASES,
  type Event,
  type SystemState,
  type Task,
  type TaskId,
} from "./types.js";

export interface InvariantViolation {
  code: string;
  message: string;
  taskId?: TaskId;
  details?: Record<string, unknown>;
}

function push(
  violations: InvariantViolation[],
  code: string,
  message: string,
  taskId?: TaskId,
  details?: Record<string, unknown>,
): void {
  const violation: InvariantViolation = { code, message };
  if (taskId !== undefined) {
    violation.taskId = taskId;
  }
  if (details !== undefined) {
    violation.details = details;
  }
  violations.push(violation);
}

function assertTaskShape(task: Task, allTasks: Record<TaskId, Task>, violations: InvariantViolation[]): void {
  if (task.terminal !== null) {
    if (task.phase !== null || task.condition !== null) {
      push(
        violations,
        "terminal_shape",
        "Terminal task must have phase and condition set to null.",
        task.id,
      );
    }

    if ((task.terminal === "failed" || task.terminal === "blocked") && task.terminalSummary === null) {
      push(
        violations,
        "missing_terminal_summary",
        "Failed/blocked task must keep a terminalSummary.",
        task.id,
      );
    }
  } else if (task.phase === null || task.condition === null) {
    push(
      violations,
      "non_terminal_shape",
      "Non-terminal task must have both phase and condition defined.",
      task.id,
    );
  }

  for (const phase of PHASES) {
    const budget = task.attempts[phase];
    if (budget.used < 0 || budget.max <= 0 || budget.used > budget.max) {
      push(
        violations,
        "attempt_bounds",
        "Attempt budget must satisfy 0 <= used <= max and max > 0.",
        task.id,
        { phase, used: budget.used, max: budget.max },
      );
    }
  }

  if (task.cost.allocated < 0) {
    push(violations, "cost_allocated_negative", "Task cost allocated must not be negative.", task.id);
  } else if (task.cost.allocated === 0 && !task.costRecoveredToParent) {
    push(
      violations,
      "cost_allocated_zero_without_recovery",
      "Task cost allocated is zero but cost was not recovered to parent.",
      task.id,
    );
  }

  if (task.cost.consumed < 0 || task.cost.childAllocated < 0 || task.cost.childRecovered < 0) {
    push(violations, "cost_non_negative", "Cost counters cannot be negative.", task.id, {
      consumed: task.cost.consumed,
      childAllocated: task.cost.childAllocated,
      childRecovered: task.cost.childRecovered,
    });
  }

  if (task.condition === "retryWait" && task.retryAfter === null) {
    push(violations, "retry_wait_missing_retry_after", "retryWait requires retryAfter.", task.id);
  }

  if (task.condition === "exhausted" && (task.leasedTo !== null || task.leaseExpiresAt !== null)) {
    push(violations, "exhausted_dangling_lease", "Exhausted tasks must have leasedTo and leaseExpiresAt cleared.", task.id);
  }

  if (task.condition !== "waiting" && task.waitState !== null) {
    push(violations, "dangling_wait_state", "waitState can only exist in waiting condition.", task.id);
  }

  const childSeen = new Set<string>();
  for (const childId of task.children) {
    if (childSeen.has(childId)) {
      push(violations, "duplicate_child", "Task children list contains duplicates.", task.id, { childId });
    }
    childSeen.add(childId);
  }
  const triggeredSeen = new Set<string>();
  for (const childId of task.triggeredCheckpoints) {
    if (triggeredSeen.has(childId)) {
      push(violations, "duplicate_triggered_checkpoint", "Triggered checkpoints must be unique.", task.id, {
        childId,
      });
    }
    triggeredSeen.add(childId);

    if (!task.checkpoints.includes(childId)) {
      push(
        violations,
        "unknown_triggered_checkpoint",
        "Triggered checkpoint id must exist in checkpoints list.",
        task.id,
        { childId },
      );
    }
  }

  const depSeen = new Set<string>();
  for (const dependency of task.dependencies) {
    if (depSeen.has(dependency.id)) {
      push(violations, "duplicate_dependency", "Task dependency ids must be unique.", task.id, {
        dependencyId: dependency.id,
      });
    }
    depSeen.add(dependency.id);
  }

  const remaining = computeCostRemaining(task.cost);
  if (!Number.isFinite(remaining)) {
    push(violations, "invalid_cost_remaining", "Computed remaining cost must be finite.", task.id);
  }
}

function detectParentCycles(tasks: Record<TaskId, Task>, violations: InvariantViolation[]): void {
  const visiting = new Set<TaskId>();
  const visited = new Set<TaskId>();

  function dfs(taskId: TaskId): void {
    if (visited.has(taskId)) {
      return;
    }

    if (visiting.has(taskId)) {
      push(violations, "parent_cycle", "Detected cycle in parent chain.", taskId);
      return;
    }

    const task = tasks[taskId];
    if (!task) {
      return;
    }

    visiting.add(taskId);
    if (task.parentId !== null) {
      const parent = tasks[task.parentId];
      if (!parent) {
        push(violations, "missing_parent", "Task parent does not exist.", taskId, {
          parentId: task.parentId,
        });
      } else {
        dfs(task.parentId);
      }
    }
    visiting.delete(taskId);
    visited.add(taskId);
  }

  for (const taskId of Object.keys(tasks)) {
    dfs(taskId);
  }
}

function validateParentChildLinks(tasks: Record<TaskId, Task>, violations: InvariantViolation[]): void {
  for (const task of Object.values(tasks)) {
    if (task.parentId === null) {
      continue;
    }

    const parent = tasks[task.parentId];
    if (!parent) {
      continue;
    }

    if (!parent.children.includes(task.id)) {
      push(
        violations,
        "parent_child_mismatch",
        "Parent task does not list child in children array.",
        task.id,
        { parentId: task.parentId },
      );
    }

    if (task.rootId !== parent.rootId) {
      push(violations, "root_mismatch", "Child rootId must match parent rootId.", task.id, {
        rootId: task.rootId,
        parentRootId: parent.rootId,
      });
    }
  }
}

function checkEventMonotonicity(events: Array<{ sequence: number; event: Event }>, violations: InvariantViolation[]): void {
  let expectedSequence = 1;
  const terminalSeen = new Set<TaskId>();
  const lastFenceTokenByTask = new Map<TaskId, number>();

  for (const envelope of events) {
    if (envelope.sequence !== expectedSequence) {
      push(violations, "event_sequence_gap", "Event sequence numbers must be contiguous and start at 1.", undefined, {
        expected: expectedSequence,
        got: envelope.sequence,
      });
      expectedSequence = envelope.sequence;
    }

    expectedSequence += 1;

    const { event } = envelope;
    if (terminalSeen.has(event.taskId) && event.type !== "TaskCreated" && event.type !== "TaskReparented" && event.type !== "TaskRevived" && event.type !== "MetadataUpdated") {
      push(
        violations,
        "terminal_absorption",
        "No events are allowed after a task reaches terminal state.",
        event.taskId,
        { eventType: event.type },
      );
    }

    if (event.type === "TaskCompleted" || event.type === "TaskFailed" || event.type === "TaskBlocked" || event.type === "TaskCanceled") {
      terminalSeen.add(event.taskId);
    }
    if (event.type === "TaskRevived") {
      terminalSeen.delete(event.taskId);
    }

    if (event.type === "LeaseGranted") {
      const previous = lastFenceTokenByTask.get(event.taskId);
      if (previous !== undefined && event.fenceToken <= previous) {
        push(
          violations,
          "fence_monotonicity",
          "Fence tokens must strictly increase for each task lease.",
          event.taskId,
          { previous, current: event.fenceToken },
        );
      }
      lastFenceTokenByTask.set(event.taskId, event.fenceToken);
    }
  }
}

export function checkInvariants(state: SystemState): InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  if (state.sequence !== state.events.length) {
    push(violations, "sequence_mismatch", "state.sequence must match number of events.", undefined, {
      sequence: state.sequence,
      eventCount: state.events.length,
    });
  }

  for (const task of Object.values(state.tasks)) {
    assertTaskShape(task, state.tasks, violations);
  }

  detectParentCycles(state.tasks, violations);
  validateParentChildLinks(state.tasks, violations);
  checkEventMonotonicity(state.events, violations);

  return violations;
}

export function assertInvariants(state: SystemState): void {
  const violations = checkInvariants(state);
  if (violations.length === 0) {
    return;
  }

  const first = violations[0]!;
  throw new Error(`Invariant violation: ${first.code} - ${first.message}${first.taskId ? ` (task=${first.taskId})` : ""}`);
}
