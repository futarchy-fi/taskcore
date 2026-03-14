# T1750: Taskcore Control Plane Fixes — Execution Plan

**Epic owner:** ceo  
**Review owner:** kelvin  
**Status:** Open coordination epic  
**Updated:** 2026-03-14 heartbeat session

---

## What changed in this update

This plan was corrected to match the **live** task graph rather than the earlier aspirational decomposition draft:

- removed canceled/done children from the active-work list (`T2272` canceled, `T2273` done)
- restored the **full** metadata-inheritance scope for the active child (`T2271`), based on the earlier `T2267` root-cause analysis
- documented that **T2268 owns the merged T2268 + T2272 scope** (scheduler/dispatcher + claimability.js/CLI + reviewer deadlock detection)
- backfilled `parentId`, `reviewer`, and `repo` metadata onto the outstanding children so prompts and worktree provisioning line up with the parent epic

---

## Live child status

| Task | Status | Purpose | Notes |
|---|---|---|---|
| T2267 | blocked | Historical metadata-inheritance attempt | Earlier execution was misprovisioned against the wrong repo. Metadata now corrected to point at `/home/ubuntu/taskcore`; use as historical evidence, not as the primary forward work item. |
| T2268 | analysis.waiting | Queue claimability / review deadlocks | Active child. Includes merged T2272 claimability + CLI scope. |
| T2269 | analysis.waiting | Decomposition state reconciliation | Active child. |
| T2270 | analysis.waiting | Attention alerting integration | Active child; depends on T2274. |
| T2271 | analysis.waiting | Metadata inheritance | Active child. Scope is full parent metadata propagation, not only priority/assignee/reviewer. |
| T2272 | canceled | Duplicate of T2268 | Do not schedule. |
| T2273 | done | Completed decomposition slice | Do not schedule. |
| T2274 | analysis.waiting | Attention formatter crash fix | Active child. |
| T2275 | analysis.waiting | Obsolete / blocked task cleanup | Active child. |

---

## Active execution waves

### Wave 1 — parallel now

1. **T2271 — Metadata inheritance**
   - Required propagation set: `repo`, `base_branch`, `informed`, `consulted`, `parentId`, reviewer / assignee / priority defaults, and any other operational metadata that decomposition currently drops.
   - Why first: fixes future child provisioning / context loading and removes one of the root causes already observed in T2267.

2. **T2274 — Attention formatter crash**
   - Harden the formatter / endpoint path so null or malformed task data cannot blow up the attention surface.
   - Why first: prerequisite safety work for T2270.

3. **T2275 — Obsolete / blocked task cleanup tooling**
   - Build cleanup tooling with dry-run safety and blocker-aware filters.
   - Why first: operational hygiene without dependency on the other bug fixes.

### Wave 2 — after Wave 1 context is stable

4. **T2268 — Queue claimability false positives + review deadlocks**
   - Dispatch-side: exclude `review.waiting` / non-claimable states from scheduler availability.
   - Claim-side: fix CLI/claimability false positives, active-lease visibility bugs, and reviewer-role deadlock detection.
   - This is the merged successor for T2272's canceled scope.

5. **T2269 — Decomposition state reconciliation**
   - Make decomposition retries / partial materialization idempotent.
   - Ensure superseded children are handled safely when a later decomposition version exists.

### Wave 3 — depends on T2274

6. **T2270 — Wire attention output to automated alerting**
   - Only start once the formatter path is hardened.

---

## Metadata backfill applied during this session

The following outstanding children were patched in live task state:

- `T2267`
- `T2268`
- `T2269`
- `T2270`
- `T2271`
- `T2274`
- `T2275`

Backfilled fields:

- `parentId=1750`
- `reviewer=kelvin`
- `repo=/home/ubuntu/taskcore`

Why this matters:

- child prompts can now load the parent journal context
- review-ready children will not silently deadlock on a missing reviewer
- future code worktrees will target the real taskcore repo instead of the wrong workspace or no repo at all

Verification snapshot after the backfill:

| Task | `parentId` | `reviewer` | `repo` |
|---|---|---|---|
| T2267 | `1750` | `kelvin` | `/home/ubuntu/taskcore` |
| T2268 | `1750` | `kelvin` | `/home/ubuntu/taskcore` |
| T2269 | `1750` | `kelvin` | `/home/ubuntu/taskcore` |
| T2270 | `1750` | `kelvin` | `/home/ubuntu/taskcore` |
| T2271 | `1750` | `kelvin` | `/home/ubuntu/taskcore` |
| T2274 | `1750` | `kelvin` | `/home/ubuntu/taskcore` |
| T2275 | `1750` | `kelvin` | `/home/ubuntu/taskcore` |

---

## Open coordination risks

- **T2267 vs T2271 overlap:** T2267 remains blocked historical evidence while T2271 is the intended forward execution slot. Future submissions must not pretend the blocked historical attempt is the live implementation path.
- **Immutable task descriptions:** live task descriptions still reflect earlier wording; until taskcore gains a description-edit path, the parent journal and this plan are the authoritative coordination layer for corrected scope.
- **Parent should stay open:** no T1750 submission should claim epic completion until the remaining active children are actually closed out.

---

## Immediate next actions

1. Route coders to **T2271**, **T2274**, and **T2275** first.
2. Treat **T2268** as the merged owner of the canceled **T2272** claimability/CLI work.
3. Keep **T2270** behind **T2274**.
4. Do not list **T2272** or **T2273** as active child work in future evidence.
