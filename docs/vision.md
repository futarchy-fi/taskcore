# Taskcore Vision

## Goal

Build an autonomous agent orchestration system where a fleet of AI agents
continuously works on a large, evolving task tree — decomposing, executing,
reviewing, and learning — with humans providing steering, review, and
unblocking at key checkpoints.

Humans should wake up to hundreds of completed tasks and an "inbox" of items
that need their attention: reviews to approve, questions to answer, decisions
to make, results to be informed about.

## Core Metaphor: Depth-First Search Over (agent_state, repo_state)

The system performs a search over the joint space of agent context and
repository state. Each task attempt is a path in this search:

- **Successful paths** produce deliverables (code, analysis, artifacts) that
  get merged into the main line.
- **Failed paths** get reverted — the workspace and journal state rolls back
  to before the failed attempt. Only a compact failure summary survives,
  extracted before the revert.
- **Failure summaries are heuristics** — they live outside the search tree
  and guide future attempts. They answer: "what did we try, why did it fail,
  what should we do differently?"

This is inspired by midpoint-agi's approach to recursive task decomposition
with rollback.

## Task Lifecycle

```
                    +---> decompose ---> children (recursive)
                    |
create ---> analysis ---> execute ---> review ---> done
                    |                     |
                    +---> block           +---> request-changes ---> execute (retry)
```

1. **Analysis**: An agent examines the task, reads context (parent journal,
   sibling failures, previous approaches), and decides: execute directly,
   decompose into subtasks, or block.
2. **Execution**: An agent does the work in an isolated workspace (git
   worktree). Progress is checkpointed as git commits.
3. **Review**: A different agent or human reviews the work. They see the
   journal, code diff, and evidence. They approve or request changes.
4. **Decomposition**: Complex tasks are broken into children. Each child
   follows the same lifecycle recursively.

### Parent Re-analysis After Children Complete

When a task is decomposed, each child follows the full lifecycle. The parent
does not simply wait for all children and auto-complete. Instead:

- As each child completes, the parent can be re-analyzed to check whether
  the overall direction is still correct (checkpoint gating).
- Once all children are done, the parent returns to analysis to verify the
  aggregate result meets the original goal.
- The parent then proceeds to review — there is always review at every level
  of the tree.

Initially, re-analysis happens at every child completion (conservative). Over
time, we learn when it's safe to skip intermediate checkpoints (e.g., when
all children are independent and low-risk).

### No Depth Limit

There is no hardcoded limit on decomposition depth or breadth. The cost
budget system provides a natural bound — each decomposition allocates cost
from the parent's budget to children, so deep trees eventually exhaust their
allocation. Humans (or high-authority agents) can add more budget to continue.

## Workspace Isolation for Tasks

Taskcore provides isolated workspaces for each task:

- **Code worktree**: A git worktree of the target repo on a task-specific
  branch (`task/T{id}`). Code changes are isolated — no cross-task
  contamination. On success, the branch becomes a PR. On failure, it gets
  discarded (the failure summary is extracted first).
- **Journal worktree**: A git worktree of the journal repo on a task-specific
  branch. Contains the agent's working notes (`journal.md`), artifacts,
  analysis, and failure summaries. Also checkpointed as git commits.

The target repo can be any git repository. Taskcore is agnostic about what
repo a task targets; it just provides the isolation and lifecycle management.

### Why Git Worktrees

1. **Concurrent access**: Multiple agents work on different tasks
   simultaneously. Each needs its own checked-out branch to write and commit
   to. A single repo can only have one branch checked out; worktrees solve
   this.
2. **Checkpointing**: Every commit is a checkpoint. If an agent makes
   progress (commits A, B, C) then fails at C, we can revert to B and try a
   different path.
3. **Rollback**: Failed paths get cleaned up. The worktree is discarded, the
   branch is deleted or archived, and only the failure summary persists.
4. **Audit trail**: The full commit history shows exactly what happened, in
   what order, with what content. Combined with the event store, this gives
   full reproducibility.

## Journal Purpose

The journal is not just a log — it is a **shared context artifact** that flows
between agents and across task boundaries:

- **Agent scratchpad**: The working agent writes their reasoning, findings,
  and analysis into `journal.md`. This is their primary output for
  non-code tasks (analysis, research, planning).
- **Reviewer input**: The reviewer sees `journal.md` as the first thing in
  their review prompt. It explains *why* decisions were made, not just *what*
  changed.
- **Parent-to-child context**: When a task is decomposed, each child can
  read the parent's journal to understand the analysis that led to their
  creation.
- **Failure memory**: Failure summaries from sibling tasks are readable by
  subsequent attempts, preventing repeated mistakes.

## Agent Model

Agents are identified by `role.instance` (e.g., `claude.3`, `coder.1`,
`reviewer.2`). The role determines what the agent can do; the instance
provides traceability.

### Specialization

Agents have different specializations — driven by their memory, skills,
system prompts, and default models. Examples:

- A **coder** agent excels at implementation tasks.
- An **analyst** agent excels at decomposition and planning.
- A **reviewer** agent excels at code review and verification.

However, specialization is soft, not hard. Any agent can perform any role
if assigned — the coder can review, the analyst can execute. The system
does not prevent cross-role work; it uses role matching as a default
preference, not a wall.

Over time, metrics will show which agents perform best at which roles,
enabling data-driven assignment and self-improvement.

### Registry and Role Matching

- **Registry**: `agents/registry.json` defines valid roles with capabilities
  (assignable, reviewer, consulted).
- **Role matching**: When claiming a task, the system checks that the agent's
  role matches the task's assignee/reviewer. `claude.3` can claim tasks
  assigned to `claude`. Mismatches are warned but overridable with `--force`.
- **Mixed fleet**: Both AI agents and humans participate. The system does not
  distinguish between them in the state machine — both claim tasks, submit
  work, and review. There is no fundamental difference; the distinction is
  only operational (AI agents run 24/7, humans check in periodically).

## Dispatch Model

The current model is **agent-driven** (pull, not push):

- Each agent runs continuously (24/7 loop).
- When idle, the agent calls `task` (bare command) to see available work.
- The agent claims a task, works on it, submits, and loops.
- The system provides guardrails: role matching, single-task enforcement,
  lease timeouts.

This replaced the earlier dispatcher model (push) which spawned agents
automatically. The pull model is simpler, gives agents more autonomy, and
avoids the complexity of process management in the daemon.

## Interface: CLI-First

The primary interface is the CLI (`task` command). Both agents and humans
use it. This is intentional:

- Agents live in terminals — the CLI is their native interface.
- Humans who interact with the system are developers — CLI is natural.
- The CLI provides the same experience to both: `task` shows your inbox,
  `task claim` picks up work, `task submit` reports results.
- A dashboard can wrap the CLI for visual overview, but the CLI is the
  source of truth for agent interaction.

The CLI guides agents through the workflow with phase-specific instructions
and next-step hints, so an agent doesn't need to "know" the protocol — it
just follows the prompts.

## Cost and Budget

Every task has a cost budget. Currently abstract (not yet mapped to real API
spend). The budget system serves multiple purposes:

- **Bounding search depth**: Decomposition allocates parent budget to
  children. Deep trees naturally exhaust their budget.
- **Throttling runaway agents**: When a task exhausts its budget, it pauses
  (`exhausted` condition) and waits for a human or authorized agent to add
  more.
- **Hierarchical authority**: Higher-level agents (e.g., a "CEO" agent) will
  have authority to allocate budget to lower-level agents, make cost/benefit
  decisions, and prioritize work — mirroring organizational structure.

Eventually, cost will map to objective measures (API spend, compute time,
tokens consumed) and feed into metrics for efficiency optimization.

## Scaling

The system is designed to scale from a handful of agents to a large fleet:

- **Near-term**: A few Claude instances on a single server, each running
  as a tmux session or systemd service.
- **Medium-term**: Dedicated taskcore server separate from agent machines.
  Agents connect via HTTP API from multiple hosts.
- **Long-term**: Arbitrarily many agents across many machines. The taskcore
  daemon is the coordination point; agents are stateless workers that pull
  tasks, do work, and report back.

Resource contention (e.g., two agents editing the same file) is handled by
workspace isolation — each task's code worktree is on its own branch. Merging
happens through PRs, where conflicts are detected and resolved.

## Traceability and Reproducibility

Every state change is recorded in the event store (JSONL). Combined with git
history, this gives near-full reproducibility:

- **Event store**: Every task state transition (created, claimed, submitted,
  reviewed, failed, etc.) with timestamps, agent context, fence tokens.
- **Git history**: Every code change and journal entry with full commit
  history.
- **Session context**: The agent's model, session ID, context budget, and
  cost are recorded on each lease.

The only non-reproducible element is LLM API responses (non-deterministic).
Everything else — the task tree structure, the order of operations, the
prompts, the workspace state — is reconstructable.

The goal is to be able to "debug" any agent session after the fact: see
exactly what context it had, what it produced, and whether a different
approach would have yielded a better result.

## Living Backlog

The task tree is not a static plan — it is a living, evolving ledger:

- Humans seed it with high-level objectives ("build feature X") and the
  agent fleet decomposes and executes.
- Agents can spawn new tasks on their own authority when they discover
  something useful or necessary during work. (Subject to policy — some
  agents may need approval to create tasks, others are trusted to self-direct.)
- The backlog grows organically as agents and humans both contribute.
- There is no "done" state for the system as a whole — it runs continuously,
  processing whatever work exists.

## Git vs GitHub

Git is used locally for the checkpoint/rollback/concurrent-access machinery.
It is fast, unlimited, and works offline.

GitHub is used for collaboration and persistence:

- Agents push branches and create PRs as part of their normal workflow.
- Completed work gets merged — often without human review for trusted agents
  and low-risk tasks.
- Human review is required selectively: high-risk changes, architectural
  decisions, or when the agent's confidence is low.
- Branch protection rules encode the review policy per repo.

Not every micro-step needs a push. Local git handles the high-frequency
checkpointing (hundreds of commits per task attempt). Pushes happen at
meaningful boundaries: task submission, PR creation, deliverable completion.
The journal repo stays local — it is internal working memory, not a
deliverable.

## Current State and Roadmap

### Working
- Core state machine (event-sourced, 97 tests)
- JSONL persistence
- HTTP API (daemon)
- CLI for task management (`task create`, `task claim`, `task submit`, etc.)
- Journal repo with per-task branches
- Failure summaries and retry logic
- Review workflow with verdicts

### In Progress
- CLI improvements (phase-aware guidance, bare `task` home screen)
- Role enforcement on claims
- Hierarchical agent identity (`role.instance`)
- Removing dead dispatcher code

### Planned
- Agent self-dispatch loop (idle agent polls for work)
- Code worktree integration (set `repo` metadata, auto-create branches)
- Checkpoint/rollback on failure (revert worktree state, extract summary)
- Parent re-analysis on child completion
- Prompt engineering for autonomous agent operation
- Metrics and self-improvement (compare approaches, measure success rates)
- State machine simplification (move clock-based logic into reducer)
- Hierarchical authority and budget delegation
- Multi-machine agent fleet support
