import * as path from "node:path";
import { CoreClock } from "./clock.js";
import { assertInvariants, checkInvariants } from "./invariants.js";
import { JsonlPersistence } from "./jsonl-persistence.js";
import { SQLitePersistence } from "./persistence.js";
import { reduce } from "./reducer.js";
import {
  computeCostRemaining,
  createInitialState,
  type Condition,
  type CoreOptions,
  type CostSummary,
  type DependencyGraph,
  type Event,
  type Persistence,
  type Phase,
  type Result,
  type SearchTreeNode,
  type SystemState,
  type Task,
  type TaskId,
  type ValidationError,
} from "./types.js";
import {
  getAncestors,
  getChildren,
  getCriticalPath,
  getDependencyGraph,
  getDispatchableTasks,
  getTasksByState,
} from "./scheduler.js";

const DEFAULT_SNAPSHOT_EVERY = 50;
const DEFAULT_CLOCK_POLL_MS = 1_000;

export interface Core {
  submit(event: Event): Result<void, ValidationError>;
  tick(now?: number): Result<number, ValidationError>;

  getTask(taskId: TaskId): Task | null;
  getDispatchable(): Task[];
  getTasksByState(phase: Phase, condition: Condition): Task[];
  getChildren(taskId: TaskId): Task[];
  getAncestors(taskId: TaskId): Task[];
  getDependencyGraph(): DependencyGraph;

  getEvents(taskId: TaskId): Event[];
  getEventsSince(sequenceNumber: number): Event[];

  getCriticalPath(rootTaskId: TaskId): TaskId[];
  getSearchTree(rootTaskId: TaskId): SearchTreeNode;
  getCostSummary(rootTaskId: TaskId): CostSummary;

  getState(): SystemState;
  close(): void;
}

function buildSearchTree(state: SystemState, taskId: TaskId): SearchTreeNode {
  const task = state.tasks[taskId];
  if (!task) {
    return {
      taskId,
      title: "<missing task>",
      terminal: null,
      phase: null,
      condition: null,
      approaches: [],
      children: [],
    };
  }

  return {
    taskId: task.id,
    title: task.title,
    terminal: task.terminal,
    phase: task.phase,
    condition: task.condition,
    approaches: task.approachHistory,
    children: task.children.map((childId) => buildSearchTree(state, childId)),
  };
}

function subtreeTasks(state: SystemState, rootTaskId: TaskId): Task[] {
  const root = state.tasks[rootTaskId];
  if (!root) {
    return [];
  }

  const out: Task[] = [];
  const stack: Task[] = [root];
  const seen = new Set<TaskId>();

  while (stack.length > 0) {
    const task = stack.pop();
    if (!task || seen.has(task.id)) {
      continue;
    }
    seen.add(task.id);
    out.push(task);
    for (const childId of task.children) {
      const child = state.tasks[childId];
      if (child) {
        stack.push(child);
      }
    }
  }

  return out;
}

export class OrchestrationCore implements Core {
  private readonly persistence: Persistence;
  private readonly clock: CoreClock;
  private readonly snapshotEvery: number;
  private readonly invariantChecks: boolean;
  private readonly clockPollMs: number;
  private state: SystemState;

  public constructor(options: CoreOptions) {
    const backend = options.persistenceBackend ?? "sqlite";
    if (backend === "jsonl") {
      const eventLogDir = options.eventLogDir ?? path.dirname(options.dbPath);
      this.persistence = new JsonlPersistence(eventLogDir);
    } else {
      this.persistence = new SQLitePersistence(options.dbPath);
    }
    this.clock = new CoreClock();
    this.snapshotEvery = options.snapshotEvery ?? DEFAULT_SNAPSHOT_EVERY;
    this.invariantChecks = options.invariantChecks ?? true;
    this.clockPollMs = options.clockPollMs ?? DEFAULT_CLOCK_POLL_MS;

    this.state = this.restoreState();
    if (this.invariantChecks) {
      const violations = checkInvariants(this.state);
      if (violations.length > 0) {
        // Save emergency snapshot so next restart doesn't replay from scratch
        try {
          this.persistence.saveSnapshot(this.state);
          console.error(`[core] Emergency snapshot saved at seq ${this.state.sequence}`);
        } catch (snapErr) {
          console.error("[core] Failed to save emergency snapshot:", snapErr);
        }
        assertInvariants(this.state);
      }
    }
  }

  public getState(): SystemState {
    return structuredClone(this.state);
  }

  public submit(event: Event): Result<void, ValidationError> {
    const reduced = reduce(this.state, event);
    if (!reduced.ok) {
      return reduced;
    }

    const nextState = reduced.value.state;

    if (this.invariantChecks) {
      const violations = checkInvariants(nextState);
      if (violations.length > 0) {
        const first = violations[0]!;
        return {
          ok: false,
          error: {
            code: first.code,
            message: "Invariant violation: " + first.code + " - " + first.message,
            eventType: event.type,
            taskId: event.taskId,
          },
        };
      }
    }

    const sequence = this.persistence.appendEvent(event);
    nextState.sequence = sequence;
    const lastEnvelope = nextState.events[nextState.events.length - 1];
    if (lastEnvelope) {
      lastEnvelope.sequence = sequence;
    }

    this.state = nextState;

    if (this.snapshotEvery > 0 && sequence % this.snapshotEvery === 0) {
      this.persistence.saveSnapshot(this.state);
    }

    return { ok: true, value: undefined };
  }

  public tick(now = Date.now()): Result<number, ValidationError> {
    const dueEvents = this.clock.collectDueEvents(this.state, now);
    let processed = 0;

    for (const dueEvent of dueEvents) {
      const result = this.submit(dueEvent);
      if (!result.ok) {
        return result;
      }
      processed += 1;
    }

    return { ok: true, value: processed };
  }

  public getTask(taskId: TaskId): Task | null {
    const task = this.state.tasks[taskId];
    return task ? structuredClone(task) : null;
  }

  public getDispatchable(): Task[] {
    return getDispatchableTasks(this.state).map((task) => structuredClone(task));
  }

  public getTasksByState(phase: Phase, condition: Condition): Task[] {
    return getTasksByState(this.state, phase, condition).map((task) => structuredClone(task));
  }

  public getChildren(taskId: TaskId): Task[] {
    return getChildren(this.state, taskId).map((task) => structuredClone(task));
  }

  public getAncestors(taskId: TaskId): Task[] {
    return getAncestors(this.state, taskId).map((task) => structuredClone(task));
  }

  public getDependencyGraph(): DependencyGraph {
    return getDependencyGraph(this.state);
  }

  public getEvents(taskId: TaskId): Event[] {
    return this.state.events
      .filter((envelope) => envelope.event.taskId === taskId)
      .map((envelope) => structuredClone(envelope.event));
  }

  public getEventsSince(sequenceNumber: number): Event[] {
    return this.state.events
      .filter((envelope) => envelope.sequence > sequenceNumber)
      .map((envelope) => structuredClone(envelope.event));
  }

  public getCriticalPath(rootTaskId: TaskId): TaskId[] {
    return getCriticalPath(this.state, rootTaskId);
  }

  public getSearchTree(rootTaskId: TaskId): SearchTreeNode {
    return buildSearchTree(this.state, rootTaskId);
  }

  public getCostSummary(rootTaskId: TaskId): CostSummary {
    const root = this.state.tasks[rootTaskId];
    if (!root) {
      return {
        rootTaskId,
        allocated: 0,
        consumed: 0,
        remaining: 0,
        entries: [],
      };
    }

    const tasks = subtreeTasks(this.state, rootTaskId);
    const entries = tasks.map((task) => ({
      taskId: task.id,
      allocated: task.cost.allocated,
      consumed: task.cost.consumed,
      remaining: computeCostRemaining(task.cost),
    }));

    const consumed = entries.reduce((sum, entry) => sum + entry.consumed, 0);
    const remaining = entries.reduce((sum, entry) => sum + entry.remaining, 0);

    return {
      rootTaskId,
      allocated: root.cost.allocated,
      consumed,
      remaining,
      entries,
    };
  }

  public close(): void {
    // Guard: never overwrite a good snapshot with an empty/smaller state
    const existing = this.persistence.loadLatestSnapshot();
    const currentTaskCount = Object.keys(this.state.tasks).length;
    if (existing) {
      const existingTaskCount = Object.keys(existing.state.tasks).length;
      if (currentTaskCount === 0 && existingTaskCount > 0) {
        console.error(`[core] Refusing to save empty snapshot over ${existingTaskCount}-task snapshot at seq ${existing.sequence}`);
      } else {
        this.persistence.saveSnapshot(this.state);
      }
    } else {
      this.persistence.saveSnapshot(this.state);
    }
    this.persistence.close();
  }

  private restoreState(): SystemState {
    const snapshot = this.persistence.loadLatestSnapshot();
    const baseState = snapshot?.state ?? createInitialState();
    const baseSequence = snapshot?.sequence ?? 0;

    const events = this.persistence.loadEventsSince(baseSequence);
    if (events.length === 0) {
      return baseState;
    }

    let state = baseState;

    let skipped = 0;
    for (const envelope of events) {
      const result = reduce(state, envelope.event);
      if (!result.ok) {
        // Log and skip invalid events during replay (data corruption recovery)
        console.error(
          `[core] Skipping invalid event at seq ${envelope.sequence} (${envelope.event.type} on ${envelope.event.taskId}): ${result.error.message}`,
        );
        skipped++;
        continue;
      }

      state = result.value.state;
      state.sequence = envelope.sequence;
      const lastEvent = state.events[state.events.length - 1];
      if (lastEvent) {
        lastEvent.sequence = envelope.sequence;
      }
    }

    if (skipped > 0) {
      console.error(`[core] Replay complete: ${skipped} invalid event(s) skipped`);
    }

    // Always re-number in-memory envelopes to be contiguous after replay.
    // Handles skipped events, duplicate sequences, and other log corruption.
    for (let i = 0; i < state.events.length; i++) {
      state.events[i]!.sequence = i + 1;
    }
    state.sequence = state.events.length;
    if (this.persistence.resetSequence) {
      this.persistence.resetSequence(state.sequence);
    }

    if (this.clockPollMs > 0) {
      // clockPollMs is stored for runtime integrations that call tick() periodically.
      // Keeping this field avoids API churn while preserving deterministic core behavior.
      void this.clockPollMs;
    }

    return state;
  }
}

export function createCore(options: CoreOptions): OrchestrationCore {
  return new OrchestrationCore(options);
}
