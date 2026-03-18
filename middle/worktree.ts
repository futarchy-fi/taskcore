import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Git worktree lifecycle
// ---------------------------------------------------------------------------

/**
 * Create a git worktree at worktreePath on the given branch.
 * If startPoint is given, the branch is created from that ref.
 */
export function createWorktree(
  repoPath: string,
  worktreePath: string,
  branch: string,
  startPoint?: string,
): string {
  ensureDir(path.dirname(worktreePath));

  // For git-crypt repos, we must use --no-checkout first, then symlink the
  // crypt keys, then checkout — otherwise the smudge filter fails because
  // the worktree doesn't have the keys yet.
  const useGitCrypt = fs.existsSync(path.join(repoPath, ".git", "git-crypt"));
  const noCheckout = useGitCrypt ? "--no-checkout" : null;
  const resolvedStartPoint = startPoint && refExists(repoPath, startPoint)
    ? startPoint
    : undefined;
  const createBranch = !branchExists(repoPath, branch);

  const addArgs = (withNewBranch: boolean): string[] => {
    const args = ["worktree", "add"];
    if (noCheckout) args.push(noCheckout);
    if (withNewBranch) {
      args.push("-b", branch);
    }
    args.push(worktreePath);
    if (withNewBranch) {
      if (resolvedStartPoint) args.push(resolvedStartPoint);
    } else {
      args.push(branch);
    }
    return args;
  };

  const tryAdd = (): void => {
    try {
      git(repoPath, addArgs(createBranch));
    } catch (err) {
      const msg = String(err);
      // Branch may already exist — retry without -b
      if (createBranch && msg.includes("already exists")) {
        git(repoPath, addArgs(false));
      } else {
        throw err;
      }
    }
  };

  try {
    tryAdd();
  } catch (err) {
    // "already registered worktree" — prune stale refs and retry
    if (String(err).includes("already registered")) {
      git(repoPath, ["worktree", "prune"]);
      tryAdd();
    } else {
      throw err;
    }
  }

  if (useGitCrypt) {
    // Symlink git-crypt keys before checkout
    applyGitCryptSymlink(repoPath, worktreePath);
    // Now checkout with the keys in place
    git(worktreePath, ["checkout", branch, "--"]);
  } else {
    applyGitCryptSymlink(repoPath, worktreePath);
  }

  return worktreePath;
}

/**
 * Remove a worktree. Idempotent — no-op if already removed.
 */
export function removeWorktree(
  repoPath: string,
  worktreePath: string,
): void {
  if (!fs.existsSync(worktreePath)) return;

  try {
    git(repoPath, ["worktree", "remove", "--force", worktreePath]);
  } catch {
    // Force cleanup if git worktree remove fails
    try {
      removeDir(worktreePath);
      git(repoPath, ["worktree", "prune"]);
    } catch {
      // Best effort
    }
  }
}

/**
 * Discard all uncommitted changes in a worktree.
 */
export function discardUncommitted(worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) return;

  try {
    git(worktreePath, ["checkout", "--", "."]);
    git(worktreePath, ["clean", "-fd"]);
  } catch {
    // Best effort
  }
}

/**
 * Compute the worktree path for a task.
 * type is "journal" or "code".
 */
export function getWorktreePath(
  baseDir: string,
  taskId: string,
  type: "journal" | "code",
): string {
  return path.join(baseDir, `${type}-T${taskId}`);
}

/**
 * If the main repo uses git-crypt, symlink its keys into the worktree's
 * git directory so encrypted files can be read.
 */
export function applyGitCryptSymlink(
  repoPath: string,
  worktreePath: string,
): void {
  const mainGitCrypt = path.join(repoPath, ".git", "git-crypt");
  if (!fs.existsSync(mainGitCrypt)) return;

  // In a worktree, .git is a file containing "gitdir: /path/to/gitdir"
  const dotGit = path.join(worktreePath, ".git");
  if (!fs.existsSync(dotGit)) return;

  let gitDir: string;
  const stat = fs.statSync(dotGit);
  if (stat.isFile()) {
    const content = fs.readFileSync(dotGit, "utf-8").trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (!match) return;
    gitDir = path.resolve(worktreePath, match[1]!);
  } else {
    gitDir = dotGit;
  }

  const target = path.join(gitDir, "git-crypt");
  if (fs.existsSync(target)) return; // Already linked

  try {
    fs.symlinkSync(mainGitCrypt, target);
  } catch {
    // Non-fatal
  }
}

/**
 * On daemon startup, remove any leftover worktrees from previous crashes.
 * Also prunes stale worktree references from the given repos so that
 * subsequent `git worktree add` calls don't fail with "already registered".
 */
export function cleanupStaleWorktrees(
  baseDir: string,
  repoPaths?: string[],
): number {
  if (!fs.existsSync(baseDir)) return 0;

  let cleaned = 0;
  const entries = fs.readdirSync(baseDir);

  for (const entry of entries) {
    const fullPath = path.join(baseDir, entry);
    const stat = fs.statSync(fullPath);
    if (!stat.isDirectory()) continue;

    try {
      removeDir(fullPath);
      cleaned++;
    } catch {
      // Best effort
    }
  }

  // Prune stale worktree references from repos that had worktrees here
  if (repoPaths) {
    for (const repo of repoPaths) {
      try {
        if (fs.existsSync(repo)) {
          git(repo, ["worktree", "prune"]);
        }
      } catch {
        // Best effort
      }
    }
  }

  return cleaned;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function branchExists(repoPath: string, branch: string): boolean {
  return refExists(repoPath, `refs/heads/${branch}`);
}

function refExists(repoPath: string, ref: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: repoPath,
      encoding: "utf-8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    return true;
  } catch {
    return false;
  }
}

/** Run a git command. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

/** mkdir -p */
function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

/** rm -rf */
function removeDir(target: string): void {
  fs.rmSync(target, { recursive: true, force: true });
}
