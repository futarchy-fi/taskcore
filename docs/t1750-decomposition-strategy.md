# T1750 — Decomposition Strategy

## Epic scope

Five critical taskcore control-plane fixes, all prerequisites for T1726 orchestration work.

## Children

### T2271: Metadata inheritance for child tasks
- **Files:** `middle/http.ts` (handleDecomposeCommit, handleDecompose), `middle/test/http.test.ts`
- **Fix:** Default child metadata (priority, assignee, reviewer) from parent when not explicitly provided during decomposition.
- **Independent** — can start immediately.

### T2272: Queue claimability false positives and review deadlocks
- **Files:** `core/dist/core/cli/claimability.js` (source), CLI task list
- **Fix:** (a) Review tasks only claimable by designated reviewer role, (b) tasks with active leases not shown as available, (c) deadlock detection for reviewer-less review tasks.
- **Independent** — can start immediately.

### T2273: Decomposition state reconciliation for already-materialized children
- **Files:** `middle/http.ts` (decompose/start, decompose/commit), `core/reducer.ts`
- **Fix:** Detect existing children on re-decomposition, cancel stale children, validate version increment.
- **Depends on T2271** — metadata fix informs decomposition state handling.

### T2274: Attention formatter crash
- **Files:** `middle/http.ts` (collectAttentionTasks, toSummary), CLI `task.js` (cmdAttention)
- **Fix:** Null-safety for task metadata in attention endpoints, graceful error handling in CLI.
- **Independent** — can start immediately.

### T2275: Obsolete and blocked task cleanup
- **Files:** New script `scripts/taskcore_cleanup_obsolete.ts`
- **Fix:** Bulk cleanup of 165 blocked tasks per T1749 audit: remove stale claims, reconcile metadata, transition or cancel genuinely obsolete tasks. Dry-run default.
- **Independent** — can start immediately.

## Sequencing

T2271, T2272, T2274, T2275 can all run in parallel (assigned to coder agents).
T2273 waits for T2271 to land first.

## Note on prior children (T2267-T2270)

A prior decomposition v1 created T2267-T2270 with overlapping scope. Those should be superseded by the v2 children above (T2271-T2275) which have more precise descriptions and correct dependency links.
