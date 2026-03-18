import * as http from "node:http";
import { execFileSync } from "node:child_process";
import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OrchestrationCore } from "../../core/index.js";
import { createHttpServer } from "../http.js";
import { loadConfig, type Config } from "../config.js";
import { initJournalRepo } from "../journal.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let server: http.Server;
let core: OrchestrationCore;
let dbPath: string;
let tmpDir: string;
let port: number;
let config: Config;

function request(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: urlPath,
        method,
        headers: data
          ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf-8");
          try {
            resolve({ status: res.statusCode ?? 500, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 500, body: raw });
          }
        });
      },
    );
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function setup(): Promise<void> {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskcore-test-"));
  dbPath = path.join(tmpDir, "test.db");
  port = 0;
  const journalRepoPath = path.join(tmpDir, "journal");
  const worktreeBaseDir = path.join(tmpDir, "worktrees");
  const workspaceDir = path.join(tmpDir, "workspace");
  const agentRegistry = path.join(tmpDir, "registry.json");

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "data"), { recursive: true });
  fs.writeFileSync(agentRegistry, JSON.stringify({
    agents: [
      { id: "coder", assignable: true, reviewer: true, consulted: true },
      { id: "analyst", assignable: true, reviewer: true, consulted: true },
      { id: "overseer", assignable: true, reviewer: true, consulted: true },
      { id: "hermes", assignable: true, reviewer: true, consulted: true },
    ],
  }, null, 2));
  initJournalRepo(journalRepoPath);

  core = new OrchestrationCore({
    dbPath,
    invariantChecks: true,
    snapshotEvery: 50,
  });

  config = {
    ...loadConfig(),
    port,
    dbPath,
    agentRegistry,
    workspaceDir,
    journalRepoPath,
    worktreeBaseDir,
    runtimeFile: "",
  };

  server = createHttpServer(core, config);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("failed to bind ephemeral test port");
      }
      port = address.port;
      resolve();
    });
  });
}

async function teardown(): Promise<void> {
  server.close();
  core.close();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // Ignore
  }
}

function initRepo(repoPath: string): void {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Taskcore Tests"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "taskcore-tests@example.com"], { cwd: repoPath, stdio: "ignore" });
  fs.writeFileSync(path.join(repoPath, "README.md"), "# test\n", "utf-8");
  execFileSync("git", ["add", "README.md"], { cwd: repoPath, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("HTTP API", () => {
  beforeEach(setup);
  afterEach(teardown);

  test("GET /health returns 200", async () => {
    const res = await request("GET", "/health");
    assert.equal(res.status, 200);
    const body = res.body as Record<string, unknown>;
    assert.equal(body["status"], "ok");
    assert.equal(body["taskCount"], 0);
  });

  test("POST /tasks creates a task", async () => {
    const res = await request("POST", "/tasks", {
      title: "Test task",
      description: "A test description",
      assignee: "coder",
      reviewer: "overseer",
      priority: "high",
    });
    assert.equal(res.status, 201);
    const body = res.body as Record<string, unknown>;
    assert.equal(body["taskId"], "1");
    assert.equal(body["status"], "created");
  });

  test("GET /tasks/:id returns the task", async () => {
    await request("POST", "/tasks", {
      title: "Test task",
      description: "A test description",
      assignee: "coder",
    });

    const res = await request("GET", "/tasks/1");
    assert.equal(res.status, 200);
    const body = res.body as { task: { id: string; title: string } };
    assert.equal(body.task.id, "1");
    assert.equal(body.task.title, "Test task");
  });

  test("GET /tasks/:id returns 404 for missing task", async () => {
    const res = await request("GET", "/tasks/999");
    assert.equal(res.status, 404);
  });

  test("GET /tasks/:id/events returns events for existing task", async () => {
    await request("POST", "/tasks", {
      title: "Events task",
      description: "Task with events",
      assignee: "coder",
    });

    const leaseRes = await request("POST", "/tasks/1/events", {
      type: "LeaseGranted",
      taskId: "1",
      ts: Date.now(),
      fenceToken: 1,
      agentId: "coder",
      phase: "analysis",
      leaseTimeout: 600000,
      sessionId: "session-1",
      sessionType: "fresh",
      contextBudget: 100,
      agentContext: {
        sessionId: "session-1",
        agentId: "coder",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });
    assert.equal(leaseRes.status, 200);

    const res = await request("GET", "/tasks/1/events");
    assert.equal(res.status, 200);
    const body = res.body as { events: Array<{ type: string }> };
    assert.ok(body.events.length >= 2);
    assert.equal(body.events[0]?.type, "TaskCreated");
  });

  test("GET /tasks/:id/events returns 404 for missing task", async () => {
    const res = await request("GET", "/tasks/999/events");
    assert.equal(res.status, 404);
  });

  test("GET /tasks lists all tasks", async () => {
    await request("POST", "/tasks", { title: "T1", description: "D1" });
    await request("POST", "/tasks", { title: "T2", description: "D2" });

    const res = await request("GET", "/tasks");
    assert.equal(res.status, 200);
    const body = res.body as { tasks: unknown[] };
    assert.equal(body.tasks.length, 2);
  });

  test("GET /dispatchable lists dispatchable tasks", async () => {
    await request("POST", "/tasks", {
      title: "Ready task",
      description: "Should be dispatchable",
      assignee: "coder",
    });

    const res = await request("GET", "/dispatchable");
    assert.equal(res.status, 200);
    const body = res.body as { tasks: unknown[] };
    assert.ok(body.tasks.length > 0);
  });

  test("POST /tasks validates required fields", async () => {
    const res = await request("POST", "/tasks", { title: "" });
    assert.equal(res.status, 400);
  });

  test("404 for unknown routes", async () => {
    const res = await request("GET", "/not-a-route");
    assert.equal(res.status, 404);
  });

  test("PATCH /tasks/:id/metadata updates priority", async () => {
    await request("POST", "/tasks", {
      title: "Metadata test",
      description: "Test metadata update",
      assignee: "coder",
      priority: "low",
    });

    const res = await request("PATCH", "/tasks/1/metadata", {
      priority: "critical",
      reason: "Urgent reprioritization",
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; metadata: Record<string, unknown> };
    assert.equal(body.ok, true);
    assert.equal(body.metadata["priority"], "critical");
    assert.equal(body.metadata["assignee"], "coder"); // unchanged
  });

  test("PATCH /tasks/:id/metadata updates assignee", async () => {
    await request("POST", "/tasks", {
      title: "Reassign test",
      description: "Test assignee change",
      assignee: "coder",
    });

    const res = await request("PATCH", "/tasks/1/metadata", {
      assignee: "analyst",
      reason: "Reassigned to analyst",
    });
    assert.equal(res.status, 200);
    const body = res.body as { ok: boolean; metadata: Record<string, unknown> };
    assert.equal(body.metadata["assignee"], "analyst");
  });

  test("PATCH /tasks/:id/metadata rejects invalid priority", async () => {
    await request("POST", "/tasks", {
      title: "Bad priority test",
      description: "Invalid priority value",
    });

    const res = await request("PATCH", "/tasks/1/metadata", {
      priority: "super-urgent",
    });
    assert.equal(res.status, 422);
  });

  test("PATCH /tasks/:id/metadata returns 404 for missing task", async () => {
    const res = await request("PATCH", "/tasks/999/metadata", {
      priority: "high",
    });
    assert.equal(res.status, 404);
  });

  test("POST /tasks rejects unknown assignee", async () => {
    const res = await request("POST", "/tasks", {
      title: "Bad assignee test",
      description: "Unknown agent",
      assignee: "nonexistent-agent",
    });
    assert.equal(res.status, 422);
    const body = res.body as { error: string; message: string };
    assert.equal(body.error, "invalid_role");
    assert.ok(body.message.includes("nonexistent-agent"));
  });

  test("PATCH /tasks/:id/metadata rejects unknown assignee", async () => {
    await request("POST", "/tasks", {
      title: "Valid task",
      description: "Will try to update with bad assignee",
    });

    const res = await request("PATCH", "/tasks/1/metadata", {
      assignee: "ghost-agent",
    });
    assert.equal(res.status, 422);
    const body = res.body as { error: string };
    assert.equal(body.error, "invalid_role");
  });

  test("PATCH /tasks/:id/metadata allows null assignee (remove)", async () => {
    await request("POST", "/tasks", {
      title: "Null assignee test",
      description: "Should allow null to remove",
      assignee: "coder",
    });

    const res = await request("PATCH", "/tasks/1/metadata", {
      assignee: null,
      reason: "Unassign",
    });
    assert.equal(res.status, 200);
  });

  test("PATCH /tasks/:id/metadata rejects empty patch", async () => {
    await request("POST", "/tasks", {
      title: "Empty patch test",
      description: "No fields to update",
    });

    const res = await request("PATCH", "/tasks/1/metadata", {
      reason: "Just a reason, no changes",
    });
    assert.equal(res.status, 400);
  });

  test("full lifecycle: create → auto-analysis → dispatch → review → done", async () => {
    // Create task
    const createRes = await request("POST", "/tasks", {
      title: "Lifecycle test",
      description: "Full lifecycle",
      assignee: "coder",
      reviewer: "overseer",
      skipAnalysis: true,
    });
    assert.equal(createRes.status, 201);

    // Task should be in execution.ready (skipAnalysis=true)
    let taskRes = await request("GET", "/tasks/1");
    let task = (taskRes.body as { task: { phase: string; condition: string } }).task;
    assert.equal(task.phase, "execution");
    assert.equal(task.condition, "ready");

    // Simulate dispatch: LeaseGranted (now includes agentContext)
    const fenceToken = 1;
    const sessionId = "test-session";

    let evRes = await request("POST", "/tasks/1/events", {
      type: "LeaseGranted",
      taskId: "1",
      ts: Date.now(),
      fenceToken,
      agentId: "coder",
      phase: "execution",
      leaseTimeout: 600000,
      sessionId,
      sessionType: "fresh",
      contextBudget: 100,
      agentContext: {
        sessionId,
        agentId: "coder",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });
    assert.equal(evRes.status, 200);

    // Task should be in execution.active
    taskRes = await request("GET", "/tasks/1");
    task = (taskRes.body as { task: { phase: string; condition: string } }).task;
    assert.equal(task.phase, "execution");
    assert.equal(task.condition, "active");

    // Agent reports: review
    const reviewRes = await request("POST", "/tasks/1/status", {
      status: "review",
      evidence: "Work is done",
    });
    assert.equal(reviewRes.status, 200);

    // Task should be in review.ready
    taskRes = await request("GET", "/tasks/1");
    task = (taskRes.body as { task: { phase: string; condition: string } }).task;
    assert.equal(task.phase, "review");
    assert.equal(task.condition, "ready");

    // Simulate reviewer dispatch
    const reviewFence = 2;

    await request("POST", "/tasks/1/events", {
      type: "LeaseGranted",
      taskId: "1",
      ts: Date.now(),
      fenceToken: reviewFence,
      agentId: "hermes",
      phase: "review",
      leaseTimeout: 600000,
      sessionId: "review-session",
      sessionType: "fresh",
      contextBudget: 100,
      agentContext: {
        sessionId: "review-session",
        agentId: "hermes",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });

    // Reviewer approves: done
    const doneRes = await request("POST", "/tasks/1/status", {
      status: "done",
      evidence: "Looks good, approved",
    });
    assert.equal(doneRes.status, 200);

    // Task should be terminal: done
    taskRes = await request("GET", "/tasks/1");
    const finalTask = (taskRes.body as { task: { terminal: string | null } }).task;
    assert.equal(finalTask.terminal, "done");
  });

  test("claim creates workspace context and journal endpoints append/read", async () => {
    await request("POST", "/tasks", {
      title: "Claim workspace test",
      description: "Verify claim returns workspace and journal routes work",
      assignee: "coder",
    });

    const claimRes = await request("POST", "/tasks/1/claim", {
      agentId: "coder",
      source: "test",
    });
    assert.equal(claimRes.status, 200);
    const claimBody = claimRes.body as { workspace?: { journalPath?: string | null } };
    assert.ok(claimBody.workspace);
    assert.ok(claimBody.workspace?.journalPath);

    const writeRes = await request("POST", "/tasks/1/journal", {
      entry: "Starting implementation",
    });
    assert.equal(writeRes.status, 200);

    const readRes = await request("GET", "/tasks/1/journal");
    assert.equal(readRes.status, 200);
    const readBody = readRes.body as { content: string };
    assert.ok(readBody.content.includes("Starting implementation"));
  });

  test("claim refreshes stale .task metadata in an existing code worktree", async () => {
    const repoPath = path.join(tmpDir, "code-repo");
    initRepo(repoPath);

    await request("POST", "/tasks", {
      title: "Refresh stale context",
      description: "Existing worktree context should be overwritten on claim",
      assignee: "coder",
      repo: repoPath,
      skipAnalysis: true,
    });

    const codeWorktree = path.join(config.worktreeBaseDir, "code-T1");
    execFileSync("git", ["worktree", "add", "-b", "task/T1", codeWorktree, "main"], {
      cwd: repoPath,
      stdio: "ignore",
    });
    fs.writeFileSync(path.join(codeWorktree, ".task"), JSON.stringify({
      taskId: "2123",
      phase: "execution",
      fenceToken: 1,
      sessionId: "stale-session",
      journalPath: "/tmp/stale/",
      codeWorktree,
      claimedAt: 1,
      reviewNotes: [],
    }, null, 2) + "\n", "utf-8");

    const claimRes = await request("POST", "/tasks/1/claim", {
      agentId: "coder",
      source: "test",
    });
    assert.equal(claimRes.status, 200);

    const claimBody = claimRes.body as {
      sessionId: string;
      fenceToken: number;
      workspace?: { journalPath?: string | null; codeWorktree?: string | null };
    };
    const dotask = JSON.parse(fs.readFileSync(path.join(codeWorktree, ".task"), "utf-8")) as Record<string, unknown>;
    assert.equal(dotask["taskId"], "1");
    assert.equal(dotask["sessionId"], claimBody.sessionId);
    assert.equal(dotask["fenceToken"], claimBody.fenceToken);
    assert.equal(dotask["journalPath"], claimBody.workspace?.journalPath);
    assert.equal(dotask["codeWorktree"], claimBody.workspace?.codeWorktree);
  });

  test("status done cleans up journal and code worktrees", async () => {
    const repoPath = path.join(tmpDir, "code-repo");
    initRepo(repoPath);

    await request("POST", "/tasks", {
      title: "Cleanup worktrees",
      description: "Terminal tasks should remove their worktrees",
      assignee: "coder",
      repo: repoPath,
      skipAnalysis: true,
    });

    const claimRes = await request("POST", "/tasks/1/claim", {
      agentId: "coder",
      source: "test",
    });
    assert.equal(claimRes.status, 200);

    const claimBody = claimRes.body as {
      workspace?: {
        journalWorktree?: string | null;
        codeWorktree?: string | null;
      };
    };
    const codeWorktree = claimBody.workspace?.codeWorktree;
    const journalWorktree = claimBody.workspace?.journalWorktree;
    assert.ok(codeWorktree);
    assert.ok(journalWorktree);

    fs.writeFileSync(path.join(codeWorktree!, "feature.txt"), "done\n", "utf-8");
    execFileSync("git", ["add", "feature.txt"], { cwd: codeWorktree!, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "task work"], { cwd: codeWorktree!, stdio: "ignore" });

    const doneRes = await request("POST", "/tasks/1/status", {
      status: "done",
      evidence: "Work completed",
    });
    assert.equal(doneRes.status, 200);
    assert.equal(fs.existsSync(codeWorktree!), false);
    assert.equal(fs.existsSync(journalWorktree!), false);
  });

  test("status done completes execution task directly when no reviewer is configured", async () => {
    await request("POST", "/tasks", {
      title: "Direct completion",
      description: "No reviewer task can complete from execution",
      assignee: "coder",
      skipAnalysis: true,
    });

    await request("POST", "/tasks/1/events", {
      type: "LeaseGranted",
      taskId: "1",
      ts: Date.now(),
      fenceToken: 1,
      agentId: "coder",
      phase: "execution",
      leaseTimeout: 600000,
      sessionId: "s-direct",
      sessionType: "fresh",
      contextBudget: 100,
      agentContext: {
        sessionId: "s-direct",
        agentId: "coder",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });

    const doneRes = await request("POST", "/tasks/1/status", {
      status: "done",
      evidence: "Execution work complete",
    });
    assert.equal(doneRes.status, 200);

    const taskRes = await request("GET", "/tasks/1");
    const task = (taskRes.body as { task: { terminal: string | null } }).task;
    assert.equal(task.terminal, "done");
  });

  test("decompose cancel clears pending incremental session", async () => {
    await request("POST", "/tasks", {
      title: "Cancel decompose",
      description: "Check decompose cancel endpoint",
      assignee: "coder",
    });

    await request("POST", "/tasks/1/claim", {
      agentId: "coder",
      source: "test",
    });

    const startRes = await request("POST", "/tasks/1/decompose/start");
    assert.equal(startRes.status, 200);

    const cancelRes = await request("POST", "/tasks/1/decompose/cancel");
    assert.equal(cancelRes.status, 200);
    const cancelBody = cancelRes.body as { canceled: boolean };
    assert.equal(cancelBody.canceled, true);
  });
});
