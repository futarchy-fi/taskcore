import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Core } from "../core/index.js";
import type { Task, TaskId } from "../core/types.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

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
): string {
  const task = core.getTask(taskId);
  if (!task) return `Error: Task ${taskId} not found`;

  if (mode === "review") {
    return buildReviewPrompt(core, task, config);
  }
  return buildWorkPrompt(core, task, config);
}

// ---------------------------------------------------------------------------
// Work prompt
// ---------------------------------------------------------------------------

function buildWorkPrompt(core: Core, task: Task, config: Config): string {
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

  // Workspace conventions
  const agentsMd = loadAgentsMd(config.workspaceDir);
  if (agentsMd) {
    sections.push("## Workspace Conventions");
    sections.push("");
    sections.push(agentsMd);
    sections.push("");
  }

  // Status update instructions
  sections.push("## How to Report Status");
  sections.push("");
  sections.push("When you finish your work, report your status using one of these methods:");
  sections.push("");
  sections.push("### Option 1: HTTP API");
  sections.push("```bash");
  sections.push(`curl -X POST http://127.0.0.1:${config.port}/tasks/${task.id}/status \\`);
  sections.push(`  -H 'Content-Type: application/json' \\`);
  sections.push(`  -d '{"status": "review", "evidence": "Description of what you did"}'`);
  sections.push("```");
  sections.push("");
  sections.push("### Option 2: CLI bridge");
  sections.push("```bash");
  sections.push(`python3 task-update-bridge.py --task-id ${task.id} --status review --evidence "Description of what you did"`);
  sections.push("```");
  sections.push("");
  sections.push("### Option 3: MCP tool");
  sections.push("Use the `update_status` MCP tool with `taskId`, `status`, and `evidence` parameters.");
  sections.push("");

  // Behavioral rules
  sections.push("## Rules");
  sections.push("");
  sections.push("- Focus ONLY on this task. Do not work on other tasks.");
  sections.push("- Report `review` when work is complete and ready for review.");
  sections.push("- Report `blocked` if you cannot proceed, with a clear explanation.");
  sections.push("- Do not mark your own work as `done` — only reviewers do that.");
  sections.push("- Commit your changes with the prefix `T" + task.id + "` in the commit message.");
  sections.push("");

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

  // Evidence from assignee
  const evidence = task.metadata["evidence"] as string | undefined;
  if (evidence) {
    sections.push("## Assignee Evidence");
    sections.push("");
    sections.push(evidence);
    sections.push("");
  }

  // Code changes (git diff)
  const diff = getTaskDiff(task, config.workspaceDir);
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
    // Strategy 1: Find commits tagged with T{id} prefix
    const logCmd = `git log --oneline --all --grep="^${taskPrefix}" --format="%H" 2>/dev/null`;
    const commits = execSync(logCmd, { cwd: workspaceDir, encoding: "utf-8" }).trim();

    if (commits) {
      const commitList = commits.split("\n");
      const oldest = commitList[commitList.length - 1]!;
      const diffCmd = `git diff ${oldest}^..HEAD -- . 2>/dev/null`;
      try {
        const diff = execSync(diffCmd, { cwd: workspaceDir, encoding: "utf-8" }).trim();
        if (diff) return diff;
      } catch {
        // Fall through to strategy 2
      }
    }

    // Strategy 2: Uncommitted changes
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
