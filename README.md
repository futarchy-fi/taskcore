# taskcore

Event-sourced orchestration core for autonomous agent task management.

## Philosophy

Most agent orchestration systems treat task state as mutable records in a database — rows that get updated in place. This makes it impossible to answer basic questions: *Why did this task fail? What happened between retry 3 and retry 4? Did the reviewer see the same state the worker produced?*

taskcore takes a different approach: **tasks are event streams, not records.** Every state change is an immutable event. The current state is always a pure function of the event history. This gives us:

- **Perfect auditability.** Every transition has a timestamp, a source, and a reason.
- **Deterministic replay.** Feed the same events, get the same state. Always.
- **Invariant checking.** After every event, the system verifies 20+ structural invariants. If a bug would corrupt state, it's caught immediately — not discovered days later.
- **Safe concurrency.** Fence tokens prevent stale agents from making conflicting updates. The core rejects events from agents that no longer hold the lease.

The core is a pure TypeScript library with zero side effects. It doesn't spawn processes, make HTTP calls, or touch the filesystem (except SQLite). The middle layer adds the messy real-world stuff: process spawning, HTTP APIs, agent bridges.

## Architecture

```
                taskcore
    ┌──────────────┬──────────────┐
    │   core/      │   middle/    │
    │              │              │
    │  Pure state  │  Daemon      │
    │  machine     │  HTTP API    │
    │  (frozen)    │  Dispatcher  │
    │              │  Bridges     │
    │  45 tests    │  9 tests     │
    └──────────────┴──────────────┘
         ▲                │
         │                ▼
    Event log        Agent processes
    (SQLite)         (openclaw agent)
```

### Core (`core/`)

The verified state machine. 45 tests across unit, integration, scenario, and property-based suites. Changes to core require review.

- **types.ts** — Complete type system: tasks, events, phases, conditions, budgets
- **reducer.ts** — Pure functional event reducer: `(state, event) → state`
- **validator.ts** — Event validation rules, phase transition table (11 legal transitions)
- **clock.ts** — Time-based auto-events: lease expiry, backoff, cost recovery, dependency satisfaction
- **invariants.ts** — 20+ structural invariant checks run after every event
- **persistence.ts** — SQLite storage with WAL mode, snapshots every 50 events
- **scheduler.ts** — Dispatch queries, dependency graph, critical path analysis
- **index.ts** — `OrchestrationCore` class: the public API

### Middle (`middle/`)

The bridge between the pure core and the real world.

- **daemon.ts** — Entry point: lock file, core init, tick loop (2s), dispatch loop (10s), graceful shutdown
- **http.ts** — HTTP API on `127.0.0.1:18800` with status-update translation
- **dispatcher.ts** — Priority-sorted dispatch, agent spawn, exit handling with exponential backoff
- **analysis.ts** — Auto-analysis: tasks with an assignee skip straight to execution
- **prompt.ts** — Prompt builder for work and review modes
- **mcp-bridge.ts** — MCP stdio server (JSON-RPC 2.0) for agents that use MCP tools
- **task-update-bridge.py** — CLI for agents to report status
- **delegate-bridge.py** — CLI for agents to create subtasks
- **migrate.ts** — One-shot migration from legacy `tasks.json` format

## Task Lifecycle

Every task follows a phase-based lifecycle:

```
analysis → execution → review → done
    │          │          │
    └──→ decomposition ──→┘
```

Each phase has conditions: `ready → leased → active → (waiting|retryWait)`.

Terminal states: `done`, `failed`, `blocked`, `canceled`.

### Phase Transitions

| From | To | Reason |
|------|----|--------|
| analysis.active | execution.ready | Agent decides to execute |
| analysis.active | decomposition.ready | Agent decides to decompose |
| execution.active | review.ready | Work complete |
| execution.active | analysis.ready | Too complex / approach not viable |
| review.active | execution.ready | Changes requested |
| review.active | analysis.ready | Wrong approach / needs re-decomposition |
| review.active | decomposition.ready | Add children |
| decomposition.active | review.waiting | Children created |
| review.waiting | review.ready | All children complete |
| review.waiting | analysis.ready | All children failed |

### Budget System

Each task has two budgets:

- **Attempt budget** — Max retries per phase (default: analysis=3, decomp=2, execution=4, review=3)
- **Cost budget** — Token/compute units. Hierarchical: parent allocates to children, recovers unused cost from terminal children.

When either budget is exhausted, the task auto-fails via the clock.

### Fence Tokens

Every lease grants a monotonically increasing fence token. Events from agents must carry the correct token. If an agent crashes and a new one starts, the old agent's stale events are rejected. This prevents the "zombie agent" problem that plagues most orchestration systems.

## HTTP API

Default: `127.0.0.1:18800`

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check + stats |
| GET | `/tasks` | List tasks (filters: `?phase=`, `?condition=`, `?terminal=`, `?full=true`) |
| GET | `/tasks/:id` | Get single task (full detail) |
| GET | `/dispatchable` | List tasks ready for dispatch |
| POST | `/tasks` | Create task |
| POST | `/tasks/:id/events` | Submit raw event (fenced) |
| POST | `/tasks/:id/status` | Agent-friendly status update |

### Status Update Translation

Agents report simple statuses. The daemon translates to core events:

| Agent says | Core events emitted |
|-----------|-------------------|
| `"review"` | PhaseTransition(execution.active → review.ready) |
| `"done"` | ReviewVerdictSubmitted(approve) + ReviewPolicyMet + TaskCompleted |
| `"blocked"` | TaskBlocked with failure summary |
| `"pending"` | ReviewVerdictSubmitted(changes_requested) + PhaseTransition(review → execution) |
| `"execute"` | PhaseTransition(analysis.active → execution.ready) |

## Quick Start

```bash
# Install dependencies
npm install

# Run all tests (core + middle)
npm run test:all

# Start the daemon
npm run daemon

# Check health
curl http://127.0.0.1:18800/health

# Create a task
curl -X POST http://127.0.0.1:18800/tasks \
  -H 'Content-Type: application/json' \
  -d '{"title":"Hello world","description":"Test task","assignee":"coder","reviewer":"hermes"}'

# Check task state
curl http://127.0.0.1:18800/tasks/1
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ORCHESTRATOR_PORT` | 18800 | HTTP listen port |
| `ORCHESTRATOR_DB` | `$WORKSPACE/data/taskcore.db` | SQLite database path |
| `AGENT_REGISTRY` | `$WORKSPACE/agents/registry.json` | Agent registry path |
| `WORKSPACE_DIR` | `~/.openclaw/workspace` | Workspace root |
| `MAX_CONCURRENT` | 1 | Max concurrent agent dispatches |
| `TICK_INTERVAL_MS` | 2000 | Core tick interval (auto-events) |
| `DISPATCH_INTERVAL_MS` | 10000 | Dispatch loop interval |
| `LEASE_TIMEOUT_MS` | 600000 | Default agent lease timeout |
| `AGENT_TIMEOUT_MS` | 600000 | Max agent runtime before SIGKILL |

### Migration from tasks.json

```bash
npm run migrate -- --tasks-file /path/to/tasks.json --db /path/to/taskcore.db
```

## Design Decisions

**Why event sourcing?** Agent systems are inherently concurrent and failure-prone. Events give us an audit trail, replay capability, and the ability to detect invariant violations immediately. The cost (larger storage, replay on startup) is trivial compared to the debugging time saved.

**Why SQLite?** Single-machine deployment. WAL mode gives us concurrent reads during writes. Snapshots every 50 events keep startup fast. No network dependencies.

**Why no Express/Fastify?** The HTTP layer is ~200 lines with Node's built-in `http` module. One fewer dependency, one fewer attack surface, zero startup overhead.

**Why separate core and middle?** The core is the contract. It's pure, tested, and changes require review. The middle layer is the adapter — it can change freely without risking state machine correctness.

**Why fence tokens instead of optimistic concurrency?** Fence tokens are strictly stronger. They prevent stale writes even from agents that haven't crashed but are just slow. The monotonic guarantee means we never need to "merge" conflicting updates.

## Roadmap

### Near Term
- [ ] Worktree isolation for agents (each agent gets a git worktree)
- [ ] Structured decomposition via core events (currently flat `delegate`)
- [ ] Dashboard direct integration (query taskcore API instead of exporter)
- [ ] Snapshot pruning (keep only last N snapshots)

### Medium Term
- [ ] Multi-reviewer / Delphi consensus protocol
- [ ] Cost budget tuning based on historical data
- [ ] Full analysis agent (sophisticated task understanding before execution)
- [ ] Webhook notifications (Telegram, Slack)

### Long Term
- [ ] TLA+ / Alloy formal verification of the phase transition model
- [ ] Multi-machine deployment (event log replication)
- [ ] Agent capability matching (route tasks to agents based on skill fit)
- [ ] Adaptive backoff (learn optimal retry timing from history)

## License

MIT
