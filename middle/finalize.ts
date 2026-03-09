import { execFileSync } from "node:child_process";
import type {
  ArtifactEvidence,
  CompletionVerification,
  Task,
} from "../core/types.js";
import type { Config } from "./config.js";
import { taskBranch } from "./journal.js";

// ---------------------------------------------------------------------------
// Artifact verification for task completion
// ---------------------------------------------------------------------------

/**
 * Verify that a task has produced real artifacts before allowing completion.
 *
 * Rules:
 * - Code tasks (metadata.repo set): require commits ahead of base branch
 * - Tasks without repo metadata: pass (backward compatible)
 */
export function verifyArtifacts(
  task: Task,
  config: Config,
): CompletionVerification {
  const evidence: ArtifactEvidence[] = [];
  const now = new Date().toISOString();

  const repoPath =
    (task.metadata["repo"] as string | undefined) ||
    config.defaultCodeRepo ||
    undefined;

  // No code repo configured — skip code verification (backward compatible)
  if (!repoPath) {
    return {
      passed: true,
      reason: "No code repo configured; skipping artifact verification",
      checkedAt: now,
      evidence,
    };
  }

  const branch = taskBranch(task.id);
  const parentId =
    task.parentId ??
    (task.metadata["parentId"] as string | undefined) ??
    null;
  const baseBranch = parentId ? taskBranch(parentId) : "main";

  // Check if the task branch exists
  if (!branchExistsInRepo(repoPath, branch)) {
    return {
      passed: false,
      reason: `Task branch ${branch} does not exist in ${repoPath}`,
      checkedAt: now,
      evidence,
    };
  }

  // Check if base branch exists; fall back to main
  const actualBase = branchExistsInRepo(repoPath, baseBranch)
    ? baseBranch
    : "main";

  // Count commits ahead of base
  const { aheadCount, changedFiles } = getAheadInfo(
    repoPath,
    branch,
    actualBase,
  );

  const codeEvidence: ArtifactEvidence = {
    kind: "code",
    repo: repoPath,
    branch,
    baseRef: actualBase,
    headRef: branch,
    aheadCount,
    changedFiles,
  };
  evidence.push(codeEvidence);

  if (aheadCount === 0) {
    return {
      passed: false,
      reason: `No commits on ${branch} ahead of ${actualBase}; no code changes detected`,
      checkedAt: now,
      evidence,
    };
  }

  return {
    passed: true,
    reason: `${aheadCount} commit(s) ahead of ${actualBase} with ${changedFiles.length} file(s) changed`,
    checkedAt: now,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function branchExistsInRepo(repoPath: string, branch: string): boolean {
  try {
    gitSync(repoPath, ["rev-parse", "--verify", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

function getAheadInfo(
  repoPath: string,
  branch: string,
  base: string,
): { aheadCount: number; changedFiles: string[] } {
  try {
    // Count commits on branch not in base
    const countOutput = gitSync(repoPath, [
      "rev-list",
      "--count",
      `${base}..${branch}`,
    ]).trim();
    const aheadCount = parseInt(countOutput, 10) || 0;

    // Get list of changed files
    let changedFiles: string[] = [];
    if (aheadCount > 0) {
      try {
        const diffOutput = gitSync(repoPath, [
          "diff",
          "--name-only",
          `${base}...${branch}`,
        ]).trim();
        changedFiles = diffOutput ? diffOutput.split("\n") : [];
      } catch {
        // Non-fatal — we have the commit count at least
      }
    }

    return { aheadCount, changedFiles };
  } catch {
    return { aheadCount: 0, changedFiles: [] };
  }
}

function gitSync(cwd: string, args: string[]): string {
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
