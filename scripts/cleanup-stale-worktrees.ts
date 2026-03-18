import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadConfig } from "../middle/config.js";
import { getWorktreePath, removeWorktree, writeTaskContext } from "../middle/worktree.js";

type Kind = "journal" | "code";

interface TaskRecord {
  id: string;
  phase: string | null;
  condition: string | null;
  terminal: string | null;
  currentFenceToken?: number;
  updatedAt?: number;
  metadata?: Record<string, unknown>;
}

interface AuditRow {
  name: string;
  worktreePath: string;
  kind: Kind;
  taskId: string;
  status: string;
  dotask: string;
  branch: string | null;
  classes: string[];
}

function normalizeTaskId(value: string): string {
  return value.replace(/^T/i, "");
}

function readArg(name: string): string | null {
  const idx = process.argv.indexOf(name);
  if (idx === -1) return null;
  return process.argv[idx + 1] ?? null;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function taskStatus(task: TaskRecord | null): string {
  if (!task) return "not_found";
  return task.terminal ?? `${task.phase ?? "null"}.${task.condition ?? "null"}`;
}

function readDottaskTaskId(worktreePath: string): string {
  const dotaskPath = path.join(worktreePath, ".task");
  if (!fs.existsSync(dotaskPath)) return "missing";
  try {
    const parsed = JSON.parse(fs.readFileSync(dotaskPath, "utf-8")) as Record<string, unknown>;
    const taskId = String(parsed["taskId"] ?? "").trim();
    return taskId || "empty";
  } catch {
    return "invalid";
  }
}

function currentBranch(worktreePath: string): string | null {
  if (!fs.existsSync(worktreePath)) return null;
  try {
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: worktreePath,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return branch || null;
  } catch {
    return null;
  }
}

async function fetchTasks(apiBase: string): Promise<TaskRecord[]> {
  const res = await fetch(`${apiBase}/tasks?full=true`);
  if (!res.ok) {
    throw new Error(`failed to fetch tasks: ${res.status} ${res.statusText}`);
  }
  const body = await res.json() as { tasks?: TaskRecord[] };
  return Array.isArray(body.tasks) ? body.tasks : [];
}

function existingRoots(config: ReturnType<typeof loadConfig>, taskId: string): string[] {
  return [
    getWorktreePath(config.worktreeBaseDir, taskId, "journal"),
    getWorktreePath(config.worktreeBaseDir, taskId, "code"),
  ].filter((root) => fs.existsSync(root));
}

function repairTaskContext(
  config: ReturnType<typeof loadConfig>,
  task: TaskRecord,
): boolean {
  const roots = existingRoots(config, task.id);
  if (roots.length === 0) return false;

  const claimedAt =
    Date.parse(asString(task.metadata?.["claimedAt"]) ?? "") ||
    asNumber(task.updatedAt) ||
    Date.now();
  const sessionId = asString(task.metadata?.["claimSessionId"]) ?? `recovered-${task.id}`;
  const journalRoot = getWorktreePath(config.worktreeBaseDir, task.id, "journal");
  const journalPath = `${path.join(journalRoot, "tasks", `T${task.id}`)}${path.sep}`;

  writeTaskContext({
    taskId: task.id,
    phase: task.phase,
    fenceToken: asNumber(task.currentFenceToken) ?? 0,
    sessionId,
    journalPath,
    codeWorktree: fs.existsSync(getWorktreePath(config.worktreeBaseDir, task.id, "code"))
      ? getWorktreePath(config.worktreeBaseDir, task.id, "code")
      : null,
    claimedAt,
    reviewNotes: [],
  }, roots);
  return true;
}

function removeAuditedWorktree(
  config: ReturnType<typeof loadConfig>,
  row: AuditRow,
  task: TaskRecord | null,
): boolean {
  if (row.kind === "journal") {
    removeWorktree(config.journalRepoPath, row.worktreePath);
    return true;
  }

  const targetRepo =
    asString(task?.metadata?.["repo"]) ||
    asString(config.defaultCodeRepo);
  if (targetRepo) {
    removeWorktree(targetRepo, row.worktreePath);
    return true;
  }

  fs.rmSync(row.worktreePath, { recursive: true, force: true });
  return true;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const apiBase = readArg("--api-base") ?? `http://127.0.0.1:${config.port}`;
  const apply = hasFlag("--apply");
  const jsonMode = hasFlag("--json");

  const liveTasks = await fetchTasks(apiBase);
  const taskIndex = new Map(liveTasks.map((task) => [normalizeTaskId(task.id), task]));
  const rows: AuditRow[] = [];

  if (fs.existsSync(config.worktreeBaseDir)) {
    for (const entry of fs.readdirSync(config.worktreeBaseDir)) {
      const match = /^(journal|code)-T(.+)$/.exec(entry);
      if (!match) continue;

      const kind = match[1] as Kind;
      const taskId = normalizeTaskId(match[2]!);
      const worktreePath = path.join(config.worktreeBaseDir, entry);
      const task = taskIndex.get(taskId) ?? null;
      const dotask = readDottaskTaskId(worktreePath);
      const branch = kind === "code" ? currentBranch(worktreePath) : null;
      const classes: string[] = [];

      if (!task) {
        classes.push("ORPHANED");
      } else if (task.terminal !== null) {
        classes.push("STALE");
      } else {
        classes.push("ACTIVE");
      }

      if (dotask === "missing" || dotask === "invalid" || dotask === "empty") {
        classes.push("BROKEN_DOTASK");
      } else if (normalizeTaskId(dotask) !== taskId) {
        classes.push("MISMATCHED");
      }

      if (kind === "code" && branch && branch !== `task/T${taskId}`) {
        classes.push("BRANCH_SUSPECT");
      }

      rows.push({
        name: entry,
        worktreePath,
        kind,
        taskId,
        status: taskStatus(task),
        dotask,
        branch,
        classes,
      });
    }
  }

  let removed = 0;
  let repaired = 0;
  if (apply) {
    for (const row of rows) {
      const task = taskIndex.get(row.taskId) ?? null;
      if (row.classes.includes("ORPHANED") || row.classes.includes("STALE")) {
        if (removeAuditedWorktree(config, row, task)) removed++;
        continue;
      }
      if (row.classes.includes("BROKEN_DOTASK") || row.classes.includes("MISMATCHED")) {
        if (task && repairTaskContext(config, task)) repaired++;
      }
    }
  }

  const summary = {
    total: rows.length,
    stale: rows.filter((row) => row.classes.includes("STALE")).length,
    orphaned: rows.filter((row) => row.classes.includes("ORPHANED")).length,
    active: rows.filter((row) => row.classes.includes("ACTIVE")).length,
    mismatched: rows.filter((row) => row.classes.includes("MISMATCHED")).length,
    brokenDottask: rows.filter((row) => row.classes.includes("BROKEN_DOTASK")).length,
    branchSuspect: rows.filter((row) => row.classes.includes("BRANCH_SUSPECT")).length,
    removed,
    repaired,
    sample: rows.slice(0, 25),
  };

  if (jsonMode) {
    process.stdout.write(JSON.stringify(summary, null, 2) + "\n");
    return;
  }

  process.stdout.write(`Worktrees: ${summary.total}\n`);
  process.stdout.write(`Active: ${summary.active}\n`);
  process.stdout.write(`Stale: ${summary.stale}\n`);
  process.stdout.write(`Orphaned: ${summary.orphaned}\n`);
  process.stdout.write(`Mismatched .task: ${summary.mismatched}\n`);
  process.stdout.write(`Broken .task: ${summary.brokenDottask}\n`);
  process.stdout.write(`Branch suspect: ${summary.branchSuspect}\n`);
  if (apply) {
    process.stdout.write(`Removed: ${removed}\n`);
    process.stdout.write(`Repaired: ${repaired}\n`);
  } else {
    process.stdout.write("Dry run only. Re-run with --apply to remove stale/orphaned worktrees and repair active .task metadata.\n");
  }
}

main()
  .then(() => {
    process.exit(0);
  })
  .catch((err) => {
    process.stderr.write(String(err) + "\n");
    process.exit(1);
  });
