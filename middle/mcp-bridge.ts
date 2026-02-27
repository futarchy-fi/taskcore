#!/usr/bin/env node
/**
 * MCP Bridge — stdio JSON-RPC 2.0 server that forwards tool calls to the
 * taskcore daemon HTTP API.
 *
 * Same tool interface as openclaw-mcp-server.mjs so agents can use it as a
 * drop-in replacement.
 *
 * Usage:
 *   node --import tsx middle/mcp-bridge.ts
 *
 * Environment:
 *   ORCHESTRATOR_PORT (default 18800)
 *   TASK_ID           (optional, pre-set task context for update_status)
 */

import * as http from "node:http";
import * as readline from "node:readline";

const PORT = parseInt(process.env["ORCHESTRATOR_PORT"] ?? "18800", 10);
const BASE = `http://127.0.0.1:${PORT}`;
const CONTEXT_TASK_ID = process.env["TASK_ID"] ?? null;

// ---------------------------------------------------------------------------
// HTTP client helper
// ---------------------------------------------------------------------------

function httpRequest(
  method: string,
  urlPath: string,
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const data = body ? JSON.stringify(body) : undefined;

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
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

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: "delegate",
    description:
      "Create a tracked task and optionally assign it for automatic dispatch.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short title for the task" },
        task: { type: "string", description: "Detailed task description" },
        assignee: {
          type: "string",
          description: "Agent to assign (coder, analyst, coder-lite, orchestrator, etc.)",
        },
        priority: {
          type: "string",
          enum: ["backlog", "low", "medium", "high", "critical"],
          default: "medium",
        },
        reviewer: { type: "string", description: "Agent or role that reviews work" },
        consulted: { type: "string", description: "Agent to ask if blocked" },
        parentTaskId: {
          type: "string",
          description: "Optional parent task ID",
        },
      },
      required: ["title", "task"],
    },
  },
  {
    name: "update_status",
    description: "Update the status of a task (report work complete, blocked, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        taskId: {
          type: "string",
          description: "Task ID to update (defaults to TASK_ID env var)",
        },
        status: {
          type: "string",
          enum: ["review", "done", "blocked", "pending", "execute"],
          description: "New status",
        },
        evidence: { type: "string", description: "Evidence or notes" },
        blocker: { type: "string", description: "Blocker description (if blocked)" },
      },
      required: ["status"],
    },
  },
  {
    name: "report_incident",
    description: "Report an incident (error, timeout, unexpected behavior, etc.)",
    inputSchema: {
      type: "object",
      properties: {
        severity: {
          type: "string",
          enum: ["critical", "error", "warning", "info"],
        },
        category: { type: "string", description: "Incident category" },
        summary: { type: "string", description: "Short description" },
        detail: { type: "string", description: "Extended description" },
        tags: { type: "array", items: { type: "string" } },
      },
      required: ["severity", "category", "summary"],
    },
  },
];

// ---------------------------------------------------------------------------
// Tool handlers
// ---------------------------------------------------------------------------

async function handleDelegate(args: Record<string, unknown>): Promise<unknown> {
  const body = {
    title: args["title"] as string,
    description: args["task"] as string,
    assignee: args["assignee"] ?? null,
    reviewer: args["reviewer"] ?? null,
    consulted: args["consulted"] ?? null,
    priority: args["priority"] ?? "medium",
    parentId: args["parentTaskId"] ? String(args["parentTaskId"]) : null,
  };

  const res = await httpRequest("POST", "/tasks", body);
  return res.body;
}

async function handleUpdateStatus(args: Record<string, unknown>): Promise<unknown> {
  const taskId = (args["taskId"] as string) ?? CONTEXT_TASK_ID;
  if (!taskId) {
    return { error: "no_task_id", message: "taskId required (or set TASK_ID env var)" };
  }

  const body = {
    status: args["status"],
    evidence: args["evidence"] ?? undefined,
    blocker: args["blocker"] ?? undefined,
  };

  const res = await httpRequest("POST", `/tasks/${taskId}/status`, body);
  return res.body;
}

async function handleReportIncident(args: Record<string, unknown>): Promise<unknown> {
  // Incidents are written locally (same as old system) since the daemon
  // doesn't have an incident endpoint yet. For now, write to JSONL.
  const fs = await import("node:fs");
  const path = await import("node:path");

  const workspaceDir = process.env["WORKSPACE_DIR"] ??
    process.env["OPENCLAW_STATE_DIR"] ??
    `${process.env["HOME"]}/.openclaw/workspace`;

  const date = new Date().toISOString().slice(0, 10);
  const incidentDir = path.join(workspaceDir, "data", "incidents");

  if (!fs.existsSync(incidentDir)) {
    fs.mkdirSync(incidentDir, { recursive: true });
  }

  const incidentId = `INC-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const incident = {
    id: incidentId,
    ts: new Date().toISOString(),
    severity: args["severity"],
    category: args["category"],
    summary: args["summary"],
    detail: args["detail"] ?? null,
    tags: args["tags"] ?? [],
    source: "mcp-bridge",
  };

  const filePath = path.join(incidentDir, `${date}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(incident) + "\n");

  return { incident_id: incidentId, status: "recorded" };
}

// ---------------------------------------------------------------------------
// JSON-RPC 2.0 server
// ---------------------------------------------------------------------------

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: unknown;
}

function send(obj: unknown): void {
  process.stdout.write(JSON.stringify(obj) + "\n");
}

function sendResult(id: number | string, result: unknown): void {
  send({ jsonrpc: "2.0", id, result });
}

function sendError(id: number | string, code: number, message: string): void {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

async function handleMessage(msg: JsonRpcRequest): Promise<void> {
  const { id, method, params } = msg;

  switch (method) {
    case "initialize": {
      sendResult(id, {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "taskcore-mcp-bridge", version: "0.1.0" },
      });
      return;
    }

    case "tools/list": {
      sendResult(id, { tools: TOOLS });
      return;
    }

    case "tools/call": {
      const p = params as { name: string; arguments: Record<string, unknown> };
      const toolName = p.name;
      const args = p.arguments ?? {};

      let result: unknown;
      try {
        switch (toolName) {
          case "delegate":
            result = await handleDelegate(args);
            break;
          case "update_status":
            result = await handleUpdateStatus(args);
            break;
          case "report_incident":
            result = await handleReportIncident(args);
            break;
          default:
            sendError(id, -32601, `Unknown tool: ${toolName}`);
            return;
        }
        sendResult(id, {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        sendResult(id, {
          content: [{ type: "text", text: `Error: ${message}` }],
          isError: true,
        });
      }
      return;
    }

    case "notifications/initialized": {
      // No response needed for notifications
      return;
    }

    default: {
      if (id !== undefined) {
        sendError(id, -32601, `Method not found: ${method}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

const rl = readline.createInterface({ input: process.stdin });

rl.on("line", (line) => {
  try {
    const msg = JSON.parse(line) as JsonRpcRequest;
    handleMessage(msg).catch((err) => {
      console.error("[mcp-bridge] Error:", err);
      if (msg.id !== undefined) {
        sendError(msg.id, -32603, String(err));
      }
    });
  } catch {
    // Malformed JSON — ignore
  }
});

rl.on("close", () => {
  process.exit(0);
});
