import type { Core } from "../core/index.js";
import type { AgentContext, PhaseTransition, RetryScheduled, SystemState, Task } from "../core/types.js";

function buildReconciliationAgentContext(task: Task): AgentContext {
  return {
    sessionId: task.currentSessionId ?? "reconciliation",
    agentId: task.leasedTo ?? "core",
    memoryRef: null,
    contextTokens: null,
    modelId: "core",
  };
}

function currentMaterializedApproach(state: SystemState, task: Task): Task["approachHistory"][number] | null {
  if (task.phase !== "decomposition" || task.condition !== "active" || task.decompositionVersion <= 0) {
    return null;
  }

  const approach = task.approachHistory.find(
    (entry) => entry.version === task.decompositionVersion && entry.outcome === "active",
  );
  if (!approach || approach.childIds.length === 0) {
    return null;
  }

  const allChildrenMaterialized = approach.childIds.every((childId) => {
    const child = state.tasks[childId];
    return child !== undefined && child.parentId === task.id;
  });
  if (!allChildrenMaterialized) {
    return null;
  }

  for (let i = state.events.length - 1; i >= 0; i -= 1) {
    const event = state.events[i]?.event;
    if (!event || event.taskId !== task.id) {
      continue;
    }

    if (event.type === "ChildCostRecovered" || event.type === "BudgetIncreased" || event.type === "MetadataUpdated") {
      continue;
    }

    if (event.type === "DecompositionCreated" && event.version === task.decompositionVersion) {
      return approach;
    }

    return null;
  }

  return null;
}

/**
 * On daemon restart, the in-memory activeRuns map is lost. Tasks that were
 * "active" when the previous daemon died will stay active forever because
 * AgentExited was never submitted (so lastAgentExitAt is null and the clock
 * reaper can't fire). This function detects those orphans and moves them back
 * into a retryable state.
 *
 * Special case: if a decomposition task already materialized children for the
 * current decomposition version, we should not retry decomposition. Instead we
 * recover the missing `children_created` transition so the parent resumes in
 * `review.waiting` and the existing children can finish normally.
 */
export function reconcileOrphanedTasks(core: Core, now = Date.now()): number {
  const state = core.getState();
  let reconciled = 0;

  for (const task of Object.values(state.tasks)) {
    if (task.terminal !== null) continue;
    if (task.condition !== "active" && task.condition !== "leased") continue;
    if (task.phase === null) continue;

    const materializedApproach = currentMaterializedApproach(state, task);
    if (materializedApproach) {
      const event: PhaseTransition = {
        type: "PhaseTransition",
        taskId: task.id,
        ts: now,
        from: { phase: "decomposition", condition: "active" },
        to: { phase: "review", condition: "waiting" },
        reasonCode: "children_created",
        reason: `Recovered decomposition v${materializedApproach.version} after restart`,
        fenceToken: task.currentFenceToken,
        agentContext: buildReconciliationAgentContext(task),
      };

      const result = core.submit(event);
      if (result.ok) {
        reconciled++;
      } else {
        console.warn(`[daemon] Could not reconcile decomposition T${task.id}: ${result.error.message}`);
      }
      continue;
    }

    const event: RetryScheduled = {
      type: "RetryScheduled",
      taskId: task.id,
      ts: now,
      fenceToken: task.currentFenceToken,
      reason: "orphaned_on_restart",
      retryAfter: now + 1_000,
      phase: task.phase,
      attemptNumber: Math.max(1, task.attempts[task.phase].used),
    };

    const result = core.submit(event);
    if (result.ok) {
      reconciled++;
    } else {
      console.warn(`[daemon] Could not reconcile T${task.id}: ${result.error.message}`);
    }
  }

  return reconciled;
}
