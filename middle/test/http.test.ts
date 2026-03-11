import * as http from "node:http";
import { test, describe, beforeEach, afterEach } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { OrchestrationCore } from "../../core/index.js";
import { createHttpServer } from "../http.js";
import { loadConfig, type Config } from "../config.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

let server: http.Server;
let core: OrchestrationCore;
let dbPath: string;
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
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskcore-test-"));
  dbPath = path.join(tmpDir, "test.db");
  port = 18800 + Math.floor(Math.random() * 1000);

  core = new OrchestrationCore({
    dbPath,
    invariantChecks: true,
    snapshotEvery: 50,
  });

  config = {
    ...loadConfig(),
    port,
    dbPath,
    runtimeFile: "",
    lifecycleFile: "",
  };

  server = createHttpServer(core, config);
  await new Promise<void>((resolve) => {
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function teardown(): Promise<void> {
  server.close();
  core.close();
  try {
    fs.unlinkSync(dbPath);
  } catch {
    // Ignore
  }
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

    // Simulate dispatch: LeaseGranted + AgentStarted
    const fenceToken = 1;
    const sessionId = "test-session";
    const agentCtx = {
      sessionId,
      agentId: "coder",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    };

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
    });
    assert.equal(evRes.status, 200);

    evRes = await request("POST", "/tasks/1/events", {
      type: "AgentStarted",
      taskId: "1",
      ts: Date.now(),
      fenceToken,
      agentContext: agentCtx,
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
    const reviewCtx = {
      sessionId: "review-session",
      agentId: "hermes",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    };

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
    });

    await request("POST", "/tasks/1/events", {
      type: "AgentStarted",
      taskId: "1",
      ts: Date.now(),
      fenceToken: reviewFence,
      agentContext: reviewCtx,
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

  // ---------------------------------------------------------------------------
  // verifyCompletion tests
  // ---------------------------------------------------------------------------

  /** Bring a task into review.active so we can test the done transition. */
  async function bringToReviewActive(taskId: string): Promise<void> {
    const fenceToken = 1;
    const sessionId = "test-session";
    const agentCtx = {
      sessionId,
      agentId: "coder",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    };

    await request("POST", `/tasks/${taskId}/events`, {
      type: "LeaseGranted",
      taskId,
      ts: Date.now(),
      fenceToken,
      agentId: "coder",
      phase: "execution",
      leaseTimeout: 600000,
      sessionId,
      sessionType: "fresh",
      contextBudget: 100,
    });

    await request("POST", `/tasks/${taskId}/events`, {
      type: "AgentStarted",
      taskId,
      ts: Date.now(),
      fenceToken,
      agentContext: agentCtx,
    });

    // Push to review.ready
    await request("POST", `/tasks/${taskId}/status`, {
      status: "review",
      evidence: "Work is done",
    });

    // Simulate reviewer taking the lease
    const reviewFence = 2;
    const reviewCtx = {
      sessionId: "review-session",
      agentId: "hermes",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    };

    await request("POST", `/tasks/${taskId}/events`, {
      type: "LeaseGranted",
      taskId,
      ts: Date.now(),
      fenceToken: reviewFence,
      agentId: "hermes",
      phase: "review",
      leaseTimeout: 600000,
      sessionId: "review-session",
      sessionType: "fresh",
      contextBudget: 100,
    });

    await request("POST", `/tasks/${taskId}/events`, {
      type: "AgentStarted",
      taskId,
      ts: Date.now(),
      fenceToken: reviewFence,
      agentContext: reviewCtx,
    });
  }

  test("verifyCompletion: rejects done from review.ready before reviewer lease starts", async () => {
    const createRes = await request("POST", "/tasks", {
      title: "Review ready task",
      description: "Should not complete before review starts",
      assignee: "coder",
      reviewer: "overseer",
      skipAnalysis: true,
    });
    const taskId = (createRes.body as Record<string, unknown>)["taskId"] as string;

    const fenceToken = 1;
    const sessionId = "test-session";
    const agentCtx = {
      sessionId,
      agentId: "coder",
      memoryRef: null,
      contextTokens: null,
      modelId: "test",
    };

    await request("POST", `/tasks/${taskId}/events`, {
      type: "LeaseGranted",
      taskId,
      ts: Date.now(),
      fenceToken,
      agentId: "coder",
      phase: "execution",
      leaseTimeout: 600000,
      sessionId,
      sessionType: "fresh",
      contextBudget: 100,
    });

    await request("POST", `/tasks/${taskId}/events`, {
      type: "AgentStarted",
      taskId,
      ts: Date.now(),
      fenceToken,
      agentContext: agentCtx,
    });

    await request("POST", `/tasks/${taskId}/status`, {
      status: "review",
      evidence: "Ready for review",
    });

    const doneRes = await request("POST", `/tasks/${taskId}/status`, {
      status: "done",
      evidence: "Trying to skip reviewer lease",
    });
    assert.equal(doneRes.status, 409);
    const body = doneRes.body as Record<string, unknown>;
    assert.equal(body["error"], "invalid_state");

    const taskRes = await request("GET", `/tasks/${taskId}`);
    const task = (taskRes.body as { task: { phase: string; condition: string; terminal: string | null } }).task;
    assert.equal(task.phase, "review");
    assert.equal(task.condition, "ready");
    assert.equal(task.terminal, null);
  });

  test("verifyCompletion: rejects done when metadata.repo is set but stateRef is missing", async () => {
    // Create task, then set metadata.repo via PATCH
    const createRes = await request("POST", "/tasks", {
      title: "Repo task",
      description: "Task with repo in metadata",
      assignee: "coder",
      reviewer: "overseer",
      skipAnalysis: true,
    });
    const taskId = (createRes.body as Record<string, unknown>)["taskId"] as string;
    await request("PATCH", `/tasks/${taskId}/metadata`, { repo: "my-org/my-repo" });

    await bringToReviewActive(taskId);

    // Attempt done without stateRef — should get 422
    const doneRes = await request("POST", `/tasks/${taskId}/status`, {
      status: "done",
      evidence: "Looks good",
      // no stateRef
    });
    assert.equal(doneRes.status, 422);
    const body = doneRes.body as Record<string, unknown>;
    assert.equal(body["error"], "missing_state_ref");
  });

  test("verifyCompletion: rejects done when metadata.repo is set and stateRef is zeroed", async () => {
    const createRes = await request("POST", "/tasks", {
      title: "Repo task zeroed",
      description: "Task with repo and zeroed stateRef",
      assignee: "coder",
      reviewer: "overseer",
      skipAnalysis: true,
    });
    const taskId = (createRes.body as Record<string, unknown>)["taskId"] as string;
    await request("PATCH", `/tasks/${taskId}/metadata`, { repo: "my-org/my-repo" });

    await bringToReviewActive(taskId);

    // Attempt done with zeroed stateRef — should get 422
    const doneRes = await request("POST", `/tasks/${taskId}/status`, {
      status: "done",
      evidence: "Looks good",
      stateRef: { branch: "main", commit: "0000000", parentCommit: "0000000" },
    });
    assert.equal(doneRes.status, 422);
    const body = doneRes.body as Record<string, unknown>;
    assert.equal(body["error"], "missing_state_ref");
  });

  test("verifyCompletion: rejects done when children with completionRule='and' are not all done", async () => {
    // Create a dummy first task (skipAnalysis) to consume an ID, then the real parent
    const dummyRes = await request("POST", "/tasks", {
      title: "Parent task",
      description: "Will be decomposed",
      assignee: "coder",
      reviewer: "overseer",
      skipAnalysis: true,
    });
    const dummyId = (dummyRes.body as Record<string, unknown>)["taskId"] as string;

    // Bring dummy through lifecycle so it doesn't interfere
    await request("POST", `/tasks/${dummyId}/events`, {
      type: "LeaseGranted",
      taskId: dummyId,
      ts: Date.now(),
      fenceToken: 1,
      agentId: "coder",
      phase: "execution",
      leaseTimeout: 600000,
      sessionId: "test-session",
      sessionType: "fresh",
      contextBudget: 100,
    });

    await request("POST", `/tasks/${dummyId}/events`, {
      type: "AgentStarted",
      taskId: dummyId,
      ts: Date.now(),
      fenceToken: 1,
      agentContext: {
        sessionId: "test-session",
        agentId: "coder",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });

    // Submit review to move to review.ready
    await request("POST", `/tasks/${dummyId}/status`, {
      status: "review",
      evidence: "Work done",
    });

    // Reviewer lease + start
    await request("POST", `/tasks/${dummyId}/events`, {
      type: "LeaseGranted",
      taskId: dummyId,
      ts: Date.now(),
      fenceToken: 2,
      agentId: "hermes",
      phase: "review",
      leaseTimeout: 600000,
      sessionId: "review-session",
      sessionType: "fresh",
      contextBudget: 100,
    });
    await request("POST", `/tasks/${dummyId}/events`, {
      type: "AgentStarted",
      taskId: dummyId,
      ts: Date.now(),
      fenceToken: 2,
      agentContext: {
        sessionId: "review-session",
        agentId: "hermes",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });

    // Send changes_requested to get back to execution
    await request("POST", `/tasks/${dummyId}/status`, {
      status: "pending",
      evidence: "Need to decompose instead",
    });

    // Create the real decomposable parent (without skipAnalysis)
    const parentRes = await request("POST", "/tasks", {
      title: "Decomposable parent",
      description: "This one will be decomposed",
      assignee: "coder",
      reviewer: "overseer",
    });
    const parentId = (parentRes.body as Record<string, unknown>)["taskId"] as string;

    // Parent is in analysis.ready. Lease and start it.
    await request("POST", `/tasks/${parentId}/events`, {
      type: "LeaseGranted",
      taskId: parentId,
      ts: Date.now(),
      fenceToken: 1,
      agentId: "coder",
      phase: "analysis",
      leaseTimeout: 600000,
      sessionId: "test-session-2",
      sessionType: "fresh",
      contextBudget: 100,
    });
    await request("POST", `/tasks/${parentId}/events`, {
      type: "AgentStarted",
      taskId: parentId,
      ts: Date.now(),
      fenceToken: 1,
      agentContext: {
        sessionId: "test-session-2",
        agentId: "coder",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });

    // Decompose parent into two children
    const decompRes = await request("POST", `/tasks/${parentId}/decompose`, {
      approach: "Split into two subtasks",
      children: [
        { title: "Child A", description: "First child", costAllocation: 30 },
        { title: "Child B", description: "Second child", costAllocation: 30 },
      ],
    });
    assert.equal(decompRes.status, 200);
    const decompBody = decompRes.body as { children: Array<{ id: string }> };
    const childAId = decompBody.children[0]!.id;
    const childBId = decompBody.children[1]!.id;

    // Complete child A only (leave child B incomplete)
    // Child A: analysis.ready → lease → start → exec → review → done
    await request("POST", `/tasks/${childAId}/events`, {
      type: "LeaseGranted",
      taskId: childAId,
      ts: Date.now(),
      fenceToken: 1,
      agentId: "coder",
      phase: "analysis",
      leaseTimeout: 600000,
      sessionId: "child-session",
      sessionType: "fresh",
      contextBudget: 100,
    });
    await request("POST", `/tasks/${childAId}/events`, {
      type: "AgentStarted",
      taskId: childAId,
      ts: Date.now(),
      fenceToken: 1,
      agentContext: {
        sessionId: "child-session",
        agentId: "coder",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });
    // Skip to execution
    await request("POST", `/tasks/${childAId}/status`, { status: "execute" });
    await request("POST", `/tasks/${childAId}/events`, {
      type: "LeaseGranted",
      taskId: childAId,
      ts: Date.now(),
      fenceToken: 2,
      agentId: "coder",
      phase: "execution",
      leaseTimeout: 600000,
      sessionId: "child-session-2",
      sessionType: "fresh",
      contextBudget: 100,
    });
    await request("POST", `/tasks/${childAId}/events`, {
      type: "AgentStarted",
      taskId: childAId,
      ts: Date.now(),
      fenceToken: 2,
      agentContext: {
        sessionId: "child-session-2",
        agentId: "coder",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });
    await request("POST", `/tasks/${childAId}/status`, {
      status: "review",
      evidence: "Child A done",
    });
    await request("POST", `/tasks/${childAId}/events`, {
      type: "LeaseGranted",
      taskId: childAId,
      ts: Date.now(),
      fenceToken: 3,
      agentId: "hermes",
      phase: "review",
      leaseTimeout: 600000,
      sessionId: "child-review",
      sessionType: "fresh",
      contextBudget: 100,
    });
    await request("POST", `/tasks/${childAId}/events`, {
      type: "AgentStarted",
      taskId: childAId,
      ts: Date.now(),
      fenceToken: 3,
      agentContext: {
        sessionId: "child-review",
        agentId: "hermes",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });
    const childADone = await request("POST", `/tasks/${childAId}/status`, {
      status: "done",
      evidence: "Approved",
    });
    assert.equal(childADone.status, 200);

    // Parent should now be in review.waiting (children not all done).
    let parentCheck = await request("GET", `/tasks/${parentId}`);
    let parentTask = (parentCheck.body as { task: { phase: string; condition: string } }).task;
    assert.equal(parentTask.phase, "review");
    assert.equal(parentTask.condition, "waiting");

    // Force the parent into review.active by granting lease
    await request("POST", `/tasks/${parentId}/events`, {
      type: "LeaseGranted",
      taskId: parentId,
      ts: Date.now(),
      fenceToken: 3,
      agentId: "hermes",
      phase: "review",
      leaseTimeout: 600000,
      sessionId: "parent-review",
      sessionType: "fresh",
      contextBudget: 100,
    });
    await request("POST", `/tasks/${parentId}/events`, {
      type: "AgentStarted",
      taskId: parentId,
      ts: Date.now(),
      fenceToken: 3,
      agentContext: {
        sessionId: "parent-review",
        agentId: "hermes",
        memoryRef: null,
        contextTokens: null,
        modelId: "test",
      },
    });

    // Attempt to mark parent done — should be rejected because child B is not done
    const parentDoneRes = await request("POST", `/tasks/${parentId}/status`, {
      status: "done",
      evidence: "Trying to complete parent",
    });
    assert.equal(parentDoneRes.status, 422);
    const parentDoneBody = parentDoneRes.body as Record<string, unknown>;
    assert.equal(parentDoneBody["error"], "children_not_done");
    assert.ok((parentDoneBody["message"] as string).includes(childBId));
  });

  test("verifyCompletion: missing proof is recoverable with a later valid retry", async () => {
    const createRes = await request("POST", "/tasks", {
      title: "Recoverable repo task",
      description: "Task can retry done after supplying proof",
      assignee: "coder",
      reviewer: "overseer",
      skipAnalysis: true,
    });
    const taskId = (createRes.body as Record<string, unknown>)["taskId"] as string;
    await request("PATCH", `/tasks/${taskId}/metadata`, { repo: "my-org/my-repo" });

    await bringToReviewActive(taskId);

    const firstDoneRes = await request("POST", `/tasks/${taskId}/status`, {
      status: "done",
      evidence: "First attempt without proof",
    });
    assert.equal(firstDoneRes.status, 422);
    const firstBody = firstDoneRes.body as Record<string, unknown>;
    assert.equal(firstBody["error"], "missing_state_ref");

    let taskRes = await request("GET", `/tasks/${taskId}`);
    let task = (taskRes.body as { task: { phase: string; condition: string; terminal: string | null } }).task;
    assert.equal(task.phase, "review");
    assert.equal(task.condition, "active");
    assert.equal(task.terminal, null);

    const retryDoneRes = await request("POST", `/tasks/${taskId}/status`, {
      status: "done",
      evidence: "Second attempt with proof",
      stateRef: { branch: `task/T${taskId}`, commit: "abc1234", parentCommit: "def5678" },
    });
    assert.equal(retryDoneRes.status, 200);

    taskRes = await request("GET", `/tasks/${taskId}`);
    task = (taskRes.body as { task: { phase: string; condition: string; terminal: string | null; stateRef?: { commit: string } } }).task;
    assert.equal(task.terminal, "done");
    assert.equal(task.stateRef?.commit, "abc1234");
  });

  test("verifyCompletion: happy path — metadata.repo with valid stateRef succeeds", async () => {
    const createRes = await request("POST", "/tasks", {
      title: "Repo task happy",
      description: "Task with repo and real stateRef",
      assignee: "coder",
      reviewer: "overseer",
      skipAnalysis: true,
    });
    const taskId = (createRes.body as Record<string, unknown>)["taskId"] as string;
    await request("PATCH", `/tasks/${taskId}/metadata`, { repo: "my-org/my-repo" });

    await bringToReviewActive(taskId);

    // Attempt done with a real stateRef — should succeed
    const doneRes = await request("POST", `/tasks/${taskId}/status`, {
      status: "done",
      evidence: "Looks good",
      stateRef: { branch: `task/T${taskId}`, commit: "abc1234", parentCommit: "def5678" },
    });
    assert.equal(doneRes.status, 200);
    const body = doneRes.body as Record<string, unknown>;
    assert.equal(body["ok"], true);
  });
});
