# Flexible Review Model Design

**Task:** T939
**Date:** 2026-03-09
**Author:** analyst (Iris)

## Problem Statement

All tasks currently flow through the same review pattern: `execution.active` → `review.ready` → single reviewer approves/rejects. This is rigid. Different tasks need different levels of scrutiny — trivial operational tasks waste cycles in full review, while critical architectural decisions may need multiple reviewers.

## Current Review Architecture

### Data Model (core/types.ts)

```typescript
interface ReviewConfig {
  required: boolean;       // Whether review is required at all
  attemptBudget: number;   // Max review rounds
  isolationRules: IsolationRule[]; // Context exclusions for reviewer
}

interface ReviewState {
  round: number;
  verdicts: ReviewVerdict[];
  status: "collecting" | "consensus" | "escalated";
}

interface ReviewVerdict {
  reviewer: AgentId;
  round: number;
  verdict: "approve" | "changes_requested" | "reject" | "needs_discussion";
  reasoning: string;
}
```

### Event Flow

1. Agent submits work → `PhaseTransition(execution.active → review.ready, "work_complete")`
2. Reviewer agent claims lease → `LeaseGranted` in review phase
3. Reviewer emits `ReviewVerdictSubmitted` with verdict
4. Middle layer evaluates policy → `ReviewPolicyMet(outcome: approved|changes_requested|escalated)`
5. On approved → `TaskCompleted` (terminal: done)
6. On changes_requested → `PhaseTransition(review.active → execution.ready, "changes_requested")`

### Validator Constraints

- `ReviewVerdictSubmitted` requires `review.active` state
- `ReviewPolicyMet` is middle-layer only, requires review phase
- `TaskCompleted` requires review phase when `reviewConfig !== null`; execution or review phase when `reviewConfig === null`
- Phase transitions from review: `changes_requested → execution.ready`, `wrong_approach → analysis.ready`, `needs_redecomp → analysis.ready`, `add_children → decomposition.ready`

### Key Observation

The infrastructure already supports multiple verdicts per round (`verdicts: ReviewVerdict[]`) and has `status: "collecting" | "consensus" | "escalated"`. The `ReviewPolicyMet` event is emitted by middle layer, not the reviewer — this means **the policy evaluation logic is already decoupled from verdict collection**. The system is designed for flexible review but the policy layer is underspecified.

## Proposed Design

### 1. Extended ReviewConfig

```typescript
interface ReviewConfig {
  required: boolean;
  attemptBudget: number;
  isolationRules: IsolationRule[];

  // NEW: Review strategy
  strategy: ReviewStrategy;
}

type ReviewStrategy =
  | { type: "none" }                          // Auto-approve on submit
  | { type: "single"; reviewer: ReviewerSpec }  // Current behavior
  | { type: "gate"; gates: ReviewGate[] }     // Sequential gates
  | { type: "quorum"; reviewers: ReviewerSpec[]; minApprovals: number } // Parallel
  ;

interface ReviewGate {
  name: string;
  reviewer: ReviewerSpec;
  optional: boolean;  // If true, skip on timeout/unavailability
}

type ReviewerSpec =
  | { kind: "agent"; agentId: AgentId }       // Specific agent
  | { kind: "role"; role: string }            // Any agent with this role
  | { kind: "parent" }                        // Parent task's assignee
  | { kind: "automated"; check: AutoCheck }   // Automated quality gate
  | { kind: "human"; userId: string }         // Human sign-off
  ;

type AutoCheck = "lint" | "test" | "schema_validate" | "custom";
```

### 2. Review Strategy Semantics

#### `none` — Auto-Complete

When a task with `strategy: { type: "none" }` transitions to `review.ready`:
- Middle layer immediately emits `ReviewPolicyMet(outcome: "approved")` + `TaskCompleted`
- No lease is granted in review phase
- Use case: Trusted agents, trivial operational tasks, child tasks where parent already validates

#### `single` — Current Behavior (Default)

Exactly matches current flow. One reviewer, one verdict needed.

Default when `reviewConfig.strategy` is omitted (backward-compatible).

#### `gate` — Sequential Gates

Gates are evaluated in order. Each gate must pass before the next begins.

```
gate[0]: automated/lint → pass → gate[1]: parent → pass → gate[2]: human/kelvin → approve
```

Middle layer tracks gate progress in `ReviewState`:
- New field: `currentGateIndex: number`
- When a verdict arrives, middle layer checks if current gate is satisfied
- If gate passes and more gates remain, lease is released and next reviewer is assigned
- If all gates pass, `ReviewPolicyMet(approved)`
- If any required gate fails, `ReviewPolicyMet(changes_requested)` or `ReviewPolicyMet(escalated)`

Use case: Code changes that need lint check → peer review → human approval.

#### `quorum` — Parallel Reviewers

Multiple reviewers evaluate simultaneously. A minimum number must approve.

```
reviewers: [agent/coder, agent/analyst, human/kelvin], minApprovals: 2
```

Middle layer tracks which reviewers have submitted verdicts:
- Grants leases to all eligible reviewers
- Counts approvals as verdicts arrive
- When `approvals >= minApprovals`, emits `ReviewPolicyMet(approved)`
- When remaining possible approvals < minApprovals, emits `ReviewPolicyMet(escalated)`

Use case: Critical architectural decisions, cross-cutting changes.

### 3. ReviewerSpec Resolution

#### `agent` — Direct Assignment
Lease granted to the specific agent ID. Same as current behavior.

#### `role` — Role-Based Assignment
Middle layer consults agent registry to find available agents with the matching role. Selects the least-loaded eligible agent. Supports load balancing across coder, coder-lite, etc.

#### `parent` — Context Review
Parent task's current `leasedTo` agent is the reviewer. If parent has no active session, the parent's assignee field is used. This is the "key insight" from the task description — the parent knows WHY the child was created.

**Mechanical flow:**
1. Child reaches `review.ready`
2. Middle layer resolves `parent` spec → parent's assignee agent
3. Grants review lease to that agent
4. Agent reviews child with full parent context
5. No need for checkpoint/wake mechanism — the parent's agent identity is used, not the parent's session

#### `automated` — Quality Gates
Middle layer runs the specified check without granting a lease:
- `lint`: Run project linter against changed files
- `test`: Run test suite
- `schema_validate`: Validate output against schema
- `custom`: Run script specified in task metadata

Emits `ReviewVerdictSubmitted` with `reviewer: "system:<check>"` and pass/fail verdict.

#### `human` — Human Sign-Off
Lease is not granted to any agent. Task stays in `review.ready` until a human uses the dashboard or CLI to submit a verdict. Dashboard already has status controls on task detail pages.

### 4. Data Model Changes

#### Extend `ReviewConfig` (core/types.ts)

Add `strategy` field. Make it optional with fallback to current single-reviewer behavior:

```typescript
interface ReviewConfig {
  required: boolean;
  attemptBudget: number;
  isolationRules: IsolationRule[];
  strategy?: ReviewStrategy;  // Optional; absent = single reviewer (backward-compatible)
}
```

#### Extend `ReviewState` (core/types.ts)

```typescript
interface ReviewState {
  round: number;
  verdicts: ReviewVerdict[];
  status: "collecting" | "consensus" | "escalated";
  currentGateIndex?: number;     // For gate strategy
  gateResults?: GateResult[];    // Track per-gate outcomes
}

interface GateResult {
  gateName: string;
  verdict: "approve" | "reject" | "skipped";
  reviewer: AgentId;
  timestamp: Timestamp;
}
```

#### No Changes to Events

`ReviewVerdictSubmitted` and `ReviewPolicyMet` are already general enough. The middle layer policy evaluation logic is where strategy interpretation happens — no new event types needed.

### 5. Validator Changes

- `ReviewVerdictSubmitted`: No change (still requires review.active)
- `TaskCompleted` with `strategy: { type: "none" }`: Allow from execution phase directly (skip review)
- `TaskCreated`: Validate `strategy` shape if present

### 6. Middle Layer Policy Evaluation

The key change is in the middle layer's review policy evaluation (the code that emits `ReviewPolicyMet`). Currently it's a simple "one approve = done" check. New logic:

```
function evaluateReviewPolicy(task, latestVerdict):
  strategy = task.reviewConfig?.strategy ?? { type: "single", reviewer: { kind: "agent", agentId: task.reviewer } }

  switch strategy.type:
    case "none":
      → emit ReviewPolicyMet(approved)

    case "single":
      → if latestVerdict.verdict == "approve": emit ReviewPolicyMet(approved)
      → else: emit ReviewPolicyMet(changes_requested)

    case "gate":
      → check if current gate is satisfied
      → if yes and more gates: advance currentGateIndex, assign next reviewer
      → if yes and no more gates: emit ReviewPolicyMet(approved)
      → if no: emit ReviewPolicyMet(changes_requested) or escalated

    case "quorum":
      → count approvals across all verdicts
      → if approvals >= minApprovals: emit ReviewPolicyMet(approved)
      → if remaining reviewers can't reach minApprovals: emit ReviewPolicyMet(escalated)
```

### 7. CLI Changes

The `task` CLI needs:
- `task create --review-strategy none|single|gate|quorum` flag
- `task show` displays review strategy info
- Decomposition child spec already has `reviewConfig` — strategy flows through

### 8. Defaults and Migration

| Scenario | Default Strategy |
|----------|-----------------|
| `reviewConfig: null` | No review (current: TaskCompleted from execution) |
| `reviewConfig: { required: true }` (no strategy) | `single` with task's `reviewer` field |
| Parent decomposing children | Inherit parent's strategy unless overridden |
| Human-created tasks | `single` (backward-compatible) |

**Migration:** Zero-breaking-change. The `strategy` field is optional. Absent strategy falls back to current single-reviewer behavior. Existing persisted events remain valid. New field only matters for newly created tasks.

### 9. Decompose Integration

When a parent decomposes, it can set review strategy per child:

```typescript
// Example: parent sets children to context-review
children: [{
  title: "Implement feature X",
  reviewConfig: {
    required: true,
    attemptBudget: 3,
    isolationRules: [],
    strategy: {
      type: "gate",
      gates: [
        { name: "automated", reviewer: { kind: "automated", check: "lint" }, optional: false },
        { name: "parent-context", reviewer: { kind: "parent" }, optional: false },
      ]
    }
  }
}]
```

This enables the "parent as context reviewer" pattern directly.

### 10. Implementation Phases

| Phase | Scope | Effort |
|-------|-------|--------|
| **Phase 1** | Add `strategy` to `ReviewConfig` type + validator + backward-compat defaults | Small |
| **Phase 2** | Implement `none` strategy in middle layer (auto-approve) | Small |
| **Phase 3** | Implement `parent` reviewer spec resolution | Medium |
| **Phase 4** | Implement `gate` strategy with sequential evaluation | Medium |
| **Phase 5** | Implement `quorum` strategy with parallel evaluation | Medium |
| **Phase 6** | Implement `automated` reviewer spec (lint/test checks) | Medium |
| **Phase 7** | CLI flags + dashboard display | Small |

Phases 1-3 cover the highest-value use cases. Phases 4-7 can be deferred.

## Appendix: Answering Design Questions

1. **How to express review config per task?** — Extend existing `ReviewConfig` with optional `strategy` field. Fully backward-compatible.

2. **How do multiple reviewers work?** — Two modes: `gate` (sequential, all must pass) and `quorum` (parallel, N-of-M must approve). Middle layer tracks progress in `ReviewState`.

3. **How does "context review by parent" work?** — `ReviewerSpec { kind: "parent" }` resolves to parent's assignee. No checkpoint/wake needed — the review lease is simply granted to the parent's agent. The agent reviews with its standard context.

4. **How do automated quality checks integrate?** — As `ReviewerSpec { kind: "automated", check: "lint" }`. Can be a standalone strategy (`single` with automated reviewer) or a gate in a `gate` strategy. Middle layer executes the check and emits a synthetic `ReviewVerdictSubmitted`.

5. **Default when no config?** — `reviewConfig: null` means no review (skip to done). `reviewConfig` present without `strategy` means single-reviewer (current behavior). Both are backward-compatible.

6. **Interaction with decompose?** — `DecompositionChildSpec` already has `reviewConfig`. Strategy is set per-child. Recommendation: parent sets `{ kind: "parent" }` on children by default for context review.
