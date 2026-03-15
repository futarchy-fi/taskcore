# T1712 — Failure Fingerprinting and Strategy Switching: Implementation Summary

## Overview

T1712 defines a comprehensive system for categorizing and routing task failures in TaskCore. The goal is to move from a naive "every failure increments one retry counter" model to a sophisticated system where each failure class carries a scoped fingerprint and bounded next strategy.

## Key Behavior Changes

### Before (Current System)
- Single `retryCount` per task
- Generic exponential backoff
- Only rate limits get special handling
- Sibling churn: multiple leaves burn retries on the same blocker

### After (T1712 Design)
- Failure fingerprints deduplicate identical failure causes
- Routing decisions based on failure class and scope
- Per-task-kind retry budgets
- Shared blocker promotion stops sibling churn
- Observable retry decisions and outcomes

---

## Core Components

### 1. Failure Fingerprint Schema

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

### 2. Canonical Failure Classes

| Class | Typical Signals | Default Scope | Default Strategy |
|-------|-----------------|---------------|------------------|
| `auth_session_failure` | Login required, expired session, wallet disconnected | `shared_prerequisite` | Pause leaves, wake/create auth blocker |
| `access_denied_antibot` | Captcha, 403, WAF deny, account challenge | `shared_prerequisite` | Stop automation, request human unblock |
| `missing_input` | Required ID/file/approval/parameter absent | `shared_prerequisite` or `leaf_local` | Create prerequisite task or request input |
| `invalid_state_transition` | Action from wrong state, already-submitted/closed | `leaf_local` or `shared_prerequisite` | Replan from refreshed state |
| `verification_failure` | Mutation succeeded but postcondition unproven | `leaf_local` | Halt autonomy, require review |
| `cost_exhaustion_repeated` | Provider denied for budget/quota | `global_budget` | Throttle dispatch, shift provider |

### 3. Retry Budget Policies

| Task Kind | Failure Class | Auto Retries | Backoff | On Exhaustion |
|-----------|---------------|--------------|---------|---------------|
| `execution` | `rate_limit_transient` | 2 | long | Switch provider or defer |
| `execution` | `auth_session_failure` | 1 | short | Create/wake auth blocker |
| `execution` | `access_denied_antibot` | 0 | none | Human unblock / alternate path |
| `execution` | `missing_input` | 0 | none | Prerequisite task |
| `execution` | `invalid_state_transition` | 0 | none | Refresh + replan |
| `execution` | `verification_failure` | 0 | none | Review / verification task |
| `aggregate` | `dependency_blocked` | 0 | none | Wait for children / blocker |
| `artifact_only` | `tool_runtime_unavailable` | 2 | short | Reroute agent/tool |

### 4. Strategy Switching Rules

| Strategy | Use When | Result |
|----------|---------|--------|
| `retry_same_path` | Transient/local issue, retry budget remains | Requeue with backoff |
| `switch_strategy` | Same objective valid but current path irrational | Reroute to alternate tool/channel |
| `wake_or_create_blocker` | Repeated shared blocker across leaves | Create/wake prerequisite task, pause dependents |
| `pause_for_review` | Verification or safety-sensitive ambiguity | Send to review / human confirmation |
| `global_throttle` | Provider or budget exhaustion spans tasks | Deny/defer future dispatch until healthy |

---

## Integration Points in TaskCore

### 1. Core Layer (`core/`)

**New File: `core/fingerprint.ts`**
- Failure fingerprint type definitions
- Fingerprint derivation logic (4-pass normalization)
- Dedupe key generation
- Scope resolution rules

**Modified File: `core/types.ts`**
- Add `FailureFingerprint` type to `TaskMetadata`
- Add `RetryPolicy` type with per-task-kind budgets

**Modified File: `core/reducer.ts`**
- Handle `FailureFingerprintRecorded` event
- Store fingerprint in task metadata
- Track retry budget consumption

**New File: `core/retry-policy.ts`**
- Per-task-kind retry budget table
- Budget accounting (pathRetryCount, strategySwitchCount)
- Exhaustion logic

### 2. Middle Layer (`middle/`)

**Modified File: `middle/executor.ts`**
- Call fingerprint derivation on task failure
- Classify failure into canonical class
- Apply strategy switching rules
- Generate blocker tasks when needed
- Extend executor outcome log with fingerprint data

**Modified File: `middle/http.ts`**
- Add endpoints for querying repeated failures
- Expose blocker promotion metrics

### 3. Task Metadata Schema

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

### 4. Executor Outcome Log Extensions

Each record in `executor_outcomes.jsonl` should include:
- `taskKind`
- `failureClass`
- `fingerprintDedupeKey`
- `routingDecision`
- `scope`
- `strategySwitched` (bool)
- `blockerTaskId` (if any)

---

## Shared Blocker Lifecycle

### Blocker Promotion Rules

Trigger when ALL of the following hold:
1. `scope == shared_prerequisite`
2. Same `dedupeKey` occurs on **>= 2 tasks** or **>= 2 attempts on one task** within policy window
3. No active blocker with same `recommendedBlockerKey` exists

### Blocker Task Creation Contract

- Kind: `capability_probe` or `blocker_removal`
- Title: Deterministic and resource-based
- Description: Includes fingerprint class, affected resource, evidence bundle
- Metadata:
  - `blockerKey`
  - `sourceFingerprint`
  - `affectedTaskIds`
  - `createdFromFailureRouter=true`

### Leaf Behavior While Blocker Active

Affected leaves move to dependency-held condition with:
- Blocker task ID
- Blocker key
- Fingerprint ID
- Timestamp of last routed match

---

## Observability Requirements

### Dashboard Surfaces

1. **Top repeated fingerprints** in last 24h
2. **Shared blocker promotions** and leaves collapsed behind each
3. **Retries avoided** after blocker promotion
4. **Failure-class breakdown** by task kind
5. **Global budget throttles** with provider/model linkage

### Success Metrics

- Drop in repeated identical failures per sibling set
- Increase in blocker reuse rate
- Reduction in tasks blocked only after max retries
- Fewer execution tasks auto-retrying on verification failures

---

## Acceptance Tests

### Test A: Shared Auth Blocker
1. Two execution leaves fail with same expired-session fingerprint
2. System creates/wakes one auth blocker
3. Sibling leaves stop consuming retries
4. Both leaves reference same blocker task ID/key

### Test B: Anti-Bot/Access Denial
1. First confirmed anti-bot fingerprint occurs
2. Executor does NOT requeue same path
3. Alternate route or human unblock task requested

### Test C: Missing Shared Input
1. Multiple tasks lack same approval token
2. One prerequisite task created
3. Additional failures attach to existing blocker

### Test D: Invalid State Transition
1. Execution task tries to mutate already-finalized resource
2. No same-path retry occurs
3. Task routes to refresh/replan or closes as superseded

### Test E: Verification Failure
1. Mutation appears to succeed but verification inconclusive
2. Task does not spend standard retry budget
3. Task escalates to review/verification work

### Test F: Dynamic Budgets by Task Kind
1. `artifact_only` task with tool outage gets >0 retries
2. `aggregate` task with dependency blocker gets 0 same-path retries
3. `execution` task with auth failure gets <=1 retry before blocker

### Test G: Repeated Cost Exhaustion
1. Same provider quota exhaustion hits multiple tasks in window
2. Global throttle / provider-switch path activated
3. Future dispatch deferred rather than burning leaf retries

---

## Implementation Order

1. Add fingerprint schema + deterministic classifier in executor
2. Persist metadata and outcome-log extensions
3. Add blocker promotion / wake semantics
4. Add per-task-kind retry policy table
5. Add dashboard aggregation + regression tests

This order ensures the system can first *see* repeated failure identity, then *route* it, then *enforce* differentiated budgets.

---

## Next Steps for Implementation

1. **Design:** Define exact TypeScript types for fingerprint schema
2. **Classifier:** Implement deterministic failure class assignment rules
3. **Policy:** Encode retry budget table in `core/retry-policy.ts`
4. **Integration:** Modify executor to generate fingerprints on failure
5. **Observability:** Add dashboard queries for failure clustering
6. **Testing:** Write acceptance tests A-G above
7. **Validation:** Deploy and verify sibling churn reduction

---

**Status:** Design complete, ready for implementation (Child 4 of T1710)
**Created:** 2026-03-13
**Last Updated:** 2026-03-13
**Parent Task:** T1712
**Implementation Task:** TBD (to be created as Child 4 of T1710)
