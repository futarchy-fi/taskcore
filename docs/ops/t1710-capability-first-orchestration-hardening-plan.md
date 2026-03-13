# T1710 — Capability-First Orchestration Hardening Plan

This document is the parent design index for the orchestration-hardening program. It exists to keep the child designs connected and to make implementation order explicit.

## Program goals

The hardening effort aims to:

- require capability assessment before workload decomposition
- preserve partial progress through aggregate and review flows
- separate discovery from deterministic execution
- improve repeated failure handling and blocker recovery
- gate irreversible actions behind stronger approval controls

## Design slices

### Capability-gated decomposition

Before decomposing work, the planner should assess whether the workflow is:

- tool-complete
- input-complete
- approval-complete
- safe to execute incrementally

Tasks that fail capability assessment should produce research, blocker-removal, or approval-gathering work instead of execution leaves.

### Aggregate-safe progress preservation

Parents and aggregate tasks should retain verified child output even when some siblings block, fail, or need replanning. Completion policy must distinguish between:

- content completion
- infrastructure blockers
- explicit best-effort closure

### Failure fingerprinting and strategy switching

Repeated failures should route to shared blocker-removal work instead of consuming retries independently across sibling leaves.

- Design artifact: [T1712 — Failure Fingerprinting, Strategy Switching, and Dynamic Retry Budgets](./t1712-failure-fingerprinting-strategy-switching.md)
- Key outputs: canonical fingerprint schema, routing scopes, blocker promotion rules, and task-kind-specific retry budgets

### Approval-gated irreversible actions

Irreversible or high-risk operations should only be scheduled onto explicit approval lanes with preserved context, reversible dry-run options when possible, and clear operator checkpoints.

## Implementation order

1. capability assessment contracts and task-kind distinctions
2. aggregate-safe completion and partial-progress policies
3. failure fingerprinting, strategy switching, and retry budgets
4. approval-gated irreversible execution lane
5. incident/reporting polish and operator-facing summaries

## Review checklist

Use this checklist when reviewing child designs against the parent plan:

- Does the design reduce blind retries or unsafe execution?
- Does it preserve partial progress and evidence?
- Does it create reusable abstractions instead of workflow-specific patches?
- Does it define routing or policy behavior precisely enough to implement?
- Does it fit into the implementation order without hidden prerequisites?
