type Phase = "analysis" | "decomposition" | "execution" | "review";

type AttemptBudget = { used: number; max: number };

type TaskRecord = {
  id: string;
  title: string;
  phase: Phase | null;
  condition: string | null;
  terminal: string | null;
  leasedTo: string | null;
  leaseExpiresAt: number | null;
  currentFenceToken: number;
  attempts: Record<Phase, AttemptBudget>;
};

type TasksResponse = { tasks: TaskRecord[] };

const apiBase = process.env["TASKCORE_BASE_URL"] ?? "http://127.0.0.1:18800";
const dryRun = process.argv.includes("--dry-run");
const retryDelayMs = 1_000;

function nonEmptyText(value: string | null | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function leakedLeaseReason(task: TaskRecord, now: number): "lease_expired" | "orphaned_on_restart" {
  if (task.leaseExpiresAt !== null && task.leaseExpiresAt <= now) {
    return "lease_expired";
  }
  return "orphaned_on_restart";
}

function attemptNumber(task: TaskRecord, phase: Phase): number {
  return Math.max(1, task.attempts[phase]?.used ?? 0);
}

async function main(): Promise<void> {
  const now = Date.now();
  const response = await fetch(`${apiBase}/tasks?full=true`);
  if (!response.ok) {
    throw new Error(`Failed to fetch tasks: ${response.status} ${response.statusText}`);
  }

  const body = await response.json() as TasksResponse;
  const leaked = body.tasks.filter((task) =>
    task.terminal === null &&
    task.phase !== null &&
    task.condition === "active" &&
    (!nonEmptyText(task.leasedTo) || task.leaseExpiresAt === null || task.leaseExpiresAt <= now)
  );

  if (leaked.length === 0) {
    process.stdout.write("No leaked active leases found.\n");
    return;
  }

  for (const task of leaked) {
    const reason = leakedLeaseReason(task, now);
    const payload = {
      type: "RetryScheduled",
      taskId: task.id,
      ts: Date.now(),
      fenceToken: task.currentFenceToken,
      reason,
      retryAfter: Date.now() + retryDelayMs,
      phase: task.phase,
      attemptNumber: attemptNumber(task, task.phase),
    };

    if (dryRun) {
      process.stdout.write(`[dry-run] would recover T${task.id} (${task.title}) with ${reason}\n`);
      continue;
    }

    const recoverResponse = await fetch(`${apiBase}/tasks/${task.id}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!recoverResponse.ok) {
      const errorBody = await recoverResponse.text();
      throw new Error(`Failed to recover T${task.id}: ${recoverResponse.status} ${errorBody}`);
    }

    process.stdout.write(`Recovered T${task.id} (${task.title}) with ${reason}\n`);
  }
}

void main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
