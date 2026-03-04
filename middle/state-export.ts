import * as fs from "node:fs";
import * as path from "node:path";
import type { Core } from "../core/index.js";
import type { Task } from "../core/types.js";
import type { Config } from "./config.js";

// ---------------------------------------------------------------------------
// Status mapping: taskcore → dashboard
// ---------------------------------------------------------------------------

function mapStatus(task: Task): string {
  if (task.terminal === "done") return "done";
  if (task.terminal === "blocked") return "blocked";
  if (task.terminal === "failed") return "blocked";
  if (task.terminal === "canceled") return "done";
  if (task.phase === "review") return "review";
  if (task.phase === "execution" && task.condition === "active") return "in-progress";
  if (task.phase === "execution" && task.condition !== "active") return "pending";
  if (task.phase === "analysis") return "pending";
  return "pending";
}

// ---------------------------------------------------------------------------
// Runtime file merge
// ---------------------------------------------------------------------------

interface ActiveRunEntry {
  taskId: string;
  agentId: string;
  phase: string;
  startedAt: string;
  elapsedMs: number;
}

interface RuntimeData {
  activeRuns?: ActiveRunEntry[];
}

function loadRuntimeData(runtimeFile: string): RuntimeData {
  try {
    const raw = fs.readFileSync(runtimeFile, "utf-8");
    return JSON.parse(raw) as RuntimeData;
  } catch {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export function exportState(core: Core, config: Config): void {
  const state = core.getState();
  const runtime = loadRuntimeData(config.runtimeFile);
  const activeByTaskId = new Map<string, ActiveRunEntry>();

  if (runtime.activeRuns) {
    for (const run of runtime.activeRuns) {
      activeByTaskId.set(run.taskId, run);
    }
  }

  const tasks = Object.values(state.tasks).map((task) => {
    const activeRun = activeByTaskId.get(task.id);

    return {
      id: parseInt(task.id, 10) || 0,
      title: task.title,
      status: mapStatus(task),
      priority: (task.metadata["priority"] as string | undefined) ?? "medium",
      assignee: (task.metadata["assignee"] as string | undefined) ?? null,
      reviewer: (task.metadata["reviewer"] as string | undefined) ?? null,
      description: task.description,
      evidence: (task.metadata["evidence"] as string | undefined) ?? "",
      parentId: task.parentId !== null ? (parseInt(task.parentId, 10) || null) : null,
      subtasks: task.children.map((c) => parseInt(c, 10) || 0).filter((n) => n > 0),
      dependencies: task.dependencies.map((d) => parseInt(d.target, 10) || 0).filter((n) => n > 0),
      metadata: task.metadata,
      // Timestamps (milliseconds)
      createdAtMs: task.createdAt,
      updatedAtMs: task.updatedAt,
      completedAtMs: task.terminal === "done" ? task.updatedAt : null,
      startedAtMs: (task.metadata["startedAtMs"] as number | undefined) ?? null,
      // State machine fields
      phase: task.phase,
      condition: task.condition,
      terminal: task.terminal,
      activeAgent: activeRun?.agentId ?? null,
      activePhase: activeRun?.phase ?? null,
    };
  });

  const output = {
    master: { tasks },
    exportedAt: new Date().toISOString(),
  };

  const stateDir = path.join(config.workspaceDir, "data/task-dashboard");
  if (!fs.existsSync(stateDir)) {
    fs.mkdirSync(stateDir, { recursive: true });
  }

  const stateFile = path.join(stateDir, "state.json");
  const tmpFile = stateFile + ".tmp";
  fs.writeFileSync(tmpFile, JSON.stringify(output, null, 2) + "\n");
  fs.renameSync(tmpFile, stateFile);
}
