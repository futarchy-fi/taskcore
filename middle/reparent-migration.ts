#!/usr/bin/env npx tsx
/**
 * One-shot migration: auto-parent tasks based on T{parentId} title prefix.
 *
 * Usage:
 *   npx tsx middle/reparent-migration.ts [--dry-run] [--api URL]
 *
 * Defaults:
 *   --api http://127.0.0.1:18800
 */

interface TaskSummary {
  id: string;
  title: string;
  parentId: string | null;
  rootId: string;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const apiIdx = args.indexOf("--api");
const apiBase = apiIdx >= 0 && args[apiIdx + 1] ? args[apiIdx + 1] : "http://127.0.0.1:18800";

const TITLE_PREFIX_RE = /^T(\d+)\s*[—–\-]/;

async function main() {
  console.log(`Reparent migration${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`API: ${apiBase}\n`);

  // 1. Fetch all tasks
  const res = await fetch(`${apiBase}/tasks?full=true`);
  if (!res.ok) {
    console.error(`Failed to fetch tasks: ${res.status} ${res.statusText}`);
    process.exit(1);
  }
  const data = (await res.json()) as { tasks: TaskSummary[] };
  const tasks = data.tasks;
  const taskMap = new Map<string, TaskSummary>();
  for (const t of tasks) {
    taskMap.set(t.id, t);
  }
  console.log(`Total tasks: ${tasks.length}`);

  // 2. Find candidates: self-rooted tasks with T{id} prefix in title
  interface Candidate {
    taskId: string;
    title: string;
    targetParentId: string;
  }

  const candidates: Candidate[] = [];
  const skipped: { taskId: string; reason: string }[] = [];

  for (const t of tasks) {
    // Only consider self-rooted tasks (rootId == id, no parent)
    if (t.parentId !== null || t.rootId !== t.id) {
      continue;
    }

    const match = TITLE_PREFIX_RE.exec(t.title);
    if (!match) continue;

    const targetId = match[1]!;

    // Skip self-reference
    if (targetId === t.id) {
      skipped.push({ taskId: t.id, reason: "self-reference" });
      continue;
    }

    // Skip if target parent not found
    if (!taskMap.has(targetId)) {
      skipped.push({ taskId: t.id, reason: `parent T${targetId} not found` });
      continue;
    }

    candidates.push({ taskId: t.id, title: t.title, targetParentId: targetId });
  }

  // 3. Sort by id ascending (parents get reparented first since they have lower ids)
  candidates.sort((a, b) => parseInt(a.taskId, 10) - parseInt(b.taskId, 10));

  console.log(`Candidates: ${candidates.length}`);
  console.log(`Skipped: ${skipped.length}`);
  for (const s of skipped) {
    console.log(`  SKIP T${s.taskId}: ${s.reason}`);
  }
  console.log("");

  // 4. Process
  let reparented = 0;
  let errors = 0;

  for (const c of candidates) {
    const label = `T${c.taskId} → parent T${c.targetParentId}`;

    if (dryRun) {
      console.log(`  [DRY] ${label}  "${c.title}"`);
      reparented++;
      continue;
    }

    try {
      const rRes = await fetch(`${apiBase}/tasks/${c.taskId}/reparent`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newParentId: c.targetParentId }),
      });

      if (rRes.ok) {
        const result = await rRes.json();
        console.log(`  OK   ${label}  rootId=${(result as { newRootId: string }).newRootId}`);
        reparented++;
      } else {
        const err = await rRes.json();
        console.log(`  FAIL ${label}  ${(err as { error: string }).error}: ${(err as { message: string }).message}`);
        errors++;
      }
    } catch (e) {
      console.log(`  ERR  ${label}  ${e instanceof Error ? e.message : String(e)}`);
      errors++;
    }
  }

  console.log(`\nSummary: reparented=${reparented} skipped=${skipped.length} errors=${errors}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
