# T1750: Taskcore Control Plane Fixes — Execution Plan

**Epic owner:** ceo
**Date:** 2026-03-14
**Status:** Active — children decomposed, sequencing established

---

## Children Summary

| ID    | Title                                   | Est. Complexity | Wave |
|-------|-----------------------------------------|-----------------|------|
| T2271 | Metadata inheritance for child tasks    | Low-Med         | 1    |
| T2274 | Attention formatter crash               | Low             | 1    |
| T2275 | Obsolete/blocked task cleanup           | Medium          | 1    |
| T2268 | Queue claimability false positives (scheduler) | Medium   | 2    |
| T2269 | Decomposition state reconciliation      | Medium-High     | 2    |
| T2270 | Wire attention formatter to alerting    | Medium          | 3    |
| T2272 | **DUPLICATE — merge into T2268**        | —               | —    |

---

## Duplicate: T2268 vs T2272

Both cover "queue claimability false positives and review deadlocks."

- **T2268** focuses on `scheduler.ts` `isDispatchable()` — the dispatch-side guard.
- **T2272** focuses on `claimability.js` and CLI `task list` — the claim-side classifier.

These are two halves of the same problem. **Recommendation: cancel T2272, expand T2268's scope** to cover both dispatch-side (isDispatchable) and claim-side (isClaimableByRole) guards. The fix should be a single coherent change touching both code paths.

---

## Execution Waves

### Wave 1 — Independent, no dependencies (parallel)

1. **T2274 — Fix attention formatter crash** (LOW effort)
   - Add null-safety guards in `collectAttentionTasks` and `toSummary`
   - Harden CLI `cmdAttention` error handling
   - Why first: unblocks T2270, quick defensive fix

2. **T2271 — Metadata inheritance for child tasks** (LOW-MED effort)
   - Default child priority/assignee/reviewer from parent in `handleDecomposeCommit`
   - Add test coverage in `middle/test/http.test.ts`
   - Why first: correctness fix that affects all future decomposition

3. **T2275 — Obsolete/blocked task cleanup** (MED effort)
   - Create `scripts/taskcore_cleanup_obsolete.ts` with dry-run default
   - Addresses 165 blocked tasks from T1749 audit
   - Why first: operational hygiene, clears noise from task queue

### Wave 2 — Builds on Wave 1 understanding

4. **T2268 — Queue claimability false positives** (MED effort, expanded scope)
   - Dispatch-side: `isDispatchable()` must exclude `review.waiting`
   - Claim-side: `isClaimableByRole` must respect active leases and reviewer roles
   - Deadlock detection: escalate when all children of review.waiting parent are terminal/blocked

5. **T2269 — Decomposition state reconciliation** (MED-HIGH effort)
   - Make `DecompositionCreated` idempotent (skip existing children, don't reject)
   - Support partial materialization
   - Cleanup superseded children from old decomposition versions
   - Highest risk change — touches validator and reducer

### Wave 3 — Depends on T2274 completion

6. **T2270 — Wire attention to automated alerting** (MED effort)
   - Add periodic attention check via dispatcher clock tick or cron
   - Consolidate duplicated notify logic (dispatcher.ts:250-279 vs http.ts:731-750)
   - Depends on T2274 crash fix being in place

---

## Risks

- **T2269 is the riskiest change** — validator/reducer modifications could break event processing. Needs careful test coverage.
- **T2275 cleanup script** running against production needs careful dry-run validation before `--apply`.
- **T2268 expanded scope** — merging two tasks means more surface area in one PR. If it bloats, split dispatch-side and claim-side into sub-tasks.

---

## Next Actions

1. Cancel T2272 (duplicate of T2268)
2. Update T2268 description to include claim-side scope from T2272
3. Wave 1 tasks are ready for coder to pick up in parallel
