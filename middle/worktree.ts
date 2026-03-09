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

  if (useGitCrypt) {
    const args = startPoint
      ? ["worktree", "add", "--no-checkout", worktreePath, "-b", branch, startPoint]
      : ["worktree", "add", "--no-checkout", worktreePath, branch];

    try {
      git(repoPath, args);
    } catch (err) {
      if (startPoint && String(err).includes("already exists")) {
        git(repoPath, ["worktree", "add", "--no-checkout", worktreePath, branch]);
      } else {
        throw err;
      }
    }

    // Symlink git-crypt keys before checkout
    applyGitCryptSymlink(repoPath, worktreePath);

    // Now checkout with the keys in place
    git(worktreePath, ["checkout", branch, "--"]);
  } else {
    const args = startPoint
      ? ["worktree", "add", worktreePath, "-b", branch, startPoint]
      : ["worktree", "add", worktreePath, branch];

    try {
      git(repoPath, args);
    } catch (err) {
      if (startPoint && String(err).includes("already exists")) {
        git(repoPath, ["worktree", "add", worktreePath, branch]);
      } else {
        throw err;
      }
    }

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
 */
export function cleanupStaleWorktrees(baseDir: string): number {
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

  // Prune worktree references from repos that had worktrees here.
  // We can't know which repos they belonged to, but the repos will
  // auto-prune stale entries on next `git worktree list`.

  return cleaned;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Run a git command. */
function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
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
