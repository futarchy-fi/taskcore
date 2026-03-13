# T1712 — Failure Fingerprinting, Strategy Switching, and Dynamic Retry Budgets

**Parent initiative:** [T1710 capability-first orchestration hardening plan](./t1710-capability-first-orchestration-hardening-plan.md)

## Why this exists

Repeated execution failures should not burn through retries on every sibling leaf when the underlying problem is shared. We need a canonical way to describe failures, detect when the same blocker is recurring, route that blocker to the right recovery lane, and vary retry behavior by task kind.

This document defines:

1. a canonical failure fingerprint schema
2. routing scopes for when a failure should stay local vs pause a wider slice of work
3. blocker-promotion rules for shared prerequisites
4. dynamic retry and budget policies by task kind and failure class
5. strategy-switching rules so the system reprioritizes recovery work instead of repeating blind execution

## Goals

- Detect repeated infrastructure and workflow failures across sibling tasks.
- Convert repeated blockers into shared prerequisite work when appropriate.
- Preserve useful partial progress while stopping wasteful retries.
- Apply stricter retry budgets to artifact-only and aggregate tasks than to exploratory execution.
- Produce machine-friendly artifacts that can be attached to incidents, blockers, and reviews.

## Non-goals

- Replacing domain-specific business logic for a given workflow.
- Fully automating root-cause analysis for every failure.
- Defining UI details for incident dashboards.

## Canonical fingerprint schema

Every execution, verification, or review failure that is eligible for retry should emit a normalized fingerprint.

```json
{
  "fingerprintVersion": 1,
  "class": "auth_session_failure",
  "scope": "workflow",
  "layer": "browser",
  "operation": "checkout.submit_order",
  "resource": "target:example.com",
  "normalizedMessage": "session expired before submit",
  "evidence": {
    "httpStatus": 401,
    "providerCode": "SESSION_EXPIRED",
    "domMarker": "text=Sign in",
    "verifier": "submit-order-check"
  },
  "retryHint": "refresh_credentials",
  "safetyImpact": "blocked",
  "reversible": true,
  "hash": "sha256:..."
}
```

### Required fields

| Field | Meaning |
| --- | --- |
| `fingerprintVersion` | Schema version for future migrations. |
| `class` | Canonical failure family. |
| `scope` | Blast radius candidate: leaf, workflow, account, environment, or global. |
| `layer` | Where the failure occurred: planner, browser, API, verifier, budget, human approval, etc. |
| `operation` | Normalized operation name, not raw prompt text. |
| `resource` | Shared dependency identifier when relevant, such as account, browser target, API host, or environment. |
| `normalizedMessage` | Stable summary with volatile tokens removed. |
| `evidence` | Structured supporting facts used for dedupe and triage. |
| `retryHint` | Recommended immediate recovery lane. |
| `safetyImpact` | `none`, `degraded`, `blocked`, or `irreversible_risk`. |
| `reversible` | Whether retrying is safe without additional approval. |
| `hash` | Stable digest computed from class, scope, layer, operation, resource, and normalized evidence. |

### Canonical classes

| Class | Typical examples | Default scope | Default lane |
| --- | --- | --- | --- |
| `auth_session_failure` | expired login, revoked token, MFA timeout | account | blocker-removal |
| `access_denied` | anti-bot wall, permission denied, 403, geofence | workflow | blocker-removal |
| `missing_input` | missing credential, absent attachment, unanswered question | leaf | request-input |
| `invalid_state_transition` | page/app state does not match expected precondition | workflow | re-plan |
| `verification_failure` | verifier rejects output or cannot prove completion | leaf | fix-and-retry |
| `budget_exhaustion` | retries or budget consumed before stable progress | workflow | escalate-plan |
| `environment_failure` | browser crash, network outage, provider outage | environment | pause-and-recover |
| `human_approval_missing` | irreversible step waiting for human gate | workflow | hold-for-approval |

### Normalization rules

To avoid false uniqueness, the fingerprint hash should exclude volatile values such as:

- timestamps
- request IDs
- random DOM IDs
- stack trace line numbers
- full URLs when only the hostname/path pattern matters
- exact screenshot filenames

Normalization should preserve facts that matter for routing:

- HTTP status family
- verifier name
- normalized page state markers
- workflow operation name
- shared resource identifier
- irreversible vs reversible safety posture

## Routing scopes

A fingerprint's `scope` determines how broadly the system should search for impacted work.

| Scope | Meaning | Routing action |
| --- | --- | --- |
| `leaf` | Local to a single task instance | Retry or re-plan only the current leaf. |
| `workflow` | Affects sibling leaves in the same parent workflow | Pause matching siblings and create/wake shared blocker task. |
| `account` | Affects all work sharing credentials/account context | Pause tasks using same account/resource key. |
| `environment` | Affects a browser pool, host, API provider, or shared runtime | Pause all tasks bound to that environment until recovered. |
| `global` | Systemic issue or policy gate | Escalate immediately; avoid automatic retries. |

### Routing rules

1. **Leaf-only failures** stay local unless they repeat across siblings with the same `resource` and `operation`.
2. **Workflow/account/environment failures** should query for active tasks with the same fingerprint hash or matching `(class, resource)` pair.
3. If a shared blocker already exists for the same fingerprint family, **wake or re-open** it rather than creating duplicates.
4. If a failure carries `safetyImpact = irreversible_risk`, switch to a human approval or planning lane before any retry.

## Blocker promotion rules

Blocker promotion converts repeated failures into prerequisite work.

### Promotion triggers

Promote to blocker-removal work when any of the following is true:

- the same fingerprint hash appears **2 times** within the same parent workflow
- the same `(class, resource)` appears across **3 or more sibling leaves**
- a single failure has `scope` of `account`, `environment`, or `global`
- an execution leaf exhausts its retry budget on a failure whose `retryHint` is not `retry_same_step`
- verifier failures indicate a shared artifact contract or infrastructure issue rather than leaf-specific content

### Promotion output

The promoted blocker task should capture:

```json
{
  "kind": "blocker_removal",
  "title": "Resolve auth_session_failure for target:example.com",
  "fingerprintHash": "sha256:...",
  "class": "auth_session_failure",
  "scope": "account",
  "resource": "target:example.com",
  "impactedTasks": ["T2001", "T2002"],
  "recoveryLane": "refresh_credentials",
  "wakeOnResolution": true
}
```

### Promotion effects

When promotion fires:

1. pause or mark dependent leaves as waiting on the blocker
2. stop auto-retrying matching siblings
3. create or wake one shared blocker task
4. attach the fingerprint artifact to the blocker and impacted leaves
5. schedule follow-up only after the blocker is resolved or explicitly waived

## Strategy switching

Retrying is only one of several recovery strategies. The fingerprint should choose the next lane.

| Failure class | Default next strategy |
| --- | --- |
| `auth_session_failure` | refresh credentials / re-auth before resuming leaves |
| `access_denied` | investigate anti-bot/access policy; do not retry siblings blindly |
| `missing_input` | request input or synthesize a collection subtask |
| `invalid_state_transition` | re-plan from observed state; possibly downgrade assumptions |
| `verification_failure` | inspect artifact/output and regenerate with stronger verification hints |
| `budget_exhaustion` | escalate to planner with summary of failed attempts and alternatives |
| `environment_failure` | switch browser/provider/runtime or wait for recovery |
| `human_approval_missing` | hold for approval, no automatic retries |

### Switching guardrails

- Never switch into an irreversible execution lane without confirming approval state.
- When the alternative strategy changes required capabilities, force a new capability assessment.
- Preserve evidence from all failed attempts so the next strategy starts with context.

## Dynamic retry and budget policy

Retry budgets should vary by task kind and failure class.

### Task kinds

| Task kind | Description |
| --- | --- |
| `execution` | Deterministic or partially deterministic action in an external system |
| `aggregate` | Gathers or merges child outputs; should preserve partial progress |
| `artifact_only` | Produces or edits docs/artifacts without external side effects |
| `blocker_removal` | Resolves shared prerequisites |
| `verification` | Confirms that a task's output meets acceptance criteria |

### Retry budget matrix

| Task kind | Transient infra (`environment_failure`) | Shared blocker (`auth_session_failure`, `access_denied`) | Planning/input (`missing_input`, `invalid_state_transition`) | Verification/content (`verification_failure`) | Budget exhaustion |
| --- | --- | --- | --- | --- | --- |
| `execution` | 2 immediate retries, then switch environment | 1 local retry max, then promote blocker | 1 retry after re-plan/input refresh | 1 fix-and-retry cycle | escalate immediately |
| `aggregate` | 1 retry after dependency health check | 0 direct retries; wait on blocker | re-plan once with preserved partials | 1 recompute after child repair | escalate immediately |
| `artifact_only` | 1 retry if tooling failed | 0 blocker retries unless dependency is local tooling | 2 retries with clarified prompt/spec | 2 revision cycles | escalate after second exhaustion |
| `blocker_removal` | 2 retries with alternate method/provider | 2 attempts before human escalation | 1 retry after missing prerequisite is gathered | 1 verification rerun | escalate immediately |
| `verification` | 1 rerun with fresh evidence | 0 retries; route to blocker | 1 re-verify after state refresh | 1 manual/alternate verifier pass | escalate immediately |

### Budget principles

- **Execution leaves** get a small number of direct retries because some failures are transient, but they should pivot quickly to blocker removal.
- **Aggregate tasks** should protect accumulated child output and avoid consuming retries on a bad dependency.
- **Artifact-only tasks** can tolerate more revision cycles because they are cheap and reversible.
- **Verification failures** should trigger stronger evidence capture rather than repeated blind checks.

## Incident and audit artifacts

Every promoted blocker or escalation should persist a compact artifact:

```json
{
  "taskId": "T2001",
  "fingerprintHash": "sha256:...",
  "class": "verification_failure",
  "scope": "leaf",
  "attempt": 2,
  "nextStrategy": "fix_and_retry",
  "relatedBlockerTaskId": null,
  "capturedAt": "2026-03-13T10:00:00Z"
}
```

Minimum audit payload:

- task ID and attempt number
- fingerprint hash and canonical class
- normalized evidence
- chosen next strategy
- whether a blocker was created or reused
- why automatic retries stopped or continued

## Acceptance criteria

This design is implemented successfully when:

1. repeated identical failures no longer consume blind retries across many siblings
2. shared blockers are promoted to prerequisite tasks when routing rules match
3. retry policy differs for execution, aggregate, and artifact-only tasks
4. incidents and blockers can reference stable fingerprint hashes
5. strategy switches preserve evidence and partial progress instead of restarting from scratch

## Recommended implementation order

1. add fingerprint schema + hashing utility
2. emit fingerprints from execution and verification failure paths
3. index active failures by `(hash, class, resource, scope)`
4. add blocker promotion and sibling pause/wake behavior
5. wire retry matrix into task-kind-specific policy evaluation
6. emit incident artifacts and reviewer-facing summaries

## Open questions

- Should fingerprint hashes include capability profile/version so planner changes do not over-dedupe unrelated failures?
- Do we want per-provider routing scopes in addition to environment scope?
- When a blocker is waived manually, should matching leaves resume automatically or require explicit review?
