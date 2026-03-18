import * as http from "node:http";
import { spawnSync } from "node:child_process";
import { beforeEach, afterEach, test } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { OrchestrationCore } from "../index.js";
import { createHttpServer } from "../../middle/http.js";
import { loadConfig, type Config } from "../../middle/config.js";
import { initJournalRepo } from "../../middle/journal.js";

let server: http.Server;
let core: OrchestrationCore;
let tmpDir: string;
let port: number;
let config: Config;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

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
          ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          }
          : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "taskcore-cli-plan-"));
  const dbPath = path.join(tmpDir, "test.db");
  port = 19800 + Math.floor(Math.random() * 1000);
  const journalRepoPath = path.join(tmpDir, "journal");
  const worktreeBaseDir = path.join(tmpDir, "worktrees");
  const workspaceDir = path.join(tmpDir, "workspace");
  const agentRegistry = path.join(tmpDir, "registry.json");

  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(path.join(workspaceDir, "data"), { recursive: true });
  fs.writeFileSync(agentRegistry, JSON.stringify({
    agents: [
      { id: "coder", assignable: true, reviewer: true, consulted: true },
      { id: "overseer", assignable: true, reviewer: true, consulted: true },
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
    server.listen(port, "127.0.0.1", resolve);
  });
}

async function teardown(): Promise<void> {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  core.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

beforeEach(setup);
afterEach(teardown);

test("task plan materializes a markdown checklist into child tasks end-to-end", async () => {
  const createRes = await request("POST", "/tasks", {
    title: "Plan import parent",
    description: "Verify task plan end-to-end",
    assignee: "coder",
    costBudget: 25,
  });
  assert.equal(createRes.status, 201);

  const claimRes = await request("POST", "/tasks/1/claim", {
    agentId: "coder",
    source: "test",
  });
  assert.equal(claimRes.status, 200);

  const planPath = path.join(tmpDir, "plan.md");
  fs.writeFileSync(planPath, [
    "# Planning",
    "- [ ] Parse markdown checklist (cost: 5, assignee: coder)",
    "  Capture headings and metadata.",
    "- [ ] Materialize children (reviewer: overseer)",
    "  Verify the parent/child shape in taskcore/dashboard.",
  ].join("\n"));

  const cli = spawnSync(
    process.execPath,
    ["--import", "tsx", "core/cli/task.ts", "plan", "--file", planPath],
    {
      cwd: repoRoot,
      env: {
        ...process.env,
        ORCHESTRATOR_PORT: String(port),
        TASKCORE_AGENT_ID: "coder",
        TASK_ID: "1",
      },
      encoding: "utf-8",
    },
  );

  assert.equal(cli.status, 0, `stdout:\n${cli.stdout}\n\nstderr:\n${cli.stderr}`);
  assert.match(cli.stdout, /Plan materialized for T1/);
  assert.match(cli.stdout, /Created 2 child tasks/);

  const parentRes = await request("GET", "/tasks/1");
  assert.equal(parentRes.status, 200);
  const parent = (parentRes.body as {
    task: {
      phase: string;
      condition: string;
      children: string[];
      coordination?: { mode?: string };
    };
  }).task;

  assert.equal(parent.phase, "analysis");
  assert.equal(parent.condition, "waiting");
  assert.deepEqual(parent.children, ["2", "3"]);
  assert.equal(parent.coordination?.mode, "sequential_children");

  const childrenRes = await request("GET", "/tasks?parentId=1&full=true");
  assert.equal(childrenRes.status, 200);
  const children = (childrenRes.body as {
    tasks: Array<{
      id: string;
      title: string;
      description: string;
      phase: string;
      condition: string;
      metadata: { assignee?: string; reviewer?: string };
      cost: { allocated: number };
    }>;
  }).tasks;

  assert.equal(children.length, 2);
  assert.deepEqual(
    children.map((child) => ({
      id: child.id,
      title: child.title,
      description: child.description,
      phase: child.phase,
      condition: child.condition,
      assignee: child.metadata.assignee,
      reviewer: child.metadata.reviewer,
      allocated: child.cost.allocated,
    })),
    [
      {
        id: "2",
        title: "Planning: Parse markdown checklist",
        description: "Capture headings and metadata.",
        phase: "analysis",
        condition: "ready",
        assignee: "coder",
        reviewer: undefined,
        allocated: 5,
      },
      {
        id: "3",
        title: "Planning: Materialize children",
        description: "Verify the parent/child shape in taskcore/dashboard.",
        phase: "analysis",
        condition: "waiting",
        assignee: undefined,
        reviewer: "overseer",
        allocated: 20,
      },
    ],
  );
});
