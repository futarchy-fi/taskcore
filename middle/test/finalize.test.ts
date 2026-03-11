import { execFileSync } from "node:child_process";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, test } from "node:test";
import type { Task } from "../../core/types.js";
import { verifyArtifacts } from "../finalize.js";
import type { Config } from "../config.js";

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyArtifacts accepts declared output files for default-repo tasks without a task branch", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
  tempDirs.push(tmpDir);

  const repoPath = path.join(tmpDir, "workspace");
  fs.mkdirSync(repoPath, { recursive: true });
  initRepo(repoPath);

  const outputPath = path.join(tmpDir, "deliverable.json");
  fs.writeFileSync(outputPath, "{\"ok\":true}\n", "utf-8");

  const task = makeTask({
    id: "844",
    description: `Salvar resultado em \`${outputPath}\`.`,
  });
  const config = makeConfig(tmpDir, repoPath);

  const verification = verifyArtifacts(task, config);

  assert.equal(verification.passed, true);
  assert.match(verification.reason, /declared deliverable file/i);
  assert.equal(verification.evidence.some((entry) => entry.kind === "file" && entry.path === outputPath), true);
});

test("verifyArtifacts passes coordinator tasks (with children) without requiring a task branch or commits", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
  tempDirs.push(tmpDir);

  const repoPath = path.join(tmpDir, "workspace");
  fs.mkdirSync(repoPath, { recursive: true });
  initRepo(repoPath);

  const task = makeTask({
    id: "200",
    children: ["100", "101"],
    metadata: { repo: repoPath },
  });
  const config = makeConfig(tmpDir, repoPath);

  const verification = verifyArtifacts(task, config);

  assert.equal(verification.passed, true);
  assert.match(verification.reason, /Coordinator task with 2 children/);
  assert.match(verification.reason, /delegated to children/);
});

test("verifyArtifacts keeps explicit repo tasks strict when the task branch is missing", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "finalize-test-"));
  tempDirs.push(tmpDir);

  const repoPath = path.join(tmpDir, "workspace");
  fs.mkdirSync(repoPath, { recursive: true });
  initRepo(repoPath);

  const outputPath = path.join(tmpDir, "deliverable.md");
  fs.writeFileSync(outputPath, "# result\n", "utf-8");

  const task = makeTask({
    id: "1303",
    description: `Output file: \`${outputPath}\``,
    metadata: { repo: repoPath },
  });
  const config = makeConfig(tmpDir, repoPath);

  const verification = verifyArtifacts(task, config);

  assert.equal(verification.passed, false);
  assert.match(verification.reason, /does not exist/i);
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "1",
    title: "Test task",
    description: "Test description",
    parentId: null,
    rootId: "1",
    phase: "review",
    condition: "active",
    terminal: null,
    currentFenceToken: 1,
    leasedTo: null,
    leaseExpiresAt: null,
    retryAfter: null,
    lastAgentExitAt: null,
    attempts: {
      analysis: { used: 0, max: 4 },
      decomposition: { used: 0, max: 3 },
      execution: { used: 0, max: 8 },
      review: { used: 0, max: 6 },
    },
    cost: {
      allocated: 100,
      consumed: 0,
      childAllocated: 0,
      childRecovered: 0,
    },
    decompositionVersion: 0,
    children: [],
    checkpoints: [],
    costRecoveredToParent: false,
    triggeredCheckpoints: [],
    completionRule: "and",
    dependencies: [],
    approachHistory: [],
    failureSummaries: [],
    failureDigestVersion: 0,
    terminalSummary: null,
    stateRef: null,
    checkpointRefs: [],
    reviewConfig: null,
    reviewState: null,
    sessionPolicy: "fresh",
    currentSessionId: null,
    contextIsolation: [],
    contextBudget: 200,
    waitState: null,
    coordination: null,
    lastCompletionVerification: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    metadata: {},
    ...overrides,
  };
}

function makeConfig(tmpDir: string, defaultCodeRepo: string): Config {
  return {
    port: 18800,
    dbPath: path.join(tmpDir, "taskcore.db"),
    eventLogDir: path.join(tmpDir, "events"),
    persistenceBackend: "jsonl",
    agentRegistry: path.join(tmpDir, "registry.json"),
    workspaceDir: tmpDir,
    tickIntervalMs: 2_000,
    leaseTimeoutMs: 600_000,
    lockFile: path.join(tmpDir, "taskcore.lock"),
    runtimeFile: path.join(tmpDir, "runtime.json"),
    defaultCostBudget: 100,
    defaultContextBudget: 200,
    defaultAttemptBudgets: {
      analysis: { max: 4 },
      decomposition: { max: 3 },
      execution: { max: 8 },
      review: { max: 6 },
    },
    disallowedAgent: "hermes",
    disallowedAgentFallback: "overseer",
    journalRepoPath: path.join(tmpDir, "journal"),
    worktreeBaseDir: path.join(tmpDir, "worktrees"),
    defaultCodeRepo,
  };
}

function initRepo(repoPath: string): void {
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Taskcore Tests"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "taskcore-tests@example.com"], { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });
}
