# Taskcore: Unfinished Features & Known Gaps

Fields, events, and code paths that exist in the codebase but are incomplete —
validated but not enforced, handled but never emitted, or written but never read.

Last updated: 2026-03-03.

---

## Task Fields

### `contextBudget` — validated, never enforced

The `LeaseGranted` event requires `contextBudget` to be a positive integer
(validator.ts:452). The reducer stores it on the task (reducer.ts:267). Nothing
reads it back. No agent, prompt builder, or middleware uses this value.

The dispatcher now falls back to `config.defaultContextBudget` (default: 200)
when a task has `contextBudget: 0`, because the validation was blocking all
dispatches. But the field itself is inert.

**Decision needed**: Either wire it to something (pass to agent as a context
window cap, enforce in the dispatcher) or drop the validation so it can't cause
blockers.

- types.ts:165, 218
- validator.ts:452
- reducer.ts:267
- dispatcher.ts:662

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

## Dispatcher

### Zombie reaper misses daemon restarts

The clock-based zombie reaper (clock.ts:108-127) detects orphaned active tasks
only when `lastAgentExitAt` is set. But if the daemon restarts, in-memory
`activeRuns` is lost and `AgentExited` events are never submitted — so
`lastAgentExitAt` stays null and the reaper never fires.

There is no startup reconciliation: the daemon doesn't scan for `condition:
active` tasks with no live process on boot.

- clock.ts:108-127 (reaper conditions)
- daemon.ts:94-105 (tick loop, no startup scan)
- dispatcher.ts:586 (activeRuns map, in-memory only)

### Status nudge — untested

When an agent exits with code 0 without reporting status, the dispatcher spawns a
"status nudge" to re-prompt the agent. This mechanism has zero test coverage and
may be silently broken (e.g., if the agent session doesn't persist).

- dispatcher.ts:989-1052

### `notifyInformed` — duplicated

Identical Telegram notification logic exists in both dispatcher.ts (lines
250-279) and http.ts (lines 731-750). Bug fixes or API changes must be applied
in two places.

### Review evidence — stale after re-execution

The prompt builder finds evidence by scanning for the most recent
`PhaseTransition` to review. After changes-requested cycles, this shows evidence
from a previous attempt, not the latest execution.

- prompt.ts:149-170

---

## Data Exports

### `writeRuntimeFile` / `appendLifecycle` — write-only

The dispatcher writes `executor_runtime.json` on every cycle and appends to
`task_run_lifecycle.jsonl` on every agent exit. No component reads either file.

- dispatcher.ts:1066-1096 (writeRuntimeFile)
- dispatcher.ts:1098-1110 (appendLifecycle)
