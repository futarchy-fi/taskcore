# T1710 — Capability-First Orchestration Hardening

## Executive recommendation

This program is **too large and cross-cutting to execute as a single task**. It should be decomposed into ordered child tasks with one parent artifact that fixes the architecture, sequencing, and acceptance criteria.

The failure pattern is not "one bug". It is a systems problem caused by trying to decompose and execute uncertain missions **before** the system knows:
- what capabilities are actually available,
- which prerequisites are missing,
- which steps are reversible vs. irreversible,
- how partial progress should be preserved,
- when repeated failure should trigger a strategy change instead of more retries.

## Problem framing

The target workflow class has five characteristics:
1. **High uncertainty at start** — entity matching, environment state, or account status may be unknown.
2. **Browser-mediated execution** — progress depends on live UI state, auth, and fragile selectors.
3. **Partially irreversible actions** — clicks, submissions, trades, messages, or confirmations may have consequences.
4. **Mixed research + execution** — discovery work is often bundled with deterministic action steps.
5. **Infrastructure noise** — browser relay, auth state, tool health, and mutation-path failures create false task churn.

If the orchestrator treats these as ordinary deterministic tasks, it creates the same failure loop:
- decompose too early,
- assign execution before readiness,
- lose partial findings in review/aggregate handoffs,
- retry the same failing path,
- escalate risk near irreversible steps.

## Strategic design principles

### 1. Capability-first before decomposition
Before generating child tasks, the system should produce a **mission capability snapshot**:
- available tools and runtimes,
- authenticated systems/accounts,
- browser availability and attachment state,
- permission constraints,
- verification channels,
- human-approval requirements,
- known blockers.

If readiness is low, the system should create **prerequisite tasks** first, not execution tasks.

### 2. Separate discovery from deterministic execution
A mission should not begin with an execution plan when the main unknown is still identification, feasibility, auth, or state verification.

Use two lanes:
- **Discovery lane**: identify entities, inspect environment, map options, and gather evidence.
- **Execution lane**: perform deterministic, validated steps only after inputs are stable.

This preserves operator clarity and reduces bogus "execution failures" that are really unresolved discovery problems.

### 3. Preserve partial progress as first-class artifacts
When a child task uncovers verified facts but cannot finish the end-to-end mission, that output must survive reviews, retries, and replanning.

Required artifact types:
- capability snapshots,
- matched entities / rejected candidates,
- prerequisite checklist state,
- evidence bundles,
- environment fingerprints,
- execution-ready plans,
- approval packets for irreversible actions.

The parent should aggregate these artifacts instead of forcing children into a binary success/fail shape.

### 4. Fingerprint failure modes, then switch strategy
Repeated retries are only rational if the failure mode is transient. The orchestrator should classify failures into buckets such as:
- auth missing/expired,
- browser relay unattached,
- selector / UI drift,
- external system ambiguity,
- runtime/tool unavailable,
- mutation accepted but verification unavailable,
- approval required but not granted.

Each class needs a defined next action: retry, reroute, decompose prerequisite, request approval, or stop.

### 5. Approval-gated lane for irreversible actions
Irreversible or safety-sensitive actions should require a specific lane with:
- explicit action summary,
- preconditions satisfied,
- target/entity verified,
- rollback possibilities documented,
- approval token or human confirmation captured,
- post-action verification defined.

This should not share the same semantics as low-risk research tasks.

## Proposed decomposition

### Child 1 — Mission capability registry and readiness model
**Goal:** define machine-readable representation of capabilities, prerequisites, and readiness scoring.  
**Output:** schema + readiness levels + examples + integration points.

### Child 2 — Execution preflight and prerequisite detection
**Goal:** build the gate that runs before decomposition/execution to detect missing auth, tools, browser state, permissions, and verification channels.  
**Output:** preflight rules, fail-fast decisions, prerequisite task generation rules.

### Child 3 — Grounding and uncertain-entity evaluation framework
**Goal:** handle missions where the target entity, account, page, or record is uncertain.  
**Output:** match confidence model, evidence requirements, safe stopping conditions.

### Child 4 — Failure fingerprinting and strategy switching
**Goal:** stop naive retry loops and route repeated failures to the right next strategy.  
**Output:** failure taxonomy, retry budgets, switching rules, observability requirements.  
**Design artifact:** `docs/ops/t1712-failure-fingerprinting-strategy-switching.md`

### Child 5 — Approval-gated irreversible-action lane
**Goal:** create a separate workflow for steps with material consequences.  
**Output:** approval packet schema, gate conditions, execution/verification semantics.

### Child 6 — Aggregate policy and artifact-first closure semantics
**Goal:** preserve partial progress through review and parent aggregation.  
**Output:** child completion semantics, artifact contract, parent merge rules, review checklist.

### Child 7 — Cross-repo implementation and validation plan
**Goal:** map where changes belong across taskcore and colony, sequence rollout, and define tests.  
**Output:** implementation order, repo ownership, migration plan, acceptance tests.

## Ordering recommendation

Recommended execution order:
1. Capability registry and readiness model
2. Execution preflight and prerequisite detection
3. Grounding / uncertain-entity evaluation
4. Failure fingerprinting and strategy switching
5. Approval-gated lane for irreversible actions
6. Aggregate policy and artifact-first closure semantics
7. Cross-repo implementation and validation plan

Rationale:
- readiness and preflight are foundation layers,
- grounding determines whether execution should even begin,
- failure handling is only useful after readiness semantics exist,
- approval gating depends on stable preconditions and verification semantics,
- aggregate closure should be shaped after artifact types are defined,
- implementation planning should be last so it reflects the final architecture.

## Acceptance criteria for the parent task

T1710 should only be considered complete when it produces:
- a parent architecture memo with the final system model,
- child tasks covering all six functional areas plus rollout/validation,
- explicit artifact contracts between children,
- a recommended order of implementation,
- concrete acceptance tests for the integrated workflow.

## What not to do

- Do **not** patch a single historical workflow.
- Do **not** encode browser-specific hacks as general orchestration policy.
- Do **not** collapse discovery, execution, and approval into one task type.
- Do **not** use success/failure alone as the parent aggregation model.
- Do **not** allow irreversible execution without explicit preconditions and approval semantics.

## Immediate next move

Decompose T1710 into the ordered child tasks above, using domain-agnostic language and artifact-focused outputs. The parent remains responsible for the integrated architecture and rollout sequence.
