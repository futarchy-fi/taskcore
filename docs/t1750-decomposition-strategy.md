# T1750 — Decomposition Strategy (v3, reconciled)

## Epic scope

Five critical taskcore control-plane fixes, all prerequisites for T1726 orchestration work.

## Child inventory — current state

Two decomposition rounds produced T2267-T2275. After reconciliation:

### Active children (work remaining)

| Task | Bug | Status | Scope |
|------|-----|--------|-------|
| **T2268** | Queue claimability & review deadlocks | analysis.waiting | Merged scope from original T2268 (scheduler/dispatcher) + canceled T2272 (claimability.js/CLI). Covers: isDispatchable guard, escalation logic, claimability classifier false positives, lease-aware queue filtering, reviewer deadlock detection. |
| **T2271** | Metadata inheritance | analysis.waiting | Full scope: propagate ALL parent metadata (priority, assignee, reviewer, tags, informed, repo, base_branch, custom fields) to children during decomposition. Subsumes T2267's analysis. |
| **T2270** | Attention formatter wiring | analysis.waiting | Wire collectAttentionTasks to periodic dispatch hook or cron; consolidate duplicated notify logic between dispatcher.ts and http.ts. |
| **T2274** | Attention formatter crash | analysis.waiting | Null-safety guards in collectAttentionTasks/toSummary; harden CLI cmdAttention error handling. |
| **T2275** | Obsolete task cleanup | analysis.waiting | Cleanup script for 165 blocked tasks per T1749 audit: stale claims, metadata mismatches, genuinely obsolete tasks. Dry-run default. |

### Terminal children (no work remaining)

| Task | Bug | Status | Notes |
|------|-----|--------|-------|
| **T2273** | Decomposition reconciliation | **done** | Completed — re-decomposition detects existing children, cancels stale ones, validates version increment. |
| **T2272** | Queue claimability (CLI scope) | canceled | Scope merged into T2268. |
| **T2269** | Decomposition reconciliation (v1) | canceled | Superseded by completed T2273. |
| **T2267** | Metadata inheritance (v1) | blocked/terminal | Analysis captured; scope subsumed by updated T2271 with full-field propagation. |

## Bug coverage matrix

| # | Bug | Owner task | Status |
|---|-----|-----------|--------|
| 1 | Metadata inheritance (full: repo/base_branch/informed/custom fields) | T2271 | waiting |
| 2 | Queue claimability false positives + review deadlocks | T2268 | waiting |
| 3 | Decomposition state reconciliation | T2273 | **done** |
| 4a | Attention formatter crash | T2274 | waiting |
| 4b | Attention formatter wiring | T2270 | waiting |
| 5 | Obsolete/blocked task cleanup | T2275 | waiting |

## Sequencing

All 5 active children (T2268, T2270, T2271, T2274, T2275) can run in parallel — no blocking dependencies between them. T2273 (the only dependency for decomposition reconciliation) is already done.

## Epic status

T1750 remains open as a coordination epic. It completes when all active children reach terminal/done.

## Changes in this reconciliation (v3)

1. **T2268 description updated** — merged T2272's claimability.js/CLI scope into T2268.
2. **T2271 description updated** — expanded from priority/assignee/reviewer-only to full metadata propagation (repo, base_branch, informed, tags, custom fields) per T2267's root-cause analysis.
3. **T2269 canceled** — superseded by completed T2273.
4. **Doc rewritten** — removed stale references to T2272/T2273 as active children.
