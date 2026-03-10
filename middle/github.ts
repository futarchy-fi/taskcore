import { execFileSync } from "node:child_process";

// ---------------------------------------------------------------------------
// GitHub PR creation via `gh` CLI
// ---------------------------------------------------------------------------

export interface PrResult {
  created: boolean;
  url: string | null;
  error: string | null;
}

/**
 * Create (or find existing) GitHub PR from taskBranch → baseBranch.
 *
 * Uses the `gh` CLI which handles auth via GH_TOKEN / gh auth.
 * Returns the PR URL on success.
 */
export function createOrFindPr(
  repoPath: string,
  taskBranch: string,
  baseBranch: string,
  title: string,
  body: string,
): PrResult {
  // First push the branch to remote
  try {
    gitSync(repoPath, ["push", "-u", "origin", taskBranch]);
  } catch (err) {
    const msg = String(err);
    // "Everything up-to-date" is fine
    if (!msg.includes("up-to-date") && !msg.includes("up to date")) {
      return { created: false, url: null, error: `Push failed: ${msg.slice(0, 200)}` };
    }
  }

  // Check for existing PR
  try {
    const existing = ghSync(repoPath, [
      "pr", "list",
      "--head", taskBranch,
      "--base", baseBranch,
      "--state", "open",
      "--json", "url",
      "--jq", ".[0].url",
    ]).trim();

    if (existing) {
      return { created: false, url: existing, error: null };
    }
  } catch {
    // gh pr list failed — continue to create
  }

  // Create PR
  try {
    const url = ghSync(repoPath, [
      "pr", "create",
      "--head", taskBranch,
      "--base", baseBranch,
      "--title", title,
      "--body", body,
    ]).trim();

    return { created: true, url: url || null, error: null };
  } catch (err) {
    const msg = String(err);
    // If PR already exists, extract URL
    if (msg.includes("already exists")) {
      try {
        const existing = ghSync(repoPath, [
          "pr", "view", taskBranch,
          "--json", "url",
          "--jq", ".url",
        ]).trim();
        if (existing) {
          return { created: false, url: existing, error: null };
        }
      } catch { /* fall through */ }
    }
    return { created: false, url: null, error: `PR creation failed: ${msg.slice(0, 200)}` };
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function gitSync(cwd: string, args: string[]): string {
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

function ghSync(cwd: string, args: string[]): string {
  return execFileSync("gh", args, {
    cwd,
    encoding: "utf-8",
    timeout: 30_000,
  });
}
