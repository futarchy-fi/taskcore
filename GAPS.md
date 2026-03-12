# Taskcore: Unfinished Features & Known Gaps

Fields, events, and code paths that exist in the codebase but are incomplete —
validated but not enforced, handled but never emitted, or written but never read.

Last updated: 2026-03-12.

---

## Task Fields

### `contextBudget` — validated, never enforced

The `LeaseGranted` event requires `contextBudget` to be a positive integer
(validator.ts:452). The reducer stores it on the task (reducer.ts:267). Nothing
reads it back. No agent, prompt builder, or middleware uses this value.

The `task do` CLI passes `contextBudget` via `LeaseGranted` using the configured
default (200). The field itself is inert — no agent reads it back.

**Decision needed**: Either wire it to something (pass to agent as a context
window cap) or drop the validation so it can't cause blockers.

- types.ts:165, 218
- validator.ts:452
- reducer.ts:267

### `contextIsolation` — populated, never enforced

Tasks store an `IsolationRule[]` from `reviewConfig.isolationRules`. The array is
populated on task creation but never read by the dispatcher, prompt builder, or
agent spawn logic. Review agents have unrestricted context access regardless of
what rules are configured.

- types.ts:90 (IsolationRule), 164 (Task.contextIsolation)
- reducer.ts:127, 175, 231

### `failureDigestVersion` — always zero

Integer field, initialized to 0, never incremented, never read. Appears to be
scaffolding for a planned "failure digest" feature that was never built.

- types.ts:152

---

## Events

### `TaskFailed` — handler exists, never emitted

The reducer handles `TaskFailed` (reducer.ts:605-619) and the validator accepts
it (validator.ts:706-710), but nothing in the codebase ever creates this event.

`TaskExhausted` replaced it in practice: exhausted is recoverable via
`BudgetIncreased`, while `TaskFailed` would set `terminal: "failed"` (permanent
until `TaskRevived`). The permanent failure path is dead code.

- types.ts:382-387
- reducer.ts:605-619
- validator.ts:706-710

---

## HTTP API

### Daemon event loop blocking during claim (latent)

`POST /tasks/:id/claim` calls `ensureTaskWorkspaces()` which runs multiple git
operations via `execFileSync` — up to 4 commits for journal branch creation plus
a worktree add. Each call blocks the Node.js event loop for up to 30 seconds.
While blocked, the daemon cannot process tick events, serve the dashboard, or
respond to any other HTTP request.

**Partial fix (T2098)**: Added a 90-second client-side timeout to `httpRequest()`
in `core/cli/task.ts` so agents get a readable error instead of hanging forever.

**Remaining gap**: The `execFileSync` calls should be replaced with async
`execFile` (promisified) or delegated to a worker thread. Until then, a slow git
repo can stall the entire daemon for up to ~120s per claim.

- middle/http.ts:811 (`ensureTaskWorkspaces` in claim handler)
- middle/worktree.ts:210 (`execFileSync` with 30s timeout)
- middle/journal.ts:54–60 (`createTaskBranch` — 4 sync git calls)
- core/cli/task.ts:419 (fix: `req.setTimeout(90_000)`)

### `"decompose"` status — returns 501

`POST /tasks/:id/status` with `status: "decompose"` is accepted by the request
schema (the body type includes a `children` array) but the handler returns
`501 Not Implemented`. Task decomposition via the status endpoint doesn't work.

- http.ts:521
- http.ts:45 (StatusUpdateBody.children)

### `/attention/telegram` — never called

Endpoint builds a formatted summary of blocked/failed/exhausted tasks suitable
for Telegram. Works correctly if called manually but nothing invokes it — no
cron, no timer, no dispatcher hook.

- http.ts:1081-1135

---

### Review evidence — stale after re-execution

The prompt builder finds evidence by scanning for the most recent
`PhaseTransition` to review. After changes-requested cycles, this shows evidence
from a previous attempt, not the latest execution.

- prompt.ts:149-170

---

## Data Exports

### Event persistence — restart race condition (FIXED)

`systemctl restart` could start a new daemon while the old one was still in its
shutdown handler, causing two processes to race on the same SQLite DB. This
corrupted WAL state and caused event loss (1604 events lost in production, 76
completed tasks regressed to earlier states).

**Fixed 2026-03-03**:
- persistence.ts: explicit `PRAGMA wal_checkpoint(TRUNCATE)` before `db.close()`
- index.ts: guard against saving empty snapshots over populated ones
- systemd unit: `TimeoutStopSec=30` + `RestartSec=5` to prevent race

Remaining risk: a truly unclean shutdown (SIGKILL, OOM kill) can still lose
events that are in the WAL but not yet checkpointed to the main DB. Periodic
background checkpointing would mitigate this.

- persistence.ts:141-148 (close with WAL checkpoint)
- index.ts:265-280 (snapshot guard)

