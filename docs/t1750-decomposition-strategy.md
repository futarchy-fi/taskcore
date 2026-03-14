# T1750 — Live Decomposition / Coordination State

Updated during the 2026-03-14 heartbeat work session.

## Epic status

T1750 remains **open**. Do not close the epic until every required child is either `done` or explicitly superseded/canceled with the parent state reconciled.

## Current child inventory

| Task | Live status | Role in the epic | Coordination notes |
|---|---|---|---|
| T2267 | `blocked` | Historical metadata-inheritance attempt | Blocked earlier because the task was provisioned against the wrong repo/worktree. During this session the child metadata was backfilled to `repo=/home/ubuntu/taskcore`, `parentId=1750`, `reviewer=kelvin` so a future revive/retry will point at the correct repo. Treat T2271 as the forward execution slot for this bug. |
| T2268 | `analysis.waiting` | Active queue claimability / review-deadlock fix | **Merged scope from canceled T2272 lives here.** This task now owns both dispatch-side guards (`scheduler.ts`, `dispatcher.ts`) and claim-side classifier / CLI listing work (`claimability.js`, queue listing, reviewer deadlock detection). |
| T2269 | `analysis.waiting` | Active decomposition-state reconciliation fix | Covers idempotent / partial `DecompositionCreated` handling and cleanup of superseded children. |
| T2270 | `analysis.waiting` | Active attention-alert wiring fix | Depends on T2274 hardening the formatter path first. |
| T2271 | `analysis.waiting` | Active metadata-inheritance fix | **Full scope, not the earlier narrowed wording.** This child must propagate parent metadata needed for real execution: `repo`, `base_branch`, `informed`, `consulted`, `parentId`, and other operational/custom fields, while letting child-specified values override defaults. |
| T2272 | `canceled` | Duplicate | Canceled intentionally after its claimability / CLI scope was merged into T2268. Do not treat it as an active child. |
| T2273 | `done` | Completed decomposition-state slice | Finished. Keep it out of the active-child plan. |
| T2274 | `analysis.waiting` | Active attention formatter crash fix | Independent Wave 1 work. |
| T2275 | `analysis.waiting` | Active obsolete / blocked task cleanup tooling | Independent Wave 1 work. |

## Execution waves

### Wave 1 — ready in parallel
- **T2271** — metadata inheritance (full parent-metadata propagation scope)
- **T2274** — attention formatter crash hardening
- **T2275** — obsolete / blocked task cleanup tooling

### Wave 2 — after Wave 1 context is in place
- **T2268** — merged queue claimability + CLI + review deadlock fix
- **T2269** — decomposition state reconciliation / idempotent child materialization

### Wave 3 — depends on T2274
- **T2270** — wire attention output into automated alerting

## Coordination repairs applied in this session

To reconcile live task state with the plan, the following metadata was backfilled onto the outstanding children (`T2267`, `T2268`, `T2269`, `T2270`, `T2271`, `T2274`, `T2275`):

- `parentId=1750` — so child prompts can load parent journal context
- `reviewer=kelvin` — so review-ready children do not deadlock with a null reviewer
- `repo=/home/ubuntu/taskcore` — so future code worktrees target the actual taskcore repo instead of the wrong workspace or no repo at all

This does **not** change the immutable task descriptions already stored in state, so the parent journal + this document are the live source of truth for the merged / corrected scope until the children are executed and closed.

## Practical guidance

- If a coder picks up **T2271**, they should implement the **full** metadata propagation bug described in the parent journal, not just priority/assignee/reviewer defaults.
- If a coder picks up **T2268**, they should treat the canceled **T2272** claimability / CLI scope as in-scope.
- Do **not** list T2272 or T2273 as active work items in future T1750 submissions.
- Keep the epic open; this session only repaired coordination / metadata drift and did not complete the children.
