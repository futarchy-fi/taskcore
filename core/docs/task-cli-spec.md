# `task` CLI Specification

> Status: Implemented v1 — 2026-03-05

## 1. Design Principles

1. **Context delivery, not just actions.** Every command returns rich, relevant
   context the agent needs for its current step. The CLI replaces the giant
   dispatch prompt with incremental, on-demand context.

2. **Multi-step guided workflows.** Complex flows (decomposition, review,
   analysis) are broken into small steps. Each step's output includes the exact
   command(s) to run next. One decision per invocation — keeps agent output small
   and focused.

3. **Current-task context (git-style).** After `task claim`, subsequent commands
   operate on the claimed task implicitly. State lives in a `.task` file (like
   `.git/HEAD`), searched upward from cwd.

4. **Worktree-native.** `task claim` creates journal + code worktrees and writes
   the `.task` context file at the worktree root. The agent works inside the
   worktree. Everything is scoped.

5. **Retires the legacy bridge layer.** This CLI is the sole interface between
   agents and taskcore.

6. **Human-readable output first.** Agents consume the same text humans would
   read. `--json` flag reserved for future machine parsing.

## 2. Identity & Context

### Agent Identity

```
export TASKCORE_AGENT_ID=coder
```

Set by the dispatcher or manually. Required for `claim`, `complete`, and other
state-changing commands. Read-only commands (`list`, `show`) work without it.

### Current Task (`.task` file)

After `task claim <id>`, the CLI writes a `.task` file at the worktree root:

```json
{
  "taskId": "842",
  "phase": "execution",
  "fenceToken": 47,
  "sessionId": "a1b2c3d4-...",
  "journalPath": "/tmp/taskcore-worktrees/journal-T842/tasks/T842/",
  "codeWorktree": "/tmp/taskcore-worktrees/code-T842/",
  "claimedAt": 1709654400000
}
```

The CLI searches upward from cwd for `.task` (same algorithm as git finding
`.git`). Falls back to `$TASK_ID` env var (set by the dispatcher for
auto-dispatched agents).

When both `.task` and `$TASK_ID` exist, `.task` wins.

### Worktree Setup on Claim

`task claim <id>` performs:

1. Calls `POST /tasks/:id/claim` (LeaseGranted + AgentStarted)
2. Creates journal worktree at `/tmp/taskcore-worktrees/journal-T{id}/`
3. Creates code worktree at `/tmp/taskcore-worktrees/code-T{id}/` (if task has
   `metadata.repo`)
4. Writes `.task` file in **both** worktree roots (so the context is found
   regardless of which worktree the agent cds into)
5. Prints the worktree paths and full task context

The agent (or dispatcher wrapper) is responsible for `cd`-ing into the
appropriate worktree. The CLI cannot change the parent shell's cwd.

## 3. Command Reference

### 3.1 Discovery & Read Commands

These require no identity and don't mutate state.

#### `task list`

List tasks with filters. Default: non-terminal tasks sorted by priority.

```
task list [--phase <phase>] [--condition <condition>] [--terminal <terminal>]
          [--assignee <agent>] [--priority <priority>] [--parent <id>]
          [--mine] [--limit N]
```

`--mine` filters to tasks assigned to `$TASKCORE_AGENT_ID`.

**Output**: table with columns `ID | Priority | Phase | Condition | Assignee | Title`.

Context provided:
- Total count and how many are shown
- Hint: `task show <id>` for details

#### `task show <id>`

Full task detail view.

```
task show <id> [--events] [--children] [--deps]
```

**Output** (rich context):

```
--- T842: Fix memory leak in connection pool ---
Priority:    high
Phase:       execution
Condition:   ready
Assignee:    coder
Reviewer:    overseer
Parent:      T800 (Reliability improvements)

Created:     2026-03-04 14:30 UTC
Updated:     2026-03-05 09:15 UTC

## Description
<full task description>

## Attempts
  execution: 2/8 used
  analysis:  1/4 used

## Cost
  Allocated: $50.00
  Consumed:  $12.30
  Remaining: $37.70

## Previous Failures
  - Attempt 1: Connection pool timeout not handled (learned: need to mock timer)
  - Attempt 2: Test passed locally but CI uses different pool size

## Review Feedback
  Round 1 (overseer): changes_requested
  "Missing error handling for edge case when pool is at capacity"

## Dependencies
  T840 (done) -- pool refactor must land first
  T841 (in-progress) -- shared test fixtures

## Children
  (none)
```

#### `task events <id>`

Raw event history for a task. Useful for debugging.

```
task events <id> [--last N]
```

#### `task attention`

Show tasks that need human attention (blocked, failed, exhausted).

```
task attention [--format telegram]
```

### 3.2 Task Lifecycle Commands

These require `$TASKCORE_AGENT_ID`.

#### `task create`

Create a new task (replaces the legacy `delegate` flow).

```
task create <title> --description <desc>
    [--assignee <agent>] [--reviewer <agent>] [--consulted <agent>]
    [--priority <priority>] [--depends-on <id>,<id>]
    [--informed <target>,<target>]
    [--repo <path>] [--base-branch <branch>]
```

**Output** (context):
- Created task ID, phase, condition
- If assignee set: "Dispatcher will auto-assign to <agent>"
- If depends-on: "Waiting on T840, T841 before starting"
- Hint: `task show <id>` for full details

#### `task claim <id>`

Claim a task and set up the workspace.

```
task claim <id>
```

**Output** (rich context — this is the agent's primary onboarding):

```
--- Claimed T842: Fix memory leak in connection pool ---
Lease: 15 min (extend with `task extend`)
Fence: 48

## Description
<full task description>

## Your Workspace
  Journal: /tmp/taskcore-worktrees/journal-T842/tasks/T842/
  Code:    /tmp/taskcore-worktrees/code-T842/

  cd /tmp/taskcore-worktrees/code-T842/

## Previous Attempts (2 failed)
  - Attempt 1: Connection pool timeout not handled
    Learned: need to mock timer in tests
  - Attempt 2: Test passed locally but CI uses different pool size
    Learned: always test with CI pool config

## Review Feedback
  Round 1 (overseer): changes_requested
  "Missing error handling for edge case when pool is at capacity"

## Parent Context (T800)
  <truncated journal from parent task>

## Sibling Failures
  T838: Tried mutex approach, deadlocked under load
  T839: Race condition in cleanup — fixed wrong lifecycle hook

## Workspace Conventions
  <AGENTS.md content>

## What To Do Next
  1. Read the code in the worktree
  2. Write observations to your journal:
       task journal write "Starting analysis of pool.ts..."
  3. When done:
       task submit "Description of what you did"
  4. If blocked:
       task block "What is preventing progress"
```

#### `task release`

Release current task back to the queue.

```
task release [--reason <reason>] [--worked]
```

`--worked` counts as an attempt (increments attempt counter).

#### `task extend`

Extend the lease on the current task.

```
task extend [--duration <duration>]
```

Default: 15 minutes. Accepts: `10m`, `30m`, `1h`.

### 3.3 Status Transitions

All operate on the current task (from `.task` context).

#### `task submit <evidence>`

Submit work for review. Transitions execution.active -> review.ready.

```
task submit "Fixed the leak by adding cleanup in dispose(). Tests added."
```

**Output**:
- Confirmation + new phase/condition
- Who will review: "Reviewer: overseer"
- Hint: "Your work will be reviewed. You can work on another task or wait."

#### `task complete <evidence>`

Mark task as done (when there is no reviewer, or used by reviewer to approve).

```
task complete "All acceptance criteria met. Verified in staging."
```

#### `task block <reason>`

Mark task as blocked.

```
task block "Need API credentials from Nicholas — can't test auth flow"
```

**Output**:
- Confirmation
- Informed parties notified (if any)
- Consulted agent suggestion: "Consider asking hermes for help"

#### `task cost <amount>`

Report incremental cost consumed.

```
task cost 0.15
```

#### `task update <message>`

Progress note — no state change, just a record. Written to both the event log
and the journal.

```
task update "Refactored parser module, still need to update tests"
```

### 3.4 Analysis Workflow (guided)

When a task is in the `analysis` phase, the agent decides whether to execute
directly or decompose.

#### `task analyze`

Read the analysis context for the current task.

```
task analyze
```

**Output** (context-rich):

```
--- Analysis: T842 — Fix memory leak in connection pool ---

## Task Description
<description>

## Previous Approaches (1 failed)
  v1: Direct fix attempt — failed (timeout not handled)

## Considerations
  - Is this simple enough for a single agent?
  - Should it be decomposed into subtasks?
  - Is it blocked or missing information?

## Your Decision
  task decide execute       Execute directly (one agent can handle this)
  task decide decompose     Needs decomposition into subtasks
  task block "reason"       Cannot proceed
```

#### `task decide execute`

Decision: task is simple enough for direct execution.

```
task decide execute
```

Transitions: analysis -> execution.ready.

**Output**: confirmation + hint that dispatcher will assign.

#### `task decide decompose`

Decision: task needs decomposition.

```
task decide decompose
```

Transitions: analysis -> decomposition.ready.

**Output**: confirmation + hint to wait for decomposition phase dispatch.

### 3.5 Decomposition Workflow (guided, multi-step)

When a task is in the `decomposition` phase.

#### `task decompose start`

Begin a decomposition session. Prints full context needed to plan subtasks.

```
task decompose start
```

**Output** (context):

```
--- Decomposition: T842 — Fix memory leak in connection pool ---

## Task Description
<description>

## Budget
  Remaining: $50.00
  You must allocate cost to each child from this budget.

## Previous Decompositions
  (none — first attempt)

  OR:

  v1: "Split into find + fix + test" — FAILED
    Child T843 (Find leaks) failed: couldn't reproduce in test env
    Child T844 (Fix leaks) blocked: depended on T843
    DO NOT repeat this strategy.

## Guidelines
  - Each child should be completable by one agent in one session
  - Children should be as independent as possible
  - Use --depends-on when order matters (0-indexed sibling position)
  - Leave assignee blank unless a specific agent is needed

## Next Step
  Add your first child:

  task decompose add "Child title" \
    --desc "What this child should do" \
    --cost 10
```

#### `task decompose add`

Add one child to the pending decomposition.

```
task decompose add <title>
    --desc <description>
    --cost <amount>
    [--assignee <agent>]
    [--reviewer <agent>]
    [--depends-on <sibling-index>,<sibling-index>]
    [--skip-analysis]
```

**Output** (context for next decision):

```
--- Child #0 added ---
  Title:    Find all leak sources
  Cost:     $10.00
  Assignee: analyst

Budget remaining: $40.00

Children so far:
  #0  Find all leak sources                $10   analyst

Add another child, or commit:

  task decompose add "Next title" --desc "..." --cost N
  task decompose add "Next title" --desc "..." --cost N --depends-on 0
  task decompose commit "Brief strategy description"
```

After adding more children:

```
--- Child #2 added ---
  Title:    Regression tests
  Cost:     $15.00
  Depends:  #1 (Fix identified leaks)

Budget remaining: $5.00

Children so far:
  #0  Find all leak sources         $10   analyst
  #1  Fix identified leaks          $20   coder     (depends on #0)
  #2  Regression tests              $15   coder     (depends on #1)

  task decompose add "..." --desc "..." --cost N
  task decompose commit "Strategy description"
```

#### `task decompose commit`

Finalize the decomposition. Creates all children as real tasks.

```
task decompose commit "Audit-first: find leaks, fix them, then add regression tests"
```

**Output** (summary):

```
--- Decomposition committed ---

Strategy: Audit-first: find leaks, fix them, then add regression tests

Created 3 children:
  T843: Find all leak sources         $10  analyst   (ready)
  T844: Fix identified leaks          $20  coder     (waiting on T843)
  T845: Regression tests              $15  coder     (waiting on T844)

Budget remaining: $5.00

Your decomposition task T842 is complete.
The dispatcher will pick up the children.
```

#### `task decompose cancel`

Abort a pending decomposition session without committing.

```
task decompose cancel
```

### 3.6 Review Workflow (guided, multi-step)

When a task is in the `review` phase and claimed by a reviewer.

#### `task review read`

Load the review context. This is step 1 — the reviewer reads before judging.

```
task review read
```

**Output** (context — everything the reviewer needs):

```
--- Review: T842 — Fix memory leak in connection pool ---

## Original Task
<task description>

## Assignee Evidence
"Fixed the leak by adding cleanup in dispose(). Tests in pool.test.ts."

## Agent Journal
<journal.md content from the task's journal branch>

## Code Changes
<git diff from the task branch vs base>

## Previous Review Rounds
  (none — first review)

  OR:

  Round 1 (overseer): changes_requested
  "Missing error handling for edge case when pool is at capacity"

## Next Step
  Record your observations, then submit a verdict:

  task review note "Observation about the code or evidence"
  task review approve "Summary of why this passes"
  task review reject "Summary of why this fails"
  task review request-changes "What needs to change"
```

#### `task review note`

Record an observation. Written to the reviewer's journal. Accumulates — the
agent can add multiple notes before deciding. Notes are included in the final
verdict context.

```
task review note "Code change looks correct. dispose() now calls pool.drain()"
task review note "Missing: no test for the case when drain() throws"
```

**Output** (context after each note):

```
--- Note recorded (2 total) ---

Your notes so far:
  1. Code change looks correct. dispose() now calls pool.drain()
  2. Missing: no test for the case when drain() throws

  task review note "Another observation"
  task review approve "Summary"
  task review reject "Reason"
  task review request-changes "Feedback"
```

#### `task review approve`

Approve the work. Submits ReviewVerdictSubmitted(approve) + marks task done.

```
task review approve "Clean fix, tests pass, handles edge cases correctly"
```

#### `task review reject`

Reject the work. Task moves to failed.

```
task review reject "Fundamental approach is wrong — pool should use weak refs"
```

#### `task review request-changes`

Request changes. Task returns to execution.ready for the assignee to address.

```
task review request-changes "Add test for drain() throwing. Otherwise LGTM."
```

**Output**:

```
--- Changes requested ---

Your feedback has been recorded. T842 returns to execution.
The assignee will see your feedback when re-dispatched.

Feedback: "Add test for drain() throwing. Otherwise LGTM."
```

### 3.7 Journal Commands

Agents write structured observations to their task journal. The journal is
persisted in a git branch and visible to reviewers and future retry attempts.

#### `task journal read`

Print the journal for the current task.

```
task journal read
```

#### `task journal write`

Append a section to the journal.

```
task journal write "## Analysis\nThe connection pool uses a fixed-size array..."
```

Commits to the journal branch automatically.

#### `task journal write-file`

Write an artifact file to the journal directory (for reports, data, etc.).

```
task journal write-file analysis.csv "header1,header2\nval1,val2"
```

### 3.8 Worktree Commands

#### `task worktree`

Print worktree paths for the current task.

```
task worktree
```

**Output**:

```
Journal: /tmp/taskcore-worktrees/journal-T842/tasks/T842/
Code:    /tmp/taskcore-worktrees/code-T842/
```

### 3.9 Admin Commands

Available to all agents but intended for orchestration roles (overseer, hermes).
Could be role-gated later.

#### `task revive <id>`

Bring a failed or blocked task back to life.

```
task revive <id> [--reason "New approach available"]
```

#### `task cancel <id>`

Cancel a task.

```
task cancel <id> [--reason "No longer needed"]
```

#### `task budget <id>`

Increase attempt or cost budget.

```
task budget <id> --cost 20
task budget <id> --attempts execution:4
```

#### `task metadata <id> <key> <value>`

Update task metadata.

```
task metadata 842 priority critical
task metadata 842 assignee coder-lite
```

#### `task reparent <id> --parent <parent-id>`

Move a task under a different parent.

```
task reparent 845 --parent 900
```

### 3.10 Incidents

#### `task incident`

Report an incident.

```
task incident <summary>
    --severity <critical|error|warning|info>
    --category <category>
    [--detail "Extended description"]
    [--tags tag1,tag2]
```

## 4. Multi-Step Workflow Patterns

The CLI uses a **stateful command chain** pattern for complex workflows. The
mechanism:

1. Each command performs **one action** and returns **context for the next step**
2. The output includes **suggested next commands** (copy-pasteable)
3. State is tracked in the `.task` context file (updated after each command)
4. The agent makes **one small decision** per invocation

This keeps agent responses short and focused. Instead of a 2000-token reasoning
blob, the agent produces a 50-token decision + runs the next command.

### 4.1 Execution Flow (typical)

```
task claim 842
  -> reads context, cds into worktree
task journal write "Starting work on pool cleanup..."
  -> records observation
  ... agent does actual coding work ...
task journal write "## Changes\n- Added drain() call in dispose()\n- ..."
task cost 0.08
task submit "Fixed leak: added drain() in dispose(), tests in pool.test.ts"
```

### 4.2 Analysis Flow

```
task claim 842
  -> context shows analysis phase
task analyze
  -> reads task, previous failures, approaches
task journal write "## Analysis\nThis is simple enough for one agent because..."
task decide execute
```

### 4.3 Decomposition Flow

```
task claim 842
  -> context shows decomposition phase
task decompose start
  -> budget, failed approaches, guidelines
task journal write "## Strategy\nSplitting into audit + fix + test..."
task decompose add "Audit pool" --desc "Find all leaks" --cost 10
  -> child #0 added, budget remaining
task decompose add "Fix leaks" --desc "..." --cost 20 --depends-on 0
  -> child #1 added
task decompose add "Tests" --desc "..." --cost 15 --depends-on 1
  -> child #2 added
task decompose commit "Audit-first: find, fix, test"
  -> done, children created
```

### 4.4 Review Flow

```
task claim 842
  -> context shows review phase
task review read
  -> task description, evidence, diff, journal
task review note "Code change is correct, drain() properly called"
task review note "Missing test for drain() exception"
task review request-changes "Add test for drain() throwing"
  -> T842 returns to execution
```

## 5. Context Delivery Summary

What each command delivers (beyond its primary action):

| Command | Context Delivered |
|---------|-------------------|
| `task claim` | Full task description, failures, review feedback, parent journal, sibling failures, workspace conventions, worktree paths |
| `task analyze` | Task description, previous approaches, failure history |
| `task decompose start` | Task description, budget, failed decompositions, guidelines |
| `task decompose add` | Running child list, remaining budget, dependency graph |
| `task review read` | Original task, evidence, code diff, journal, previous rounds |
| `task review note` | Running notes list |
| `task show` | Everything: description, attempts, cost, failures, reviews, deps, children |
| `task list --mine` | My tasks sorted by priority, phases, conditions |

## 6. Implementation Notes

### Language & Location

TypeScript, lives in the taskcore repo at `core/cli/`. Shares types with core.
Compiles to a single executable via the existing build pipeline.

Installed as `task` (symlink or bin entry in package.json).
In a source checkout, `./task` is a repo-local launcher for the same CLI.

### Communication

All commands talk to the taskcore daemon via HTTP (`http://127.0.0.1:18800`).
Port configurable via `$ORCHESTRATOR_PORT`.

The CLI does NOT import core directly — it's a pure HTTP client. This means it
works from any machine that can reach the daemon (including inside worktrees,
containers, etc.).

### Error Output

Errors go to stderr. Successful context goes to stdout. This allows:

```bash
WORKTREE=$(task claim 842 2>/dev/null | grep "^Code:" | awk '{print $2}')
cd "$WORKTREE"
```

### Exit Codes

- 0: success
- 1: command error (bad args, missing context)
- 2: API error (daemon unreachable, task not found, invalid state transition)
- 3: auth error (no TASKCORE_AGENT_ID when required)

### Cutover Status

1. `task` has feature parity with the retired bridge commands.
2. Dispatcher prompts use `task` commands instead of raw HTTP examples.
3. Legacy bridge entrypoints are removed from the runtime.

## 7. Open Questions

1. **Shell wrapper for auto-cd**: Should we provide a shell function that wraps
   `task claim` to auto-cd into the worktree? Or leave that to the dispatcher?

2. **Streaming output**: Should `task show` or `task review read` page long
   output, or just dump everything? (Agents don't paginate, so probably dump.)

3. **Offline mode**: Should the CLI cache task data for when the daemon is
   unreachable? (Probably not for v1.)

4. **Dispatcher integration**: The dispatcher currently auto-dispatches work.
   Should it stay opinionated, or shift toward more self-directed claiming via
   `task claim`?
