import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
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
  const now = new Date().toISOString();

  // Coordinator tasks delegate code verification to their children
  if (task.children.length > 0) {
    return {
      passed: true,
      reason: `Coordinator task with ${task.children.length} children — code verification delegated to children`,
      checkedAt: now,
      evidence: [],
    };
  }

  const evidence: ArtifactEvidence[] = [];
  const explicitRepo = normalizeRepo(task.metadata["repo"]);
  const fileEvidence = collectDeclaredOutputEvidence(task, config);
  evidence.push(...fileEvidence);

  const repoPath =
    explicitRepo ||
    config.defaultCodeRepo ||
    undefined;

  // No code repo configured — skip code verification (backward compatible)
  if (!repoPath) {
    if (fileEvidence.length > 0) {
      return {
        passed: true,
        reason: summarizeFileEvidence(fileEvidence),
        checkedAt: now,
        evidence,
      };
    }

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
    if (!explicitRepo && fileEvidence.length > 0) {
      return {
        passed: true,
        reason: `${summarizeFileEvidence(fileEvidence)}; no task branch required`,
        checkedAt: now,
        evidence,
      };
    }

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
    if (!explicitRepo && fileEvidence.length > 0) {
      return {
        passed: true,
        reason: `${summarizeFileEvidence(fileEvidence)}; no repo commits required`,
        checkedAt: now,
        evidence,
      };
    }

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

function normalizeRepo(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const repo = value.trim();
  return repo ? repo : null;
}

function summarizeFileEvidence(evidence: ArtifactEvidence[]): string {
  return `Found ${evidence.length} declared deliverable file(s)`;
}

function collectDeclaredOutputEvidence(
  task: Task,
  config: Config,
): ArtifactEvidence[] {
  const results: ArtifactEvidence[] = [];

  for (const outputPath of collectDeclaredOutputPaths(task.description, config.workspaceDir)) {
    try {
      const stat = fs.statSync(outputPath);
      if (!stat.isFile()) continue;
      results.push({
        kind: "file",
        path: outputPath,
        sizeBytes: stat.size,
      });
    } catch {
      // Missing declared file is non-fatal here; verifier will decide overall.
    }
  }

  return results;
}

function collectDeclaredOutputPaths(
  description: string,
  workspaceDir: string,
): string[] {
  const results = new Set<string>();
  const markers = [
    "save",
    "saved",
    "salvar",
    "salve",
    "output file",
    "output path",
    "arquivo de saída",
    "arquivo final",
    "deliverable",
  ];
  const markerPattern = markers
    .map((marker) => marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const inlinePattern = new RegExp(
    `(?:${markerPattern})[\\s\\S]{0,240}?\\\`([^\\\`]+)\\\``,
    "gi",
  );

  for (const match of description.matchAll(inlinePattern)) {
    const normalized = normalizeDeclaredPath(match[1]!, workspaceDir);
    if (normalized) results.add(normalized);
  }

  let previousWasMarker = false;
  for (const rawLine of description.split("\n")) {
    const line = rawLine.trim();
    if (!line) {
      previousWasMarker = false;
      continue;
    }

    const hasMarker = new RegExp(`(?:${markerPattern})`, "i").test(line);
    const pathMatches = [...line.matchAll(/`([^`]+)`/g)];

    if ((hasMarker || previousWasMarker) && pathMatches.length > 0) {
      for (const match of pathMatches) {
        const normalized = normalizeDeclaredPath(match[1]!, workspaceDir);
        if (normalized) results.add(normalized);
      }
    }

    previousWasMarker = hasMarker;
  }

  return [...results];
}

function normalizeDeclaredPath(
  rawPath: string,
  workspaceDir: string,
): string | null {
  const candidate = rawPath.trim();
  if (!candidate || candidate.includes("://")) return null;
  if (candidate.endsWith(path.sep)) return null;

  if (path.isAbsolute(candidate)) return candidate;
  if (!looksLikeRelativePath(candidate)) return null;

  return path.join(workspaceDir, candidate);
}

function looksLikeRelativePath(candidate: string): boolean {
  return (
    candidate.startsWith("./")
    || candidate.startsWith("../")
    || /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)+$/.test(candidate)
  );
}
