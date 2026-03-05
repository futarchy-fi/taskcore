import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { OrchestrationCore } from "../../core/index.js";
import { DEFAULT_ATTEMPT_BUDGETS } from "../../core/types.js";
import type { Config } from "../config.js";
import { loadConfig } from "../config.js";
import { initJournalRepo } from "../journal.js";
import { buildPrompt } from "../prompt.js";

let core: OrchestrationCore;
let config: Config;
let tmpDir: string;

function createTask(
  taskId: string,
  initialPhase: "analysis" | "execution",
  reviewer: string | null,
): void {
  const result = core.submit({
    type: "TaskCreated",
    taskId,
    ts: Date.now(),
    title: `Task ${taskId}`,
    description: `Description for T${taskId}`,
    parentId: null,
    rootId: taskId,
    initialPhase,
    initialCondition: "ready",
    attemptBudgets: DEFAULT_ATTEMPT_BUDGETS,
    costBudget: 100,
    dependencies: [],
    reviewConfig: reviewer
      ? { required: true, attemptBudget: 2, isolationRules: [] }
      : null,
    skipAnalysis: initialPhase !== "analysis",
    metadata: {
      assignee: "coder",
      ...(reviewer ? { reviewer } : {}),
    },
    source: { type: "middle", id: "test" },
  });

  assert.equal(result.ok, true);
}

describe("prompt task CLI instructions", () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskcore-prompt-test-"));
    const dbPath = path.join(tmpDir, "test.db");
    const workspaceDir = path.join(tmpDir, "workspace");
    const journalRepoPath = path.join(tmpDir, "journal");
    const worktreeBaseDir = path.join(tmpDir, "worktrees");

    fs.mkdirSync(workspaceDir, { recursive: true });
    initJournalRepo(journalRepoPath);

    core = new OrchestrationCore({
      dbPath,
      invariantChecks: true,
      snapshotEvery: 50,
    });

    config = {
      ...loadConfig(),
      dbPath,
      workspaceDir,
      journalRepoPath,
      worktreeBaseDir,
      agentRegistry: path.join(tmpDir, "registry.json"),
      runtimeFile: "",
      lifecycleFile: "",
    };
  });

  afterEach(() => {
    core.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("analysis prompt uses task CLI commands", () => {
    createTask("1", "analysis", "overseer");

    const prompt = buildPrompt(core, "1", "work", config);
    assert.ok(prompt.includes("task decide execute"));
    assert.ok(prompt.includes("task decompose start"));
    assert.ok(prompt.includes("task block \"Why this cannot proceed\""));
    assert.ok(!prompt.includes("curl -X POST"));
  });

  test("execution prompt uses task submit when review is required", () => {
    createTask("2", "execution", "overseer");

    const prompt = buildPrompt(core, "2", "work", config);
    assert.ok(prompt.includes("task submit \"Description of what you did\""));
    assert.ok(!prompt.includes("curl -s -X POST"));
  });

  test("execution prompt uses task complete when no reviewer is configured", () => {
    createTask("3", "execution", null);

    const prompt = buildPrompt(core, "3", "work", config);
    assert.ok(prompt.includes("task complete \"Description of what you did\""));
    assert.ok(!prompt.includes("task submit \"Description of what you did\""));
  });

  test("review prompt uses task review commands", () => {
    createTask("4", "analysis", "overseer");

    const prompt = buildPrompt(core, "4", "review", config);
    assert.ok(prompt.includes("task review read"));
    assert.ok(prompt.includes("task review approve \"Why this passes\""));
    assert.ok(prompt.includes("task review request-changes \"What needs to change\""));
    assert.ok(prompt.includes("task review reject \"Fundamental issue requiring re-analysis\""));
    assert.ok(!prompt.includes("curl -X POST"));
  });
});
