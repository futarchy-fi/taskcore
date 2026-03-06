import * as crypto from "node:crypto";
import type { Core } from "../core/index.js";
import type {
  AgentContext,
  AgentExited,
  LeaseGranted,
  PhaseTransition,
  Task,
} from "../core/types.js";
import type { Config } from "./config.js";

/**
 * Auto-analysis handler for tasks with an explicit assignee.
 *
 * Tasks with an assignee skip the analysis phase — the daemon acts as a
 * virtual "analysis agent" that instantly decides to execute.
 *
 * Tasks without an assignee need a real analysis agent (deferred).
 *
 * Returns true if the task was auto-transitioned, false otherwise.
 */
export function autoAnalysis(core: Core, task: Task, config: Config): boolean {
  // Only handle analysis.ready tasks
  if (task.phase !== "analysis" || task.condition !== "ready") {
    return false;
  }

  const assignee = task.metadata["assignee"] as string | undefined;
  if (!assignee) {
    // No assignee — needs real analysis agent. Don't auto-transition.
    return false;
  }

  const now = Date.now();
  const fenceToken = task.currentFenceToken + 1;
  const sessionId = crypto.randomUUID();

  const daemonCtx: AgentContext = {
    sessionId,
    agentId: "daemon:auto-analysis",
    memoryRef: null,
    contextTokens: null,
    modelId: "daemon",
  };

  const lease: LeaseGranted = {
    type: "LeaseGranted",
    taskId: task.id,
    ts: now,
    fenceToken,
    agentId: "daemon:auto-analysis",
    phase: "analysis",
    leaseTimeout: 60_000,
    sessionId,
    sessionType: "fresh",
    contextBudget: task.contextBudget || config.defaultContextBudget,
    agentContext: daemonCtx,
  };
  const leaseResult = core.submit(lease);
  if (!leaseResult.ok) {
    console.error(`[analysis] LeaseGranted failed for T${task.id}: ${leaseResult.error.message}`);
    return false;
  }

  // PhaseTransition: analysis.active → execution.ready
  const transition: PhaseTransition = {
    type: "PhaseTransition",
    taskId: task.id,
    ts: now + 1,
    from: { phase: "analysis", condition: "active" },
    to: { phase: "execution", condition: "ready" },
    reasonCode: "decision_execute",
    reason: `Auto-analysis: assignee=${assignee}, proceeding to execution`,
    fenceToken,
    agentContext: daemonCtx,
  };
  const transResult = core.submit(transition);
  if (!transResult.ok) {
    console.error(`[analysis] PhaseTransition failed for T${task.id}: ${transResult.error.message}`);
    return false;
  }

  // AgentExited (virtual agent)
  const exited: AgentExited = {
    type: "AgentExited",
    taskId: task.id,
    ts: now + 2,
    fenceToken,
    exitCode: 0,
    reportedCost: 0,
    agentContext: daemonCtx,
  };
  const exitResult = core.submit(exited);
  if (!exitResult.ok) {
    // Non-critical — the transition already happened
    console.warn(`[analysis] AgentExited failed for T${task.id}: ${exitResult.error.message}`);
  }

  return true;
}
