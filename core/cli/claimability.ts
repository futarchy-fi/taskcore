type QueueTask = Record<string, unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function readString(obj: Record<string, unknown>, key: string): string {
  const value = obj[key];
  return typeof value === "string" ? value.trim() : "";
}

function readNumber(obj: Record<string, unknown>, key: string): number {
  const value = obj[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function priorityRank(priority: string): number {
  switch (priority) {
    case "critical": return 0;
    case "high": return 1;
    case "medium": return 2;
    case "low": return 3;
    case "backlog": return 4;
    default: return 9;
  }
}

export function agentRole(agentId: string): string {
  const trimmed = agentId.trim();
  const dot = trimmed.indexOf(".");
  return dot >= 0 ? trimmed.slice(0, dot) : trimmed;
}

export function isReviewTask(task: QueueTask): boolean {
  return readString(task, "phase") === "review";
}

export function isReadyNonTerminalTask(task: QueueTask): boolean {
  return readString(task, "terminal") === "" && readString(task, "condition") === "ready";
}

function claimTarget(task: QueueTask): string {
  const metadata = asRecord(task["metadata"]);
  return isReviewTask(task)
    ? readString(metadata, "reviewer")
    : readString(metadata, "assignee");
}

export function isUnassignedClaimTarget(task: QueueTask): boolean {
  const target = claimTarget(task);
  return target === "" || target === "unset";
}

export function isClaimTargetOwnedByRole(task: QueueTask, claimRole: string | null | undefined): boolean {
  if (!claimRole) return false;
  const target = claimTarget(task);
  if (target === "" || target === "unset") return false;
  return agentRole(target) === claimRole;
}

export function isClaimableByRole(task: QueueTask, claimRole: string | null | undefined): boolean {
  if (!claimRole) return true;
  return isUnassignedClaimTarget(task) || isClaimTargetOwnedByRole(task, claimRole);
}

export function claimabilityRoleTag(task: QueueTask, claimRole: string | null | undefined): string {
  if (!claimRole) return "";
  if (isClaimTargetOwnedByRole(task, claimRole)) return " *";
  if (isUnassignedClaimTarget(task)) return " +";
  return "";
}

export function compareClaimableTasks(a: QueueTask, b: QueueTask, claimRole: string | null | undefined): number {
  const rankDelta = claimabilityRank(a, claimRole) - claimabilityRank(b, claimRole);
  if (rankDelta !== 0) return rankDelta;

  const metaA = asRecord(a["metadata"]);
  const metaB = asRecord(b["metadata"]);
  const priorityDelta = priorityRank(readString(metaA, "priority")) - priorityRank(readString(metaB, "priority"));
  if (priorityDelta !== 0) return priorityDelta;

  return readNumber(b, "updatedAt") - readNumber(a, "updatedAt");
}

export function filterClaimableTasks<T extends QueueTask>(tasks: T[], claimRole: string | null | undefined): T[] {
  return tasks
    .filter((task) => isReadyNonTerminalTask(task))
    .filter((task) => isClaimableByRole(task, claimRole));
}

export type ReviewQueueScope = "all" | "claimable" | "mine";

export function includeReviewQueueTask(
  task: QueueTask,
  claimRole: string | null | undefined,
  scope: ReviewQueueScope,
): boolean {
  if (!isReadyNonTerminalTask(task) || !isReviewTask(task)) return false;
  if (scope === "all") return true;
  if (scope === "mine") return isClaimTargetOwnedByRole(task, claimRole);
  return isClaimableByRole(task, claimRole);
}

function claimabilityRank(task: QueueTask, claimRole: string | null | undefined): number {
  if (!claimRole) return 0;
  if (isClaimTargetOwnedByRole(task, claimRole)) return 0;
  if (isUnassignedClaimTarget(task)) return 1;
  return 2;
}
