#!/usr/bin/env tsx
/**
 * migrate.ts — One-shot migration from tasks.json to the taskcore event store.
 *
 * Reads the old tasks.json format and emits synthetic events to reconstruct
 * task state in the new OrchestrationCore.
 *
 * Usage:
 *   npx tsx middle/migrate.ts --tasks-file /path/to/tasks.json [--db /path/to/taskcore.db]
 */

import * as fs from "node:fs";
import { OrchestrationCore } from "../core/index.js";
import { checkInvariants } from "../core/invariants.js";
import {
  DEFAULT_ATTEMPT_BUDGETS,
  type AgentContext,
  type Event,
  type FailureSummary,
  type TaskCreated,
} from "../core/types.js";

// ---------------------------------------------------------------------------
// Old task shape
// ---------------------------------------------------------------------------

interface OldTask {
  id: number;
  title: string;
  description: string;
  status: string;
  priority?: string;
  assignee?: string | null;
  reviewer?: string | null;
  consulted?: string | null;
  evidence?: string;
  dependencies?: number[];
  subtasks?: number[];
  parentTaskId?: number;
  metadata?: Record<string, unknown>;
  comments?: Array<{ author: string; body: string; round?: number }>;
  informed?: string | string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadOldTasks(filePath: string): OldTask[] {
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));

  // Handle both formats: flat array or { master: { tasks: [...] } }
  if (Array.isArray(raw)) return raw;
  if (raw?.master?.tasks) return raw.master.tasks;
  if (raw?.data?.master?.tasks) return raw.data.master.tasks;

  throw new Error("Unrecognized tasks.json format");
}

const syntheticCtx: AgentContext = {
  sessionId: "migration",
  agentId: "migrate",
  memoryRef: null,
  contextTokens: null,
  modelId: "migration",
};

function syntheticSource() {
  return { type: "middle" as const, id: "migrate" };
}

// ---------------------------------------------------------------------------
// Migration logic
// ---------------------------------------------------------------------------

function migrateTask(
  core: OrchestrationCore,
  task: OldTask,
  allTasks: OldTask[],
): void {
  const taskId = String(task.id);
  const parentId = task.parentTaskId ? String(task.parentTaskId) : null;
  const rootId = findRootId(task, allTasks);
  const now = Date.now();

  // Determine if we should skip analysis (migrated tasks already analyzed)
  const hasAssignee = !!task.assignee;

  // 1. TaskCreated — all tasks start here
  const created: TaskCreated = {
    type: "TaskCreated",
    taskId,
    ts: now,
    title: task.title || `Task ${task.id}`,
    description: task.description || task.title || `Task ${task.id}`,
    parentId,
    rootId: String(rootId),
    initialPhase: "analysis",
    initialCondition: "ready",
    attemptBudgets: DEFAULT_ATTEMPT_BUDGETS,
    costBudget: 100,
    dependencies: [],
    reviewConfig: task.reviewer
      ? { required: true, attemptBudget: 3, isolationRules: [] }
      : null,
    skipAnalysis: false,
    metadata: {
      assignee: task.assignee ?? null,
      reviewer: task.reviewer ?? null,
      consulted: task.consulted ?? null,
      priority: task.priority ?? "medium",
      informed: task.informed ?? null,
      evidence: task.evidence ?? null,
      migratedFrom: "tasks.json",
      migratedAt: new Date().toISOString(),
      originalStatus: task.status,
      ...(task.metadata ?? {}),
    },
    source: syntheticSource(),
  };

  const createResult = core.submit(created);
  if (!createResult.ok) {
    console.error(`  [migrate] Failed to create T${taskId}: ${createResult.error.message}`);
    return;
  }

  // 2. Transition based on old status
  const status = normalizeStatus(task.status);

  switch (status) {
    case "pending": {
      // Auto-transition to execution.ready if has assignee
      if (hasAssignee) {
        autoTransitionToExecution(core, taskId, now);
      }
      break;
    }

    case "in-progress": {
      // Create → analysis.ready → execution.ready (auto) → lease + start
      if (hasAssignee) {
        autoTransitionToExecution(core, taskId, now);
        leaseAndStart(core, taskId, task.assignee!, now);
      }
      break;
    }

    case "review": {
      // Create → execution → review.ready
      if (hasAssignee) {
        autoTransitionToExecution(core, taskId, now);
        leaseAndStart(core, taskId, task.assignee!, now);
        transitionToReview(core, taskId, now, task.evidence);
      }
      break;
    }

    case "changes-requested": {
      // Same as pending but with review history
      if (hasAssignee) {
        autoTransitionToExecution(core, taskId, now);
      }
      break;
    }

    case "blocked": {
      // Create → execution.ready → blocked
      if (hasAssignee) {
        autoTransitionToExecution(core, taskId, now);
      }
      blockTask(core, taskId, now, task.metadata?.["blockerReason"] as string ?? "Migrated as blocked");
      break;
    }

    case "done": {
      // Full lifecycle: create → execute → review → done
      if (hasAssignee) {
        autoTransitionToExecution(core, taskId, now);
        leaseAndStart(core, taskId, task.assignee!, now);
        transitionToReview(core, taskId, now, task.evidence);
        approveAndComplete(core, taskId, now, task.evidence);
      } else {
        // No assignee but done — just complete directly
        autoTransitionToExecution(core, taskId, now);
        leaseAndStart(core, taskId, "migrate", now);
        transitionToReview(core, taskId, now, task.evidence);
        approveAndComplete(core, taskId, now, task.evidence);
      }
      break;
    }
  }
}

// ---------------------------------------------------------------------------
// Synthetic event sequences
// ---------------------------------------------------------------------------

function autoTransitionToExecution(
  core: OrchestrationCore,
  taskId: string,
  baseTs: number,
): void {
  const task = core.getTask(taskId);
  if (!task || task.phase !== "analysis") return;

  const fenceToken = task.currentFenceToken + 1;
  const events: Event[] = [
    {
      type: "LeaseGranted",
      taskId,
      ts: baseTs + 10,
      fenceToken,
      agentId: "migrate",
      phase: "analysis",
      leaseTimeout: 60_000,
      sessionId: "migration",
      sessionType: "fresh",
      contextBudget: 100,
    },
    {
      type: "AgentStarted",
      taskId,
      ts: baseTs + 11,
      fenceToken,
      agentContext: syntheticCtx,
    },
    {
      type: "PhaseTransition",
      taskId,
      ts: baseTs + 12,
      from: { phase: "analysis", condition: "active" },
      to: { phase: "execution", condition: "ready" },
      reasonCode: "decision_execute",
      reason: "Migration: auto-transition to execution",
      fenceToken,
      agentContext: syntheticCtx,
    },
    {
      type: "AgentExited",
      taskId,
      ts: baseTs + 13,
      fenceToken,
      exitCode: 0,
      reportedCost: 0,
      agentContext: syntheticCtx,
    },
  ];

  submitAll(core, events, taskId);
}

function leaseAndStart(
  core: OrchestrationCore,
  taskId: string,
  agentId: string,
  baseTs: number,
): void {
  const task = core.getTask(taskId);
  if (!task || task.condition !== "ready") return;

  const fenceToken = task.currentFenceToken + 1;
  const ctx: AgentContext = { ...syntheticCtx, agentId };

  const events: Event[] = [
    {
      type: "LeaseGranted",
      taskId,
      ts: baseTs + 20,
      fenceToken,
      agentId,
      phase: task.phase!,
      leaseTimeout: 600_000,
      sessionId: "migration",
      sessionType: "fresh",
      contextBudget: 100,
    },
    {
      type: "AgentStarted",
      taskId,
      ts: baseTs + 21,
      fenceToken,
      agentContext: ctx,
    },
  ];

  submitAll(core, events, taskId);
}

function transitionToReview(
  core: OrchestrationCore,
  taskId: string,
  baseTs: number,
  evidence?: string,
): void {
  const task = core.getTask(taskId);
  if (!task || task.phase !== "execution" || task.condition !== "active") return;

  const events: Event[] = [
    {
      type: "PhaseTransition",
      taskId,
      ts: baseTs + 30,
      from: { phase: "execution", condition: "active" },
      to: { phase: "review", condition: "ready" },
      reasonCode: "work_complete",
      reason: evidence ?? "Migration: work marked complete",
      fenceToken: task.currentFenceToken,
      agentContext: syntheticCtx,
    },
  ];

  submitAll(core, events, taskId);
}

function approveAndComplete(
  core: OrchestrationCore,
  taskId: string,
  baseTs: number,
  evidence?: string,
): void {
  // Need to lease reviewer first
  const task = core.getTask(taskId);
  if (!task || task.phase !== "review" || task.condition !== "ready") return;

  const fenceToken = task.currentFenceToken + 1;

  const events: Event[] = [
    {
      type: "LeaseGranted",
      taskId,
      ts: baseTs + 40,
      fenceToken,
      agentId: "migrate:reviewer",
      phase: "review",
      leaseTimeout: 60_000,
      sessionId: "migration",
      sessionType: "fresh",
      contextBudget: 100,
    },
    {
      type: "AgentStarted",
      taskId,
      ts: baseTs + 41,
      fenceToken,
      agentContext: { ...syntheticCtx, agentId: "migrate:reviewer" },
    },
    {
      type: "ReviewVerdictSubmitted",
      taskId,
      ts: baseTs + 42,
      fenceToken,
      reviewer: "migrate:reviewer",
      round: 1,
      verdict: "approve",
      reasoning: evidence ?? "Migration: approved",
      agentContext: { ...syntheticCtx, agentId: "migrate:reviewer" },
    },
    {
      type: "ReviewPolicyMet",
      taskId,
      ts: baseTs + 43,
      outcome: "approved",
      summary: "Migration: review approved",
      source: syntheticSource(),
    },
    {
      type: "TaskCompleted",
      taskId,
      ts: baseTs + 44,
      stateRef: { branch: "main", commit: "migration", parentCommit: "migration" },
    },
  ];

  submitAll(core, events, taskId);
}

function blockTask(
  core: OrchestrationCore,
  taskId: string,
  baseTs: number,
  reason: string,
): void {
  const summary: FailureSummary = {
    childId: null,
    approach: "migration",
    whatFailed: reason,
    whatWasLearned: "",
    artifactRef: null,
  };

  const events: Event[] = [
    {
      type: "TaskBlocked",
      taskId,
      ts: baseTs + 50,
      reason,
      reasonCode: "migrated_blocked",
      summary,
      source: syntheticSource(),
    },
  ];

  submitAll(core, events, taskId);
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function submitAll(core: OrchestrationCore, events: Event[], taskId: string): void {
  for (const event of events) {
    const result = core.submit(event);
    if (!result.ok) {
      console.error(`  [migrate] T${taskId} event ${event.type} failed: ${result.error.message}`);
      return;
    }
  }
}

function normalizeStatus(status: string): string {
  return status
    .replace(/_/g, "-")
    .toLowerCase();
}

function findRootId(task: OldTask, allTasks: OldTask[]): number {
  let current = task;
  const seen = new Set<number>();
  while (current.parentTaskId && !seen.has(current.id)) {
    seen.add(current.id);
    const parent = allTasks.find((t) => t.id === current.parentTaskId);
    if (!parent) break;
    current = parent;
  }
  return current.id;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main(): void {
  const args = process.argv.slice(2);
  let tasksFile = "";
  let dbPath = "";

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--tasks-file" && args[i + 1]) {
      tasksFile = args[++i]!;
    } else if (args[i] === "--db" && args[i + 1]) {
      dbPath = args[++i]!;
    }
  }

  if (!tasksFile) {
    console.error("Usage: npx tsx middle/migrate.ts --tasks-file <path> [--db <path>]");
    process.exit(1);
  }

  if (!dbPath) {
    const workspace = process.env["WORKSPACE_DIR"] ??
      process.env["OPENCLAW_STATE_DIR"] ??
      `${process.env["HOME"]}/.openclaw/workspace`;
    dbPath = `${workspace}/data/taskcore.db`;
  }

  console.log(`[migrate] Reading tasks from: ${tasksFile}`);
  console.log(`[migrate] Database: ${dbPath}`);

  const oldTasks = loadOldTasks(tasksFile);
  console.log(`[migrate] Found ${oldTasks.length} tasks`);

  // Sort by ID to ensure parents are created before children
  oldTasks.sort((a, b) => a.id - b.id);

  const core = new OrchestrationCore({
    dbPath,
    invariantChecks: true,
    snapshotEvery: 50,
  });

  let succeeded = 0;
  let failed = 0;

  for (const task of oldTasks) {
    try {
      console.log(`  [migrate] T${task.id}: ${task.title} (${task.status})`);
      migrateTask(core, task, oldTasks);
      succeeded++;
    } catch (err) {
      console.error(`  [migrate] T${task.id} ERROR:`, err);
      failed++;
    }
  }

  // Run invariant checks
  const state = core.getState();
  const violations = checkInvariants(state);
  if (violations.length > 0) {
    console.error(`\n[migrate] INVARIANT VIOLATIONS (${violations.length}):`);
    for (const v of violations) {
      console.error(`  - ${v.code}: ${v.message}`);
    }
  } else {
    console.log("\n[migrate] All invariants pass");
  }

  console.log(`\n[migrate] Migration complete: ${succeeded} succeeded, ${failed} failed`);
  console.log(`[migrate] Total tasks in core: ${Object.keys(state.tasks).length}`);

  core.close();
}

main();
