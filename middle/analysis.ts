import * as crypto from "node:crypto";
import type { Core } from "../core/index.js";
import type {
  AgentContext,
  AgentExited,
  AgentStarted,
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

  // 1. LeaseGranted
  const lease: LeaseGranted = {
    type: "LeaseGranted",
    taskId: task.id,
    ts: now,
    fenceToken,
    agentId: "daemon:auto-analysis",
    phase: "analysis",
    leaseTimeout: 60_000, // 1 minute (virtual, will complete instantly)
    sessionId,
    sessionType: "fresh",
    contextBudget: task.contextBudget || config.defaultContextBudget,
  };
  const leaseResult = core.submit(lease);
  if (!leaseResult.ok) {
    console.error(`[analysis] LeaseGranted failed for T${task.id}: ${leaseResult.error.message}`);
    return false;
  }

  // 2. AgentStarted
  const started: AgentStarted = {
    type: "AgentStarted",
    taskId: task.id,
    ts: now + 1,
    fenceToken,
    agentContext: daemonCtx,
  };
  const startResult = core.submit(started);
  if (!startResult.ok) {
    console.error(`[analysis] AgentStarted failed for T${task.id}: ${startResult.error.message}`);
    return false;
  }

  // 3. PhaseTransition: analysis.active → execution.ready
  const transition: PhaseTransition = {
    type: "PhaseTransition",
    taskId: task.id,
    ts: now + 2,
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

  // 4. AgentExited (virtual agent)
  const exited: AgentExited = {
    type: "AgentExited",
    taskId: task.id,
    ts: now + 3,
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
