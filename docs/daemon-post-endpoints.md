# Taskcore Daemon POST Endpoints Reference

Source: `middle/http.ts`

## Endpoint Summary

| Route | Purpose | Key Body Fields |
|-------|---------|-----------------|
| `POST /tasks` | Create task | title*, description*, assignee, reviewer, priority, parentId, dependsOn, costBudget, skipAnalysis |
| `POST /tasks/:id/events` | Raw event | type*, (any core event fields) |
| `POST /tasks/:id/status` | Status transition | status* (review/done/blocked/pending/execute/decompose/cancel), evidence, blocker, stateRef |
| `POST /tasks/:id/reparent` | Reparent task | newParentId* |
| `POST /tasks/:id/revive` | Revive failed/blocked | phase, resetAttempts, reason |
| `POST /tasks/:id/budget` | Increase budget | attemptBudgetIncrease, costBudgetIncrease, reason |
| `POST /tasks/:id/decompose/start` | Begin decomposition | (none) |
| `POST /tasks/:id/decompose/add-child` | Add decomp child | title*, description*, costAllocation*, skipAnalysis, assignee, reviewer, dependsOnSiblings |
| `POST /tasks/:id/decompose/commit` | Finalize decomp | approach |
| `POST /tasks/:id/decompose` | One-shot decomp | children* (array), approach |

Also: `PATCH /tasks/:id/metadata` — update metadata fields (priority, assignee, etc.)

\* = required

## Status Transition Map

```
status="execute":   analysis.active     → execution.ready
status="review":    execution.active    → review.ready
status="done":      review.active       → terminal:done
status="pending":   review.active       → execution.ready  (changes requested)
status="blocked":   any non-terminal    → terminal:blocked
status="cancel":    any non-terminal    → terminal:canceled
status="decompose": analysis.active     → decomposition.ready
```

## Decomposition Flow (Incremental)

```
POST /tasks/:id/decompose/start      → creates in-memory session, returns budget
POST /tasks/:id/decompose/add-child   → adds child spec (repeat)
POST /tasks/:id/decompose/commit      → creates all children, parent → review.waiting
```

## Key Behaviors

- **Fencing**: All writes use the task's `currentFenceToken` to prevent stale mutations
- **Registry validation**: Assignee/reviewer validated against `agents.json`
- **Cost enforcement**: Decomposition child costs must sum ≤ parent remaining budget
- **Completion checks**: Tasks with `metadata.repo` require a valid stateRef; parent tasks with `completionRule='and'` require all children done
- **Notifications**: `done` and `blocked` transitions notify Telegram targets in `metadata.informed`
