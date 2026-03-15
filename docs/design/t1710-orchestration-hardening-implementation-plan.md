# T1710 — Orchestration Hardening: Implementation Plan

## Context

This document implements the decomposition strategy outlined in [t1710-capability-first-orchestration-hardening-plan.md](../ops/t1710-capability-first-orchestration-hardening-plan.md).

## Child Tasks

The orchestration hardening program is decomposed into 7 ordered child tasks:

### 1. Child Task: Mission Capability Registry and Readiness Model

**Task ID:** TBD
**Title:** Mission capability registry and readiness model
**Kind:** design
**Cost:** 50.00
**Output:** Schema + readiness levels + examples + integration points

**Description:**
Define a machine-readable representation of capabilities, prerequisites, and readiness scoring for TaskCore.

**Deliverables:**
- Capability schema definition (TypeScript types)
- Readiness level enumeration with thresholds
- Example capability snapshots
- Integration points in TaskCore core and middle layers
- Unit tests for schema validation

**Dependencies:** None

**Acceptance Criteria:**
- [ ] Capability schema is defined in `core/types.ts` or new `core/capability.ts`
- [ ] Readiness scoring algorithm is implemented
- [ ] Examples demonstrate all readiness levels
- [ ] Integration points are documented

---

### 2. Child Task: Execution Preflight and Prerequisite Detection

**Task ID:** TBD
**Title:** Execution preflight and prerequisite detection
**Kind:** execution
**Cost:** 75.00
**Output:** Preflight rules, fail-fast decisions, prerequisite task generation rules

**Description:**
Build the gate that runs before decomposition/execution to detect missing auth, tools, browser state, permissions, and verification channels.

**Deliverables:**
- Preflight check system in TaskCore core
- Fail-fast decision logic
- Automatic prerequisite task generation
- Integration with capability registry

**Dependencies:** Child 1 (Capability registry)

**Acceptance Criteria:**
- [ ] Preflight checks run before task dispatch
- [ ] Missing prerequisites trigger automatic task creation
- [ ] Fail-fast decisions are logged and observable
- [ ] Integration tests verify prerequisite detection

---

### 3. Child Task: Grounding and Uncertain-Entity Evaluation Framework

**Task ID:** TBD
**Title:** Grounding and uncertain-entity evaluation framework
**Kind:** execution
**Cost:** 75.00
**Output:** Match confidence model, evidence requirements, safe stopping conditions

**Description:**
Handle missions where the target entity, account, page, or record is uncertain.

**Deliverables:**
- Entity matching confidence model
- Evidence collection framework
- Safe stopping condition logic
- Integration with analysis agents

**Dependencies:** Child 1 (Capability registry)

**Acceptance Criteria:**
- [ ] Entity matching confidence is quantified
- [ ] Evidence requirements are enforced
- [ ] Safe stopping conditions prevent harmful retries
- [ ] Uncertainty is surfaced in task metadata

---

### 4. Child Task: Failure Fingerprinting and Strategy Switching

**Task ID:** TBD
**Title:** Failure fingerprinting and strategy switching
**Kind:** execution
**Cost:** 100.00
**Output:** Failure taxonomy, retry budgets, switching rules, observability requirements
**Design Artifact:** [t1712-failure-fingerprinting-strategy-switching.md](../ops/t1712-failure-fingerprinting-strategy-switching.md)

**Description:**
Stop naive retry loops and route repeated failures to the right next strategy. Implement the failure fingerprinting system defined in T1712.

**Deliverables:**
- Failure fingerprint schema in TaskCore core
- Failure classifier (deterministic rules)
- Strategy switching logic
- Per-task-kind retry budget policies
- Metadata extensions for tracking failures
- Executor outcome log extensions
- Dashboard observability surfaces

**Dependencies:** Child 1 (Capability registry), Child 2 (Preflight)

**Acceptance Criteria:**
- [ ] Failure fingerprints are generated for all task failures
- [ ] Shared blocker promotion works correctly
- [ ] Retry budgets are enforced per task kind and failure class
- [ ] Dashboard surfaces failure clusters and retry metrics
- [ ] All acceptance tests from T1712 pass

---

### 5. Child Task: Approval-Gated Irreversible-Action Lane

**Task ID:** TBD
**Title:** Approval-gated irreversible-action lane
**Kind:** execution
**Cost:** 75.00
**Output:** Approval packet schema, gate conditions, execution/verification semantics

**Description:**
Create a separate workflow for steps with material consequences.

**Deliverables:**
- Approval packet schema
- Lane-specific gate conditions
- Execution semantics for irreversible actions
- Verification requirements
- Human approval capture flow

**Dependencies:** Child 1 (Capability registry), Child 2 (Preflight), Child 4 (Failure fingerprinting)

**Acceptance Criteria:**
- [ ] Irreversible actions require explicit approval
- [ ] Approval packets capture all required context
- [ ] Gate conditions prevent unsafe execution
- [ ] Verification is required post-action

---

### 6. Child Task: Aggregate Policy and Artifact-First Closure Semantics

**Task ID:** TBD
**Title:** Aggregate policy and artifact-first closure semantics
**Kind:** execution
**Cost:** 75.00
**Output:** Child completion semantics, artifact contract, parent merge rules, review checklist

**Description:**
Preserve partial progress through review and parent aggregation.

**Deliverables:**
- Child task completion semantics (artifact-focused)
- Artifact contract specification
- Parent merge rules for partial progress
- Review checklist for aggregate tasks
- Integration with TaskCore reducer

**Dependencies:** Child 1 (Capability registry), Child 4 (Failure fingerprinting)

**Acceptance Criteria:**
- [ ] Partial progress is preserved as artifacts
- [ ] Parent tasks aggregate child artifacts correctly
- [ ] Review process handles incomplete child work
- [ ] Binary success/fail is replaced with artifact-based closure

---

### 7. Child Task: Cross-Repo Implementation and Validation Plan

**Task ID:** TBD
**Title:** Cross-repo implementation and validation plan
**Kind:** execution
**Cost:** 100.00
**Output:** Implementation order, repo ownership, migration plan, acceptance tests

**Description:**
Map where changes belong across taskcore and colony, sequence rollout, and define tests.

**Deliverables:**
- Implementation order document
- Repo ownership matrix (taskcore vs colony)
- Migration plan from current system
- Comprehensive acceptance test suite
- Rollback strategy

**Dependencies:** Children 1-6 (all design and execution work complete)

**Acceptance Criteria:**
- [ ] Implementation order is sequenced and documented
- [ ] Repo ownership is clear for all components
- [ ] Migration path is defined and tested
- [ ] Acceptance tests cover all 6 child areas
- [ ] Rollback strategy is validated

---

## Recommended Execution Order

The child tasks must be executed in this order:

1. **Child 1:** Mission capability registry and readiness model
2. **Child 2:** Execution preflight and prerequisite detection
3. **Child 3:** Grounding / uncertain-entity evaluation
4. **Child 4:** Failure fingerprinting and strategy switching
5. **Child 5:** Approval-gated lane for irreversible actions
6. **Child 6:** Aggregate policy and artifact-first closure semantics
7. **Child 7:** Cross-repo implementation and validation plan

### Rationale

- **Readiness and preflight (1-2)** are foundation layers that everything else depends on
- **Grounding (3)** determines whether execution should even begin for uncertain missions
- **Failure handling (4)** is only useful after readiness semantics exist
- **Approval gating (5)** depends on stable preconditions and verification semantics
- **Aggregate closure (6)** should be shaped after artifact types are defined
- **Implementation planning (7)** should be last so it reflects the final architecture

---

## Parent Task Acceptance Criteria

T1710 (the parent orchestration hardening program) should only be considered complete when:

- [x] Parent architecture memo exists (t1710 document)
- [x] Child tasks covering all six functional areas are defined (this document)
- [ ] Explicit artifact contracts between children are implemented
- [ ] Recommended order of implementation is followed
- [ ] Concrete acceptance tests for the integrated workflow exist (Child 7)

---

## Repository Ownership

| Component | Repo | Notes |
|-----------|------|-------|
| Capability registry types | core | `core/capability.ts` |
| Preflight checks | core | `core/preflight.ts` |
| Failure fingerprinting | core | `core/fingerprint.ts` |
| Retry budget policies | core | `core/retry-policy.ts` |
| Approval gating | core | `core/approval.ts` |
| Aggregate semantics | core | `core/aggregate.ts` |
| Executor integration | middle | `middle/executor.ts` |
| Dashboard integration | colony | `data/task-dashboard/` |
| Design artifacts | colony | `docs/ops/` |

---

## Next Steps

1. Create Child 1 task: "Mission capability registry and readiness model"
2. Claim Child 1 and begin implementation
3. Execute children in order 1-7
4. Update this document as implementation progresses
5. Close T1710 when all children complete with validated artifacts

---

**Document Status:** Implementation plan ready for execution
**Created:** 2026-03-13
**Last Updated:** 2026-03-13
**Parent Task:** T1710 (Capability-First Orchestration Hardening)
