import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Core } from "../core/index.js";
import type { Task, TaskId } from "../core/types.js";
import type { Config } from "./config.js";
import {
  getJournalContent,
  getFailureSummaries,
} from "./journal.js";
import { getWorktreePath } from "./worktree.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface PromptOverrides {
  journalWorktreePath?: string | null;
  codeWorktreePath?: string | null;
}

/**
 * Build a prompt for an agent working on a task.
 *
 * @param mode "work" for execution/analysis, "review" for review phase
 */
export function buildPrompt(
  core: Core,
  taskId: TaskId,
  mode: "work" | "review",
  config: Config,
  overrides?: PromptOverrides,
): string {
  const task = core.getTask(taskId);
  if (!task) return `Error: Task ${taskId} not found`;

  if (mode === "review") {
    return buildReviewPrompt(core, task, config);
  }
  return buildWorkPrompt(core, task, config, overrides);
}

// ---------------------------------------------------------------------------
// Work prompt
// ---------------------------------------------------------------------------

function buildWorkPrompt(core: Core, task: Task, config: Config, overrides?: PromptOverrides): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Task T${task.id}: ${task.title}`);
  sections.push("");

  // Metadata
  const priority = (task.metadata["priority"] as string) ?? "medium";
  const assignee = (task.metadata["assignee"] as string) ?? "unassigned";
  const reviewer = (task.metadata["reviewer"] as string) ?? "none";
  const consulted = (task.metadata["consulted"] as string) ?? "none";

  sections.push(`**Priority**: ${priority}`);
  sections.push(`**Assignee**: ${assignee}`);
  sections.push(`**Reviewer**: ${reviewer}`);
  if (consulted !== "none") {
    sections.push(`**Consulted**: ${consulted}`);
  }
  sections.push(`**Phase**: ${task.phase ?? "unknown"}`);
  sections.push("");

  // Description
  sections.push("## Task Description");
  sections.push("");
  sections.push(task.description);
  sections.push("");

  // Evidence from previous attempts (failure summaries)
  if (task.failureSummaries.length > 0) {
    sections.push("## Previous Attempts");
    sections.push("");
    for (const fs of task.failureSummaries) {
      sections.push(`- **What failed**: ${fs.whatFailed}`);
      if (fs.whatWasLearned) {
        sections.push(`  **Learned**: ${fs.whatWasLearned}`);
      }
    }
    sections.push("");
  }

  // Review feedback (if returning from review)
  if (task.reviewState && task.reviewState.verdicts.length > 0) {
    sections.push("## Review Feedback");
    sections.push("");
    for (const v of task.reviewState.verdicts) {
      sections.push(`### Round ${v.round} — ${v.reviewer}`);
      sections.push(`**Verdict**: ${v.verdict}`);
      sections.push(v.reasoning);
      sections.push("");
    }
  }

  // Parent context (if task has a parent, load the parent's journal)
  const parentId = task.metadata["parentId"] as string | undefined;
  if (parentId) {
    const parentJournal = getJournalContent(config.journalRepoPath, parentId);
    if (parentJournal) {
      sections.push("## Parent Context");
      sections.push("");
      // Truncate to avoid bloating the prompt
      const maxLen = 3000;
      if (parentJournal.length > maxLen) {
        sections.push(parentJournal.slice(0, maxLen));
        sections.push(`\n... (truncated, ${parentJournal.length - maxLen} chars omitted)`);
      } else {
        sections.push(parentJournal);
      }
      sections.push("");
    }
  }

  // Sibling failure summaries (from unmerged branches of the same task)
  const siblingFailures = getFailureSummaries(config.journalRepoPath, task.id);
  if (siblingFailures.length > 0) {
    sections.push("## Sibling Failures");
    sections.push("");
    sections.push("These are failure summaries from other tasks that may be relevant:");
    sections.push("");
    for (const sf of siblingFailures.slice(0, 5)) {
      sections.push(`### T${sf.taskId}`);
      sections.push(sf.content);
      sections.push("");
    }
  }

  // Workspace conventions
  const agentsMd = loadAgentsMd(config.workspaceDir);
  if (agentsMd) {
    sections.push("## Workspace Conventions");
    sections.push("");
    sections.push(agentsMd);
    sections.push("");
  }

  // Workspace paths — use actual worktree paths when available
  const journalBase = overrides?.journalWorktreePath
    ?? getWorktreePath(config.worktreeBaseDir, task.id, "journal");
  const journalPath = `${journalBase}/tasks/T${task.id}/`;
  const hasRepo = !!(task.metadata["repo"] || config.defaultCodeRepo);
  const codeWorktree = overrides?.codeWorktreePath
    ?? (hasRepo
      ? getWorktreePath(config.worktreeBaseDir, task.id, "code")
      : null);

  sections.push("## Your Workspace");
  sections.push("");
  sections.push(`- **Journal**: \`${journalPath}\` — write your work here`);
  sections.push(`  - \`journal.md\` is special: the reviewer sees it first, before anything else. Put your main findings, reasoning, and conclusions there.`);
  sections.push(`  - You can create additional files (reports, data, analysis) in this directory. The reviewer can browse them but won't see them automatically.`);
  if (codeWorktree) {
    sections.push(`- **Code**: \`${codeWorktree}\` — make code changes here`);
  }
  sections.push("- Colony files (AGENTS.md, etc.) are read-only shared resources.");
  sections.push("");

  // Phase 3 guardrail: inject plan doc content if planDoc metadata is set
  const planDocPath = task.metadata["planDoc"] as string | undefined;
  if (planDocPath) {
    try {
      const resolvedPath = path.isAbsolute(planDocPath)
        ? planDocPath
        : path.join(config.workspaceDir, planDocPath);
      const planContent = fs.readFileSync(resolvedPath, "utf-8");
      sections.push("## Implementation Plan");
      sections.push("");
      const maxPlanLen = 4000;
      if (planContent.length > maxPlanLen) {
        sections.push(planContent.slice(0, maxPlanLen));
        sections.push(`\n... (truncated, ${planContent.length - maxPlanLen} chars omitted)`);
      } else {
        sections.push(planContent);
      }
      sections.push("");
    } catch {
      sections.push("## Implementation Plan");
      sections.push("");
      sections.push(`⚠️ Plan document not found: \`${planDocPath}\`. The task requires a plan but the file is missing.`);
      sections.push("");
    }
  }

  // Phase-specific instructions
  if (task.phase === "analysis") {
    appendAnalysisInstructions(sections, task, config);
  } else if (task.phase === "decomposition") {
    appendDecompositionInstructions(sections, task, config);
  } else {
    appendExecutionInstructions(sections, task, config);
  }

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Review prompt
// ---------------------------------------------------------------------------

function buildReviewPrompt(core: Core, task: Task, config: Config): string {
  const sections: string[] = [];

  // Header
  sections.push(`# Review Task T${task.id}: ${task.title}`);
  sections.push("");

  // Original description
  sections.push("## Original Task Description");
  sections.push("");
  sections.push(task.description);
  sections.push("");

  // Evidence from assignee — read from the most recent PhaseTransition to review,
  // which carries the actual evidence the agent submitted (metadata["evidence"] is
  // only set at creation time and goes stale after re-execution cycles).
  const events = core.getEvents(task.id);
  let assigneeEvidence: string | null = null;
  for (let i = events.length - 1; i >= 0; i--) {
    const ev = events[i] as unknown as Record<string, unknown>;
    if (ev["type"] === "PhaseTransition") {
      const to = ev["to"] as { phase: string } | undefined;
      if (to?.phase === "review" && typeof ev["reason"] === "string") {
        assigneeEvidence = ev["reason"] as string;
        break;
      }
    }
  }
  // Fall back to metadata if no PhaseTransition evidence found (e.g. migrated tasks)
  if (!assigneeEvidence) {
    assigneeEvidence = (task.metadata["evidence"] as string | undefined) ?? null;
  }
  if (assigneeEvidence) {
    sections.push("## Assignee Evidence");
    sections.push("");
    sections.push(assigneeEvidence);
    sections.push("");
  }

  // Journal content from the task's branch
  const journalContent = getJournalContent(config.journalRepoPath, task.id);
  if (journalContent) {
    sections.push("## Agent Journal");
    sections.push("");
    const maxJournalLen = 4000;
    if (journalContent.length > maxJournalLen) {
      sections.push(journalContent.slice(0, maxJournalLen));
      sections.push(`\n... (truncated, ${journalContent.length - maxJournalLen} chars omitted)`);
    } else {
      sections.push(journalContent);
    }
    sections.push("");
  }

  // Code changes — prefer worktree branch diff, fall back to colony diff
  const targetRepo = (task.metadata["repo"] as string | undefined) || config.defaultCodeRepo || undefined;
  const diff = targetRepo
    ? getTaskDiff(task, targetRepo)
    : getTaskDiff(task, config.workspaceDir);
  if (diff) {
    sections.push("## Code Changes");
    sections.push("");
    sections.push("```diff");
    // Truncate diff if too large
    const maxDiffLen = 8000;
    if (diff.length > maxDiffLen) {
      sections.push(diff.slice(0, maxDiffLen));
      sections.push(`\n... (truncated, ${diff.length - maxDiffLen} chars omitted)`);
    } else {
      sections.push(diff);
    }
    sections.push("```");
    sections.push("");
  }

  // Previous review rounds
  if (task.reviewState && task.reviewState.verdicts.length > 0) {
    sections.push("## Previous Review Rounds");
    sections.push("");
    for (const v of task.reviewState.verdicts) {
      sections.push(`### Round ${v.round} — ${v.reviewer}: ${v.verdict}`);
      sections.push(v.reasoning);
      sections.push("");
    }
  }

  // Review instructions
  sections.push("## Review Checklist");
  sections.push("");
  sections.push("Evaluate the work against these criteria:");
  sections.push("");
  sections.push("1. **Deliverable exists**: Does the work product exist?");
  sections.push("2. **Criteria alignment**: Does it meet the task requirements?");
  sections.push("3. **Evidence accuracy**: Is the reported evidence accurate?");
  sections.push("4. **Tests pass**: Do tests pass? (if applicable)");
  sections.push("5. **No regressions**: Any regressions introduced?");
  sections.push("6. **Code quality**: Is the code clean and maintainable?");
  sections.push("");

  // Status update instructions
  sections.push("## How to Submit Your Review");
  sections.push("");
  sections.push("```bash");
  sections.push(`# Approve (mark as done):`);
  sections.push(`curl -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/status \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"status": "done", "evidence": "Review passed: <your review notes>"}'`);
  sections.push("");
  sections.push(`# Request changes:`);
  sections.push(`curl -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/status \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"status": "pending", "evidence": "Changes needed: <specific feedback>"}'`);
  sections.push("```");
  sections.push("");

  return sections.join("\n");
}

// ---------------------------------------------------------------------------
// Phase-specific instructions
// ---------------------------------------------------------------------------

function appendAnalysisInstructions(sections: string[], task: Task, config: Config): void {
  sections.push("## Your Role: Analyst");
  sections.push("");
  sections.push("You are analyzing this task to decide the best approach. Your job is NOT to do the work — it is to decide HOW the work should be done.");
  sections.push("");
  sections.push("Consider:");
  sections.push("- Is this task simple enough to execute directly by a single agent?");
  sections.push("- Is it complex enough that it should be decomposed into smaller subtasks?");
  sections.push("- Is it impossible, blocked, or missing critical information?");
  if (task.failureSummaries.length > 0) {
    sections.push("- Previous attempts have failed (see above). What went wrong? Should we try a different approach or decompose differently?");
  }
  if (task.approachHistory.length > 0) {
    sections.push("");
    sections.push("### Previous Approaches");
    sections.push("");
    for (const approach of task.approachHistory) {
      sections.push(`- **v${approach.version}**: ${approach.description} — outcome: ${approach.outcome}`);
      if (approach.failureSummary) {
        sections.push(`  Failed: ${approach.failureSummary}`);
      }
    }
    sections.push("");
  }
  sections.push("");
  sections.push("## How to Report Your Decision");
  sections.push("");
  sections.push("Choose ONE of these options:");
  sections.push("");
  sections.push("```bash");
  sections.push(`# Option 1: Execute directly (task is simple enough for one agent)`);
  sections.push(`curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/status \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"status": "execute"}'`);
  sections.push("");
  sections.push(`# Option 2: Decompose into subtasks (task is too complex for one agent)`);
  sections.push(`# Start a decomposition session — the response will guide you through adding subtasks one at a time:`);
  sections.push(`curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/decompose/start`);
  sections.push("");
  sections.push(`# Option 3: Block (cannot proceed, missing info or impossible)`);
  sections.push(`curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/status \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"status": "blocked", "evidence": "Why this cannot proceed"}'`);
  sections.push("```");
  sections.push("");
  sections.push("## Rules");
  sections.push("");
  sections.push("- Do NOT do the actual work. Your job is to analyze and decide.");
  sections.push("- Write your analysis in the journal before submitting your decision.");
  sections.push("- If previous attempts failed, explain what should change this time.");
  sections.push("- Prefer `execute` for tasks a single agent can handle in one session.");
  sections.push("- Prefer `decompose` for tasks that need multiple independent work streams.");
  sections.push("");
}

function appendDecompositionInstructions(sections: string[], task: Task, config: Config): void {
  const costRemaining = task.cost.allocated - task.cost.consumed - task.cost.childAllocated + task.cost.childRecovered;

  sections.push("## Your Role: Decomposer");
  sections.push("");
  sections.push("You are breaking this task into smaller, independent subtasks. Each subtask will be assigned to an agent and executed separately.");
  sections.push("");
  sections.push(`**Cost budget remaining**: ${costRemaining} (you must allocate cost to each child from this budget)`);
  sections.push(`**Decomposition version**: ${task.decompositionVersion + 1}` + (task.decompositionVersion > 0 ? " (re-decomposition — previous attempt failed)" : ""));
  sections.push("");
  if (task.approachHistory.length > 0) {
    sections.push("### Previous Decompositions");
    sections.push("");
    for (const approach of task.approachHistory) {
      sections.push(`- **v${approach.version}**: ${approach.description} — outcome: ${approach.outcome}`);
      if (approach.failureSummary) {
        sections.push(`  Failed: ${approach.failureSummary}`);
      }
    }
    sections.push("");
    sections.push("**Do not repeat the same decomposition.** Use a different strategy.");
    sections.push("");
  }
  sections.push("## Guidelines");
  sections.push("");
  sections.push("- Each subtask should be completable by a single agent in one session");
  sections.push("- Subtasks should be as independent as possible");
  sections.push("- Allocate cost proportional to expected complexity (total must not exceed " + costRemaining + ")");
  sections.push("- Leave `skipAnalysis` unset (defaults to false) — the analyst evaluates feasibility before execution. Only set `skipAnalysis: true` for trivial subtasks.");
  sections.push("- Set dependencies between subtasks when order matters");
  sections.push("");
  sections.push("## How to Submit Your Decomposition");
  sections.push("");
  sections.push("Preferred when you already have a checklist: use the one-shot plan flow (`task plan --file plan.md` or `task decompose plan --stdin`).");
  sections.push("If you need to build children incrementally, use the step-by-step decompose flow below:");
  sections.push("");
  sections.push("```bash");
  sections.push(`# Step 1: Start a decomposition session`);
  sections.push(`curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/decompose/start`);
  sections.push("");
  sections.push(`# Step 2: Add children one at a time (repeat for each subtask)`);
  sections.push(`curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/decompose/add-child \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"title": "Subtask title", "description": "...", "costAllocation": 10}'`);
  sections.push("");
  sections.push(`# Step 3: Commit when all children are added`);
  sections.push(`curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/decompose/commit \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"approach": "Brief description of your decomposition strategy"}'`);
  sections.push("```");
  sections.push("");
  sections.push("Each response includes guidance for the next step. Optional child fields: `assignee`, `reviewer`, `dependsOnSiblings` (0-based sibling indices).");
  sections.push("");
  sections.push("## Rules");
  sections.push("");
  sections.push("- Do NOT do the actual work. Your job is to plan and decompose.");
  sections.push("- Write your decomposition rationale in the journal.");
  sections.push("- Each child must have a clear, self-contained description.");
  sections.push("- Total child cost allocations must not exceed " + costRemaining + ".");
  sections.push("");
}

function appendExecutionInstructions(sections: string[], task: Task, config: Config): void {
  sections.push("## How to Report Status");
  sections.push("");
  sections.push("When done, report your status:");
  sections.push("");
  sections.push("```bash");
  sections.push(`# Work complete → submit for review:`);
  sections.push(`curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/status \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"status": "review", "evidence": "Description of what you did"}'`);
  sections.push("");
  sections.push(`# Blocked → cannot proceed:`);
  sections.push(`curl -s -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/status \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"status": "blocked", "evidence": "What is blocking you"}'`);
  sections.push("```");
  sections.push("");
  sections.push("## Rules");
  sections.push("");
  sections.push("- Focus ONLY on this task. Do not work on other tasks.");
  sections.push("- Report `review` when work is complete and ready for review.");
  sections.push("- Report `blocked` if you cannot proceed, with a clear explanation.");
  sections.push("- Do not mark your own work as `done` — only reviewers do that.");
  sections.push("- Commit your changes with the prefix `T" + task.id + "` in the commit message.");
  sections.push("");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function loadAgentsMd(workspaceDir: string): string | null {
  const agentsPath = path.join(workspaceDir, "AGENTS.md");
  try {
    return fs.readFileSync(agentsPath, "utf-8");
  } catch {
    return null;
  }
}

function getTaskDiff(task: Task, workspaceDir: string): string | null {
  const taskPrefix = `T${task.id}`;

  try {
    // Strategy 1: Find commits tagged with T{id} prefix and diff only those
    const logCmd = `git log --oneline --all --grep="^${taskPrefix}" --format="%H" 2>/dev/null`;
    const commits = execSync(logCmd, { cwd: workspaceDir, encoding: "utf-8" }).trim();

    if (commits) {
      const commitList = commits.split("\n");
      const oldest = commitList[commitList.length - 1]!;
      const newest = commitList[0]!;
      // Scope diff to only the task's own commits (oldest^..newest),
      // not oldest^..HEAD which includes all other tasks' changes too.
      const diffCmd = `git diff ${oldest}^..${newest} -- . 2>/dev/null`;
      try {
        const diff = execSync(diffCmd, { cwd: workspaceDir, encoding: "utf-8" }).trim();
        if (diff) return diff;
      } catch {
        // Fall through to strategy 2
      }
    }

    // Strategy 2: Uncommitted changes scoped to task prefix in file paths
    // (this is a best-effort fallback — not all tasks have file path patterns)
    const diff = execSync("git diff HEAD 2>/dev/null", {
      cwd: workspaceDir,
      encoding: "utf-8",
    }).trim();
    if (diff) return diff;

    return null;
  } catch {
    return null;
  }
}
