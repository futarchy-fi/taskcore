import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { StateRef } from "../core/types.js";

// ---------------------------------------------------------------------------
// Journal repo — one branch per task, failure summaries as files
// ---------------------------------------------------------------------------

/**
 * Initialize the journal git repo. Idempotent — no-op if already initialized.
 */
export function initJournalRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });

  const gitDir = path.join(repoPath, ".git");
  if (fs.existsSync(gitDir)) return;

  git(repoPath, ["init", "--initial-branch=main"]);
  git(repoPath, ["config", "user.email", "taskcore@localhost"]);
  git(repoPath, ["config", "user.name", "taskcore"]);

  const readme = path.join(repoPath, "README.md");
  fs.writeFileSync(readme, "# Taskcore Journal\n\nOne branch per task.\n");
  git(repoPath, ["add", "README.md"]);
  git(repoPath, ["commit", "-m", "init journal repo"]);
}

/**
 * Create a branch `task/T{id}` with an initial journal directory.
 * If parentTaskId is given, branches from `task/T{parentId}` tip;
 * otherwise branches from main.
 */
export function createTaskBranch(
  repoPath: string,
  taskId: string,
  parentTaskId?: string | null,
): void {
  const branch = taskBranch(taskId);

  // Already exists — idempotent
  if (branchExists(repoPath, branch)) return;

  const startPoint = parentTaskId
    ? taskBranch(parentTaskId)
    : "main";

  // Verify start point exists, fall back to main
  const base = branchExists(repoPath, startPoint) ? startPoint : "main";

  git(repoPath, ["checkout", "-b", branch, base]);

  const taskDir = path.join(repoPath, "tasks", `T${taskId}`);
  fs.mkdirSync(taskDir, { recursive: true });
  fs.writeFileSync(path.join(taskDir, "journal.md"), `# T${taskId} Journal\n`);
  git(repoPath, ["add", "."]);
  git(repoPath, ["commit", "-m", `T${taskId}: init journal`]);

  // Return to main to keep the repo in a clean state
  git(repoPath, ["checkout", "main"]);
}

/**
 * Stage and commit all changes in the task's journal directory.
 */
export function commitJournal(
  worktreePath: string,
  taskId: string,
  message: string,
): void {
  // Only commit if there are changes
  const status = git(worktreePath, ["status", "--porcelain"]);
  if (!status.trim()) return;

  git(worktreePath, ["add", "."]);
  git(worktreePath, ["commit", "-m", `T${taskId}: ${message}`]);
}

/**
 * Write a failure summary file and commit it.
 */
export function writeFailureSummary(
  worktreePath: string,
  taskId: string,
  summary: { whatFailed: string; whatWasLearned: string },
): void {
  const taskDir = path.join(worktreePath, "tasks", `T${taskId}`);
  fs.mkdirSync(taskDir, { recursive: true });

  const content = [
    `# Failure Summary — T${taskId}`,
    "",
    `## What Failed`,
    summary.whatFailed,
    "",
    `## What Was Learned`,
    summary.whatWasLearned,
    "",
    `_Recorded: ${new Date().toISOString()}_`,
    "",
  ].join("\n");

  fs.writeFileSync(path.join(taskDir, "failure-summary.md"), content);
  git(worktreePath, ["add", "."]);
  git(worktreePath, ["commit", "-m", `T${taskId}: failure summary`]);
}

/**
 * Merge task branch into parent branch (or main). Fast-forward when possible.
 */
export function mergeTaskBranch(
  repoPath: string,
  taskId: string,
  parentTaskId?: string | null,
): void {
  const branch = taskBranch(taskId);
  if (!branchExists(repoPath, branch)) return;

  const target = parentTaskId && branchExists(repoPath, taskBranch(parentTaskId))
    ? taskBranch(parentTaskId)
    : "main";

  const current = git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  git(repoPath, ["checkout", target]);

  try {
    git(repoPath, ["merge", "--ff", branch, "-m", `Merge T${taskId} journal`]);
  } catch {
    // If ff fails, allow non-ff merge
    try {
      git(repoPath, ["merge", "--no-ff", branch, "-m", `Merge T${taskId} journal`]);
    } catch {
      // Conflict — abort and leave branch unmerged
      try { git(repoPath, ["merge", "--abort"]); } catch { /* already clean */ }
      console.warn(`[journal] Could not merge ${branch} into ${target}`);
    }
  }

  // Restore original branch
  if (current !== target) {
    try { git(repoPath, ["checkout", current]); } catch { /* best effort */ }
  }
}

/**
 * Read journal.md content from a task's branch via git show (no checkout needed).
 */
export function getJournalContent(
  repoPath: string,
  taskId: string,
): string | null {
  const branch = taskBranch(taskId);
  if (!branchExists(repoPath, branch)) return null;

  try {
    return git(repoPath, ["show", `${branch}:tasks/T${taskId}/journal.md`]);
  } catch {
    return null;
  }
}

/**
 * Collect failure summaries from unmerged sibling task branches.
 * "Siblings" = branches matching task/T{id}* that haven't been merged into
 * the parent or main.
 */
export function getFailureSummaries(
  repoPath: string,
  taskId: string,
): Array<{ taskId: string; content: string }> {
  const results: Array<{ taskId: string; content: string }> = [];

  try {
    // List all task branches
    const branchOutput = git(repoPath, ["branch", "--list", "task/T*", "--format=%(refname:short)"]);
    const branches = branchOutput.trim().split("\n").filter(Boolean);

    for (const branch of branches) {
      // Extract task ID from branch name
      const match = branch.match(/^task\/T(\d+)$/);
      if (!match) continue;
      const branchTaskId = match[1]!;
      if (branchTaskId === taskId) continue; // skip self

      // Check if branch is unmerged (not reachable from main)
      try {
        git(repoPath, ["merge-base", "--is-ancestor", branch, "main"]);
        continue; // Already merged, skip
      } catch {
        // Not merged — read failure summary
      }

      try {
        const content = git(repoPath, [
          "show",
          `${branch}:tasks/T${branchTaskId}/failure-summary.md`,
        ]);
        if (content.trim()) {
          results.push({ taskId: branchTaskId, content });
        }
      } catch {
        // No failure summary on this branch
      }
    }
  } catch {
    // No branches or other git error
  }

  return results;
}

/**
 * Get the current commit hash and parent for a branch → StateRef.
 */
export function getBranchRef(
  repoPath: string,
  branch: string,
): StateRef | null {
  if (!branchExists(repoPath, branch)) return null;

  try {
    const commit = git(repoPath, ["rev-parse", branch]).trim();
    let parentCommit: string;
    try {
      parentCommit = git(repoPath, ["rev-parse", `${branch}^`]).trim();
    } catch {
      parentCommit = commit; // Root commit has no parent
    }
    return { branch, commit, parentCommit };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function taskBranch(taskId: string): string {
  return `task/T${taskId}`;
}

function branchExists(repoPath: string, branch: string): boolean {
  try {
    git(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 10_000,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}
