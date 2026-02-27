import {
  computeCostRemaining,
  type BackoffExpired,
  type CheckpointTriggered,
  type ChildCostRecovered,
  type DependencySatisfied,
  type Event,
  type LeaseExpired,
  type PhaseTransition,
  type RetryScheduled,
  type SystemState,
  type Task,
  type TaskFailed,
} from "./types.js";

const AGENT_EXIT_FOLLOWUP_TIMEOUT = 60_000;
const AGENT_EXIT_RETRY_BACKOFF = 1_000;

function backoffDue(task: Task, now: number): boolean {
  return task.condition === "retryWait" && task.retryAfter !== null && task.retryAfter <= now;
}

function childrenCompleteReady(state: SystemState, task: Task): { allTerminal: boolean; anyDone: boolean } {
  if (task.children.length === 0) {
    return { allTerminal: false, anyDone: false };
  }

  let anyDone = false;
  for (const childId of task.children) {
    const child = state.tasks[childId];
    if (!child || child.terminal === null) {
      return { allTerminal: false, anyDone: false };
    }
    if (child.terminal === "done") {
      anyDone = true;
    }
  }

  return { allTerminal: true, anyDone };
}

export class CoreClock {
  private readonly sourceId: string;

  public constructor(sourceId = "core-clock") {
    this.sourceId = sourceId;
  }

  public collectDueEvents(state: SystemState, now = Date.now()): Event[] {
    const due: Event[] = [];

    for (const task of Object.values(state.tasks)) {
      if (task.terminal !== null && task.parentId !== null && !task.costRecoveredToParent) {
        const parent = state.tasks[task.parentId];
        const remaining = computeCostRemaining(task.cost);
        if (parent && parent.terminal === null && remaining > 0) {
          const recovered: ChildCostRecovered = {
            type: "ChildCostRecovered",
            taskId: parent.id,
            ts: now,
            childId: task.id,
            recoveredAmount: remaining,
            source: { type: "core", id: this.sourceId },
          };
          due.push(recovered);
        }
      }

      if (task.terminal !== null || task.phase === null || task.condition === null) {
        continue;
      }

      const retryDue = backoffDue(task, now);

      if ((task.condition === "ready" || retryDue) && computeCostRemaining(task.cost) <= 0) {
        const failEvent: TaskFailed = {
          type: "TaskFailed",
          taskId: task.id,
          ts: now,
          reason: "cost_exhausted",
          phase: task.phase,
          summary: {
            childId: null,
            approach: "cost budget exhausted",
            whatFailed: "Task tree cost budget fully consumed",
            whatWasLearned: "No remaining cost budget for further execution",
            artifactRef: task.stateRef,
          },
        };
        due.push(failEvent);
        continue;
      }

      if (task.condition === "ready" || retryDue) {
        const attempt = task.attempts[task.phase];
        if (attempt.used >= attempt.max) {
          const failEvent: TaskFailed = {
            type: "TaskFailed",
            taskId: task.id,
            ts: now,
            reason: "budget_exhausted",
            phase: task.phase,
            summary: {
              childId: null,
              approach: `${task.phase} attempt budget exhausted`,
              whatFailed: `Reached max attempts (${attempt.max}) for ${task.phase} phase`,
              whatWasLearned: "All retry attempts consumed without success",
              artifactRef: task.stateRef,
            },
          };
          due.push(failEvent);
          continue;
        }
      }

      if (
        task.condition === "active" &&
        task.leasedTo !== null &&
        task.leaseExpiresAt === null &&
        task.lastAgentExitAt !== null &&
        now - task.lastAgentExitAt > AGENT_EXIT_FOLLOWUP_TIMEOUT
      ) {
        const retryScheduled: RetryScheduled = {
          type: "RetryScheduled",
          taskId: task.id,
          ts: now,
          fenceToken: task.currentFenceToken,
          reason: "agent_exit_followup_timeout",
          retryAfter: now + AGENT_EXIT_RETRY_BACKOFF,
          phase: task.phase,
          attemptNumber: Math.max(1, task.attempts[task.phase].used),
        };
        due.push(retryScheduled);
        continue;
      }

      if (task.condition === "leased" && task.leaseExpiresAt !== null && task.leaseExpiresAt <= now) {
        const leaseExpired: LeaseExpired = {
          type: "LeaseExpired",
          taskId: task.id,
          ts: now,
          fenceToken: task.currentFenceToken,
          reason: "timeout",
          source: { type: "core", id: this.sourceId },
        };
        due.push(leaseExpired);
      }

      if (retryDue) {
        const backoffExpired: BackoffExpired = {
          type: "BackoffExpired",
          taskId: task.id,
          ts: now,
          phase: task.phase,
          source: { type: "core", id: this.sourceId },
        };
        due.push(backoffExpired);
      }

      for (const dependency of task.dependencies) {
        if (dependency.type !== "task" || dependency.status !== "pending") {
          continue;
        }

        const dependedOnTask = state.tasks[dependency.target];
        if (!dependedOnTask || dependedOnTask.terminal === null) {
          continue;
        }

        const dependencySatisfied: DependencySatisfied = {
          type: "DependencySatisfied",
          taskId: task.id,
          ts: now,
          dependencyId: dependency.id,
          satisfiedBy: dependedOnTask.id,
          source: { type: "core", id: this.sourceId },
        };
        due.push(dependencySatisfied);
      }

      let emittedCheckpoint = false;
      if (task.phase === "review" && task.condition === "waiting" && task.checkpoints.length > 0) {
        const alreadyTriggered = new Set(task.triggeredCheckpoints);
        for (const childId of task.checkpoints) {
          if (alreadyTriggered.has(childId)) {
            continue;
          }
          const child = state.tasks[childId];
          if (!child || child.terminal === null) {
            continue;
          }

          const checkpointTriggered: CheckpointTriggered = {
            type: "CheckpointTriggered",
            taskId: task.id,
            ts: now,
            childId,
            source: { type: "core", id: this.sourceId },
          };
          due.push(checkpointTriggered);
          emittedCheckpoint = true;
        }
      }

      const completion = childrenCompleteReady(state, task);
      if (!emittedCheckpoint && task.phase === "review" && task.condition === "waiting" && completion.allTerminal) {
        const childrenTransition: PhaseTransition = completion.anyDone
          ? {
              type: "PhaseTransition",
              taskId: task.id,
              ts: now,
              from: { phase: "review", condition: "waiting" },
              to: { phase: "review", condition: "ready" },
              reasonCode: "children_complete",
              reason: "All children reached terminal state",
              fenceToken: task.currentFenceToken,
              agentContext: {
                sessionId: "core",
                agentId: "core",
                memoryRef: null,
                contextTokens: null,
                modelId: "core",
              },
            }
          : {
              type: "PhaseTransition",
              taskId: task.id,
              ts: now,
              from: { phase: "review", condition: "waiting" },
              to: { phase: "analysis", condition: "ready" },
              reasonCode: "children_all_failed",
              reason: "All children reached terminal state with no successful child",
              fenceToken: task.currentFenceToken,
              agentContext: {
                sessionId: "core",
                agentId: "core",
                memoryRef: null,
                contextTokens: null,
                modelId: "core",
              },
            };
        due.push(childrenTransition);
      }
    }

    return due.sort((a, b) => {
      if (a.ts !== b.ts) {
        return a.ts - b.ts;
      }
      if (a.taskId !== b.taskId) {
        return a.taskId.localeCompare(b.taskId);
      }
      return a.type.localeCompare(b.type);
    });
  }
}
