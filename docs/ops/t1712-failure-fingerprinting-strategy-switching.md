# T1712 — Failure fingerprinting, strategy switching, and dynamic retry budgets

## Problem statement

TaskCore currently treats most agent failures as variations of the same event:
- `task-executor.mjs` increments a single `retryCount`
- work is re-queued with generic exponential backoff
- only rate limits get a distinct path
- once `MAX_RETRIES` is exhausted, the task is simply blocked

That is too lossy for uncertain, browser-mediated, or dependency-heavy work. The system cannot distinguish:
- a stale login that should wake a shared auth blocker
- anti-bot / access denial that should halt sibling work on the same target
- missing inputs that should create a prerequisite task instead of more retries
- invalid state transitions that require replanning, not repetition
- verification failures after a mutation, where autonomy should stop and escalate
- repeated cost / provider exhaustion, where dispatch should shift strategy globally

The result is sibling churn: multiple leaves burn retries on the same blocker even when the next rational move is shared blocker-removal or mission replanning.

---

## Design goals

1. **Canonical failure identity** — repeated failures with the same operative cause produce the same fingerprint.
2. **Scope-aware routing** — leaf-local failures stay local; shared blockers fan in to one prerequisite task; global exhaustion triggers broader throttling.
3. **Strategy switching over blind retries** — retry only when the failure class is plausibly transient.
4. **Task-kind-aware budgets** — execution, aggregate, and artifact-only tasks do not share the same retry policy.
5. **Inspectable decisions** — every retry, pause, reroute, and blocker promotion is visible in task metadata and executor outcome logs.
6. **Fail-closed near irreversible work** — verification and state-transition failures on execution tasks escalate before more automation is attempted.

### Non-goals

- Replacing provider allocation gating from T755.
- Replacing the recovery breaker engine for host/service remediation.
- Solving target grounding/entity ambiguity (that belongs to T1704/T2110-style grounding work).

---

## Where this policy plugs in

Primary integration points:
1. **`scripts/task-executor.mjs`** — authoritative classification, retry budgeting, and routing.
2. **task metadata in `.taskmaster/tasks/tasks.json`** — persistent fingerprint, counters, blocker linkage, and route decisions.
3. **executor outcome log** (`data/task-dashboard/executor_outcomes.jsonl`) — append fingerprint + routing evidence.
4. **dashboard export / APIs** — surface repeated failure clusters, promoted blockers, and retry-budget exhaustion.

This task defines the contract and routing model. A later execution task should implement the plumbing.

---

## 1) Canonical failure fingerprint model

A **failure fingerprint** is the deduplicated identity of a task failure for orchestration purposes.

### Proposed schema

```json
{
  "version": "v1",
  "fingerprintId": "ffp_01HV...",
  "taskId": 1712,
  "taskKind": "execution",
  "runPhase": "work",
  "failureClass": "auth_session_failure",
  "scope": "shared_prerequisite",
  "resourceKey": "telegram:account:primary",
  "surface": "browser_relay",
  "reasonCode": "session_expired",
  "signature": {
    "provider": "openai-codex",
    "model": "gpt-5.4",
    "exitType": "agent_crash",
    "stderrClass": "login_required",
    "targetRef": "telegram-web"
  },
  "dedupeKey": "auth_session_failure|telegram:account:primary|browser_relay|session_expired",
  "firstSeenAt": "2026-03-13T09:00:00Z",
  "lastSeenAt": "2026-03-13T09:07:00Z",
  "attempts": 3,
  "affectedTaskIds": [1712, 1718, 1721],
  "recommendedStrategy": "wake_or_create_blocker",
  "recommendedBlockerKey": "blocker:auth:telegram:account:primary"
}
```

### Required fields

| Field | Meaning |
|---|---|
| `taskKind` | `execution`, `aggregate`, `artifact_only`, `review`, `capability_probe`, etc. |
| `runPhase` | `work` or `review` |
| `failureClass` | canonical orchestrator-facing class |
| `scope` | `leaf_local`, `shared_prerequisite`, or `global_budget` |
| `resourceKey` | normalized target of the blocker (`browser:relay:chrome`, `human:kas`, `provider:openai-codex`) |
| `reasonCode` | finer-grained sub-cause |
| `dedupeKey` | stable routing key used to collapse repeats |
| `attempts` | count of repeated hits within policy window |
| `recommendedStrategy` | `retry_same_path`, `switch_strategy`, `wake_or_create_blocker`, `pause_for_review`, `global_throttle` |

### Scope semantics

- **`leaf_local`** — retry/replan only this task. Example: malformed prompt for one artifact-only task.
- **`shared_prerequisite`** — stop retrying sibling leaves and promote a shared blocker. Example: expired auth, missing credential, inaccessible website.
- **`global_budget`** — provider/cost saturation or broad platform outage; gate future dispatch and avoid local churn.

---

## 2) Canonical failure classes

These are the minimum classes required for T1712 acceptance.

| Failure class | Typical signals | Default scope | Default strategy |
|---|---|---|---|
| `auth_session_failure` | login required, expired cookie/session, wallet disconnected, missing permission grant | `shared_prerequisite` | pause affected leaves, wake/create auth blocker |
| `access_denial_antibot` | captcha, 403, antibot page, WAF deny, account challenge | `shared_prerequisite` | stop automation path, request human unblock / alternate channel |
| `missing_input` | required ID/file/approval/parameter absent | `shared_prerequisite` if shared, else `leaf_local` | create prerequisite task or request user input |
| `invalid_state_transition` | task tries action from wrong state, precondition invalid, already-submitted/closed/cancelled | `leaf_local` or `shared_prerequisite` if state is mission-wide | replan from refreshed state; no same-path retry |
| `verification_failure` | mutation possibly happened but postcondition cannot be proven; conflicting checks | `leaf_local` on single leaf, fail-closed for execution | halt autonomy, require verification/review path |
| `cost_exhaustion_repeated` | provider denied for budget/quota reasons across attempts/windows | `global_budget` | throttle dispatch, shift provider/model/priority policy |

Recommended additional classes for implementation completeness:
- `tool_runtime_unavailable`
- `ui_selector_drift`
- `rate_limit_transient`
- `dependency_blocked`
- `human_approval_missing`

### Failure-class notes

#### `auth_session_failure`
Examples:
- browser relay attached but session logged out
- API token missing or expired
- wallet connector present but no connected account

Rule: after the second matching hit within the policy window, stop local retries and create/wake one shared auth blocker keyed by the affected account/resource.

#### `access_denial_antibot`
Rule: never let sibling leaves keep probing the same blocked surface. Switch to a human-assisted or alternate-channel strategy immediately after first confirmed match.

#### `missing_input`
Rule: if the missing input is shared by multiple children (e.g. target account id, approval token, attachment), collapse it into one prerequisite task and mark dependent leaves as waiting/blocked-by-dependency.

#### `invalid_state_transition`
Rule: do not spend retry budget repeating an action against a stale assumption. Refresh state, then either replan or close as not-applicable.

#### `verification_failure`
Rule: for execution tasks, verification failure after a mutation is **not retry-equivalent** to a normal crash. The system must stop and request human review or explicit verification work.

#### `cost_exhaustion_repeated`
Rule: once the same quota/budget fingerprint repeats across tasks or time windows, it becomes a dispatch-policy problem, not a leaf problem. Route to global throttling or provider switch.

---

## 3) Fingerprint derivation rules

The executor should derive a fingerprint in four passes:

1. **Normalize runtime facts**
   - task kind
   - run phase
   - assignee/reviewer
   - exit code / signal
   - error tail classification
   - known provider/model metadata
   - target resource / surface

2. **Assign failure class**
   - use deterministic rule table before any model-based classifier
   - allow only a bounded fallback classifier for unknown cases

3. **Resolve routing scope**
   - infer whether the cause is leaf-local, shared prerequisite, or global budget

4. **Build dedupe key**
   - `failureClass | resourceKey | surface | reasonCode`
   - exclude volatile text (timestamps, raw stack traces, run ids)

### Example derivations

```text
stderr: "Telegram Web shows login required"
=> failureClass=auth_session_failure
=> resourceKey=telegram:web:primary
=> scope=shared_prerequisite
=> dedupeKey=auth_session_failure|telegram:web:primary|browser_relay|login_required
```

```text
stderr: "429 Too Many Requests from provider openai-codex"
=> failureClass=rate_limit_transient
=> resourceKey=provider:openai-codex
=> scope=leaf_local (single task) OR global_budget once repeated threshold trips
=> dedupeKey=rate_limit_transient|provider:openai-codex|dispatch|429
```

```text
stderr: "proposal already published"
=> failureClass=invalid_state_transition
=> resourceKey=proposal:1234
=> scope=shared_prerequisite if many leaves assume draft state
=> dedupeKey=invalid_state_transition|proposal:1234|mutation_path|already_published
```

---

## 4) Strategy-switching rules

### Canonical strategies

| Strategy | Use when | Result |
|---|---|---|
| `retry_same_path` | transient/local issue and retry budget remains | requeue same task with backoff |
| `switch_strategy` | same objective still valid but current path is irrational | reroute to alternate tool/channel/plan |
| `wake_or_create_blocker` | repeated shared blocker across leaves | create or wake one prerequisite task and pause dependents |
| `pause_for_review` | verification or safety-sensitive ambiguity | send to review / human confirmation |
| `global_throttle` | provider or budget exhaustion spans multiple tasks | deny/defer future dispatch until healthy |

### Routing decision table

| Failure class | First hit | Repeated hit | Exhausted state |
|---|---|---|---|
| `auth_session_failure` | retry once if evidence is weak; otherwise create blocker immediately | wake/create shared auth blocker; pause sibling leaves | mark dependency blocker and stop automation until prerequisite closes |
| `access_denial_antibot` | stop same-path retries; request alternate route | shared blocker + human review | quarantine target surface for cooldown window |
| `missing_input` | create/wake prerequisite or ask for input | collapse siblings onto same blocker | leave waiting on prerequisite, no further retries |
| `invalid_state_transition` | refresh state and re-evaluate | replan or close as superseded | no further retries on stale path |
| `verification_failure` | require explicit verification task / review | block execution lane on target | escalate to human with evidence bundle |
| `cost_exhaustion_repeated` | apply local defer/backoff | trigger provider/model/policy switch or dispatch gate deny | global throttle until healthy window returns |

### Shared blocker promotion rule

When all of the following hold, the executor promotes a blocker task:
1. `scope == shared_prerequisite`
2. same `dedupeKey` occurs on **>= 2 tasks** or **>= 2 attempts on one task** within the policy window
3. a blocker with the same `recommendedBlockerKey` is not already active

Result:
- create or wake one blocker task
- attach `metadata.failureFingerprint.blockerTaskId`
- mark affected leaves as dependency-blocked / waiting on that blocker
- suppress additional same-fingerprint retries until blocker state changes

### Replanning rule

If a task hits `invalid_state_transition` or `verification_failure`, the next action should be a replan/verification step, not another leaf retry. The executor should either:
- create a child task for state refresh / verification, or
- send the task back to review with the fingerprint attached.

---

## 5) Dynamic retry budget policy

Retry budgets must be keyed by **task kind** and **failure class**, not one global `MAX_RETRIES`.

### Policy table (recommended v1)

| Task kind | Failure class | Auto retries | Backoff class | On exhaustion |
|---|---|---:|---|---|
| `execution` | `rate_limit_transient` | 2 | long | switch provider or defer via gate |
| `execution` | `auth_session_failure` | 1 | short | create/wake auth blocker |
| `execution` | `access_denial_antibot` | 0 | none | human unblock / alternate path |
| `execution` | `missing_input` | 0 | none | prerequisite task |
| `execution` | `invalid_state_transition` | 0 | none | refresh + replan |
| `execution` | `verification_failure` | 0 | none | review / verification task |
| `execution` | `tool_runtime_unavailable` | 1 | medium | reroute tool / pause |
| `aggregate` | `dependency_blocked` | 0 | none | wait for required children / blocker |
| `aggregate` | `missing_input` | 0 | none | request missing artifact coverage |
| `aggregate` | `tool_runtime_unavailable` | 1 | short | rerun reducer/export path |
| `aggregate` | `verification_failure` | 1 | short | review aggregate evidence |
| `artifact_only` | `tool_runtime_unavailable` | 2 | short | reroute agent/tool |
| `artifact_only` | `missing_input` | 0 | none | request source material |
| `artifact_only` | `invalid_state_transition` | 0 | none | usually close/supersede, not retry |
| `artifact_only` | `cost_exhaustion_repeated` | 1 | long | defer until budget recovers |
| `review` | `tool_runtime_unavailable` | 1 | short | reroute reviewer |
| `review` | `verification_failure` | 0 | none | escalate to human reviewer |

### Why the policies differ

- **Execution tasks** carry the most risk; most non-transient classes should not auto-retry.
- **Aggregate tasks** should rarely retry; repeated child blockers are usually dependency issues, not execution failures.
- **Artifact-only tasks** can tolerate slightly more retry on tooling failures because they do not directly mutate external state.

### Budget accounting model

Track two counters per task attempt window:
1. **`pathRetryCount`** — retries on the same strategy/path
2. **`strategySwitchCount`** — number of alternate paths already tried

This prevents a task from escaping budget control by bouncing endlessly between weak alternatives.

Recommended defaults:
- `execution`: `pathRetryCount <= 2`, `strategySwitchCount <= 1`
- `aggregate`: `pathRetryCount <= 1`, `strategySwitchCount <= 1`
- `artifact_only`: `pathRetryCount <= 2`, `strategySwitchCount <= 2`

---

## 6) Proposed metadata contract

Add the following metadata shape to task records:

```json
{
  "metadata": {
    "retryPolicy": {
      "taskKind": "execution",
      "pathRetryCount": 1,
      "strategySwitchCount": 0,
      "budgetWindow": "30m",
      "lastBudgetDecision": "wake_or_create_blocker"
    },
    "failureFingerprint": {
      "fingerprintId": "ffp_01HV...",
      "failureClass": "auth_session_failure",
      "scope": "shared_prerequisite",
      "dedupeKey": "auth_session_failure|telegram:web:primary|browser_relay|login_required",
      "attemptsWindow": 2,
      "firstSeenAt": "2026-03-13T09:00:00Z",
      "lastSeenAt": "2026-03-13T09:07:00Z",
      "recommendedStrategy": "wake_or_create_blocker",
      "blockerTaskId": 1730
    },
    "blockedByFingerprint": true,
    "sharedBlockerKey": "blocker:auth:telegram:web:primary"
  }
}
```

### Executor outcome log extension

Each `executor_outcomes.jsonl` record should append:
- `taskKind`
- `failureClass`
- `fingerprintDedupeKey`
- `routingDecision`
- `scope`
- `strategySwitched` (bool)
- `blockerTaskId` (if any)

This is the minimum observability needed to prove sibling churn actually dropped after rollout.

---

## 7) Shared blocker lifecycle

### Blocker task creation contract

When promoting shared blocker work, the system should create a task with:
- kind: `capability_probe` or `blocker_removal`
- title: deterministic and resource-based
- description: include fingerprint class, affected resource, and evidence bundle
- metadata:
  - `blockerKey`
  - `sourceFingerprint`
  - `affectedTaskIds`
  - `createdFromFailureRouter=true`

### Wake vs create

- **Wake existing blocker** when an active/pending blocker has the same `blockerKey`.
- **Create new blocker** only when no active blocker exists.

### Leaf behavior while blocker active

Affected leaves should not continue ordinary retry scheduling. Instead they should move to a dependency-held condition with:
- blocker task id
- blocker key
- fingerprint id
- timestamp of last routed match

This is the mechanism that stops sibling retry burn.

---

## 8) Observability and dashboards

Required dashboard/reporting surfaces:
1. **Top repeated fingerprints** in the last 24h
2. **Shared blocker promotions** and number of leaves collapsed behind each blocker
3. **Retries avoided** after blocker promotion
4. **Failure-class breakdown by task kind**
5. **Global budget throttles** with provider/model linkage

Key success metrics:
- drop in repeated identical failures per sibling set
- increase in blocker reuse rate
- reduction in tasks blocked only after max retries
- fewer execution tasks auto-retrying on verification failures

---

## 9) Acceptance tests for the implementation task

### A. Shared auth blocker
1. Two execution leaves fail with the same expired-session fingerprint.
2. System creates/wakes one auth blocker.
3. Sibling leaves stop consuming retries.
4. Both leaves reference the same blocker task id/key.

### B. Anti-bot/access denial
1. First confirmed anti-bot fingerprint occurs on an execution task.
2. Executor does **not** requeue same path.
3. Alternate route or human unblock task is requested.

### C. Missing shared input
1. Multiple tasks lack the same approval token / file.
2. One prerequisite task is created.
3. Additional failures attach to existing blocker instead of creating duplicates.

### D. Invalid state transition
1. Execution task tries to mutate an already-finalized resource.
2. No same-path retry occurs.
3. Task routes to refresh/replan or closes as superseded.

### E. Verification failure
1. Mutation step appears to succeed but verification check is inconclusive.
2. Task does not spend standard retry budget.
3. Task escalates to review/verification work.

### F. Dynamic budgets by task kind
1. `artifact_only` task with tool outage gets >0 retries.
2. `aggregate` task with dependency blocker gets 0 same-path retries.
3. `execution` task with auth failure gets <=1 retry before blocker promotion.

### G. Repeated cost exhaustion
1. Same provider quota exhaustion hits multiple tasks in window.
2. A global throttle / provider-switch path is activated.
3. Future dispatch is deferred rather than burning leaf retries.

---

## 10) Implementation order recommendation

1. Add fingerprint schema + deterministic classifier in executor.
2. Persist metadata and outcome-log extensions.
3. Add blocker promotion / wake semantics.
4. Add per-task-kind retry policy table.
5. Add dashboard aggregation + regression tests.

This order ensures the system can first *see* repeated failure identity, then *route* it, then *enforce* differentiated budgets.

---

## Bottom line

T1712 should change TaskCore from **"every failure increments one retry counter"** to **"each failure class carries a scoped fingerprint and a bounded next strategy."**

That is the key behavior change needed to stop repeated sibling churn, promote blocker-removal work when appropriate, and make retry policy depend on both **what failed** and **what kind of task failed**.
