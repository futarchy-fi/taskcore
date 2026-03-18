import { spawnSync } from "node:child_process";
import * as assert from "node:assert/strict";
import * as path from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const journalModuleUrl = pathToFileURL(path.join(repoRoot, "middle/journal.ts")).href;
const worktreeModuleUrl = pathToFileURL(path.join(repoRoot, "middle/worktree.ts")).href;

test("task workspace bootstrap stays silent on stderr for fresh branches", () => {
  const script = [
    'import * as fs from "node:fs";',
    'import * as os from "node:os";',
    'import * as path from "node:path";',
    `import { initJournalRepo, createTaskBranch, taskBranch } from ${JSON.stringify(journalModuleUrl)};`,
    `import { createWorktree } from ${JSON.stringify(worktreeModuleUrl)};`,
    'const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskcore-worktree-noise-"));',
    'const repoPath = path.join(tmpDir, "journal");',
    'initJournalRepo(repoPath);',
    'createTaskBranch(repoPath, "1");',
    'createWorktree(repoPath, path.join(tmpDir, "journal-T1"), taskBranch("1"));',
  ].join("\n");

  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: repoRoot,
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr.trim(), "");
});

test("createWorktree falls back to repo HEAD when start point is missing", () => {
  const script = [
    'import { execFileSync } from "node:child_process";',
    'import * as fs from "node:fs";',
    'import * as os from "node:os";',
    'import * as path from "node:path";',
    `import { createWorktree } from ${JSON.stringify(worktreeModuleUrl)};`,
    'const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskcore-worktree-fallback-"));',
    'const repoPath = path.join(tmpDir, "repo");',
    'fs.mkdirSync(repoPath, { recursive: true });',
    'execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoPath, stdio: "ignore" });',
    'execFileSync("git", ["config", "user.name", "Taskcore Tests"], { cwd: repoPath, stdio: "ignore" });',
    'execFileSync("git", ["config", "user.email", "taskcore-tests@example.com"], { cwd: repoPath, stdio: "ignore" });',
    'fs.writeFileSync(path.join(repoPath, "README.md"), "# test\\n", "utf-8");',
    'execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });',
    'execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });',
    'const worktreePath = path.join(tmpDir, "code-T1");',
    'createWorktree(repoPath, worktreePath, "task/T1", "missing-base");',
    'const branch = execFileSync("git", ["branch", "--show-current"], { cwd: worktreePath, encoding: "utf-8" }).trim();',
    'if (branch !== "task/T1") throw new Error(`unexpected branch ${branch}`);',
    'if (!fs.existsSync(path.join(worktreePath, "README.md"))) throw new Error("README.md missing from fallback worktree");',
  ].join("\n");

  const result = spawnSync(process.execPath, ["--import", "tsx", "-e", script], {
    cwd: repoRoot,
    encoding: "utf-8",
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
});
