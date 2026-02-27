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
      reviewer: "hermes",
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

  test("full lifecycle: create → auto-analysis → dispatch → review → done", async () => {
    // Create task
    const createRes = await request("POST", "/tasks", {
      title: "Lifecycle test",
      description: "Full lifecycle",
      assignee: "coder",
      reviewer: "hermes",
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
});
