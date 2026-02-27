import {
  computeCostRemaining,
  type Condition,
  type DependencyGraph,
  type DependencyGraphEdge,
  type Phase,
  type SystemState,
  type Task,
  type TaskId,
} from "./types.js";

function hasBlockingBeforeStartDeps(task: Task): boolean {
  return task.dependencies.some(
    (dependency) =>
      dependency.blocking &&
      dependency.timing === "before_start" &&
      dependency.status !== "fulfilled",
  );
}

export function isDispatchable(task: Task): boolean {
  if (task.terminal !== null || task.phase === null || task.condition === null) {
    return false;
  }

  if (task.condition !== "ready") {
    return false;
  }

  if (hasBlockingBeforeStartDeps(task)) {
    return false;
  }

  const attemptBudget = task.attempts[task.phase];
  if (attemptBudget.used >= attemptBudget.max) {
    return false;
  }

  if (computeCostRemaining(task.cost) <= 0) {
    return false;
  }

  return true;
}

export function getDispatchableTasks(state: SystemState): Task[] {
  return Object.values(state.tasks)
    .filter((task) => isDispatchable(task))
    .sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt - b.createdAt;
      }
      return a.id.localeCompare(b.id);
    });
}

export function getTasksByState(state: SystemState, phase: Phase, condition: Condition): Task[] {
  return Object.values(state.tasks).filter(
    (task) => task.phase === phase && task.condition === condition && task.terminal === null,
  );
}

export function getChildren(state: SystemState, taskId: TaskId): Task[] {
  const task = state.tasks[taskId];
  if (!task) {
    return [];
  }
  return task.children
    .map((childId) => state.tasks[childId])
    .filter((child): child is Task => child !== undefined);
}

export function getAncestors(state: SystemState, taskId: TaskId): Task[] {
  const ancestors: Task[] = [];
  let current = state.tasks[taskId];

  while (current?.parentId) {
    const parent = state.tasks[current.parentId];
    if (!parent) {
      break;
    }
    ancestors.push(parent);
    current = parent;
  }

  return ancestors;
}

export function getDependencyGraph(state: SystemState): DependencyGraph {
  const edges: DependencyGraphEdge[] = [];

  for (const task of Object.values(state.tasks)) {
    for (const dependency of task.dependencies) {
      edges.push({
        fromTaskId: task.id,
        dependencyId: dependency.id,
        to: dependency.target,
        blocking: dependency.blocking,
        timing: dependency.timing,
        status: dependency.status,
      });
    }
  }

  return {
    nodes: Object.keys(state.tasks),
    edges,
  };
}

function subtreeDepth(state: SystemState, taskId: TaskId): number {
  const task = state.tasks[taskId];
  if (!task || task.children.length === 0) {
    return 1;
  }

  let maxDepth = 0;
  for (const childId of task.children) {
    maxDepth = Math.max(maxDepth, subtreeDepth(state, childId));
  }

  return maxDepth + 1;
}

export function getCriticalPath(state: SystemState, rootTaskId: TaskId): TaskId[] {
  const path: TaskId[] = [];
  let current = state.tasks[rootTaskId];

  while (current) {
    path.push(current.id);
    if (current.children.length === 0) {
      break;
    }

    let nextChild: Task | undefined;
    let bestDepth = -1;
    for (const childId of current.children) {
      const child = state.tasks[childId];
      if (!child) {
        continue;
      }
      const depth = subtreeDepth(state, child.id);
      if (depth > bestDepth) {
        bestDepth = depth;
        nextChild = child;
      }
    }

    current = nextChild;
  }

  return path;
}
