export type TaskId = string;
export type AgentId = string;
export type SessionId = string;
export type CheckpointId = string;
export type DependencyId = string;
export type Timestamp = number;
export type Duration = number;

export type Phase = "analysis" | "decomposition" | "execution" | "review";
export type Condition = "ready" | "leased" | "active" | "waiting" | "retryWait" | "exhausted";
export type Terminal = "done" | "failed" | "blocked" | "canceled";

export const PHASES: readonly Phase[] = ["analysis", "decomposition", "execution", "review"];
export const CONDITIONS: readonly Condition[] = ["ready", "leased", "active", "waiting", "retryWait", "exhausted"];
export const TERMINALS: readonly Terminal[] = ["done", "failed", "blocked", "canceled"];

export interface AttemptBudget {
  used: number;
  max: number;
}

export interface AttemptBudgets {
  analysis: AttemptBudget;
  decomposition: AttemptBudget;
  execution: AttemptBudget;
  review: AttemptBudget;
}

export interface AttemptBudgetMaxInput {
  analysis: { max: number };
  decomposition: { max: number };
  execution: { max: number };
  review: { max: number };
}

export const DEFAULT_ATTEMPT_BUDGETS: AttemptBudgetMaxInput = {
  analysis: { max: 4 },
  decomposition: { max: 3 },
  execution: { max: 8 },
  review: { max: 6 },
};

export interface CostBudget {
  allocated: number;
  consumed: number;
  childAllocated: number;
  childRecovered: number;
}

export interface Dependency {
  id: DependencyId;
  type: "task" | "consultation" | "ack" | "external";
  target: string;
  blocking: boolean;
  timing: "before_start" | "during";
  status: "pending" | "fulfilled" | "timed_out" | "skipped";
}

export interface StateRef {
  branch: string;
  commit: string;
  parentCommit: string;
}

export interface CheckpointRef {
  id: CheckpointId;
  stateRef: StateRef;
  createdAt: Timestamp;
  reason: string;
  phase: Phase;
  condition: Condition;
}

export interface ApproachRecord {
  version: number;
  description: string;
  childIds: TaskId[];
  outcome: "active" | "succeeded" | "failed" | "superseded";
  failureSummary: string | null;
}

export interface FailureSummary {
  childId: TaskId | null;
  approach: string;
  whatFailed: string;
  whatWasLearned: string;
  artifactRef: StateRef | null;
}

export interface IsolationRule {
  exclude: string;
  reason: string;
}

export interface ReviewConfig {
  required: boolean;
  attemptBudget: number;
  isolationRules: IsolationRule[];
}

export interface ReviewVerdict {
  reviewer: AgentId;
  round: number;
  verdict: "approve" | "changes_requested" | "reject" | "needs_discussion";
  reasoning: string;
}

export type CompletionVerificationMode = "code-task" | "journal-only" | "coordinator" | "aggregate";

export interface CodeTaskCompletionProof {
  kind: "code-task";
  commitRef: string;
  changedFiles: string[];
  testsPassed: boolean;
  testResults?: string;
  prRef?: string;
}

export interface JournalOnlyCompletionProof {
  kind: "journal-only";
  journalPath: string;
  summary: string;
  actionable: boolean;
}

export interface CoordinatorCompletionProof {
  kind: "coordinator";
  childTaskIds: TaskId[];
  summary: string;
  allChildrenSucceeded: boolean;
}

export interface AggregateCompletionProof {
  kind: "aggregate";
  componentResults: Array<{
    name: string;
    status: "succeeded" | "failed" | "skipped";
    evidenceRef?: string;
  }>;
  summary: string;
  criticalPathMet: boolean;
}

export type CompletionProof =
  | CodeTaskCompletionProof
  | JournalOnlyCompletionProof
  | CoordinatorCompletionProof
  | AggregateCompletionProof;

export interface CodeTaskCompletionResult {
  kind: "code-task";
  status: "verified";
  verifiedCommitRef: string;
  changedFileCount: number;
  testsPassed: boolean;
}

export interface JournalOnlyCompletionResult {
  kind: "journal-only";
  status: "verified";
  recordedJournalPath: string;
  actionable: boolean;
}

export interface CoordinatorCompletionResult {
  kind: "coordinator";
  status: "verified";
  childTaskCount: number;
  successfulChildCount: number;
  allChildrenSucceeded: boolean;
}

export interface AggregateCompletionResult {
  kind: "aggregate";
  status: "verified";
  componentCount: number;
  succeededCount: number;
  failedCount: number;
  skippedCount: number;
  criticalPathMet: boolean;
}

export type CompletionVerificationResult =
  | CodeTaskCompletionResult
  | JournalOnlyCompletionResult
  | CoordinatorCompletionResult
  | AggregateCompletionResult;

export function buildCompletionVerificationResult(proof: CompletionProof): CompletionVerificationResult {
  switch (proof.kind) {
    case "code-task":
      return {
        kind: "code-task",
        status: "verified",
        verifiedCommitRef: proof.commitRef,
        changedFileCount: proof.changedFiles.length,
        testsPassed: proof.testsPassed,
      };
    case "journal-only":
      return {
        kind: "journal-only",
        status: "verified",
        recordedJournalPath: proof.journalPath,
        actionable: proof.actionable,
      };
    case "coordinator": {
      const successfulChildCount = proof.allChildrenSucceeded ? proof.childTaskIds.length : 0;
      return {
        kind: "coordinator",
        status: "verified",
        childTaskCount: proof.childTaskIds.length,
        successfulChildCount,
        allChildrenSucceeded: proof.allChildrenSucceeded,
      };
    }
    case "aggregate": {
      let succeededCount = 0;
      let failedCount = 0;
      let skippedCount = 0;
      for (const component of proof.componentResults) {
        if (component.status === "succeeded") {
          succeededCount += 1;
        } else if (component.status === "failed") {
          failedCount += 1;
        } else {
          skippedCount += 1;
        }
      }
      return {
        kind: "aggregate",
        status: "verified",
        componentCount: proof.componentResults.length,
        succeededCount,
        failedCount,
        skippedCount,
        criticalPathMet: proof.criticalPathMet,
      };
    }
  }
}

export interface CompletionVerification {
  mode: CompletionVerificationMode;
  proof: CompletionProof;
  result: CompletionVerificationResult;
  verifiedAt: Timestamp;
  verifiedBy?: AgentId;
}

export interface TaskVerificationState {
  requiredMode: CompletionVerificationMode;
  satisfied: boolean;
  verification: CompletionVerification | null;
  satisfiedAt: Timestamp | null;
}

export interface ReviewState {
  round: number;
  verdicts: ReviewVerdict[];
  status: "collecting" | "consensus" | "escalated";
}

export interface WaitState {
  dependencyId: DependencyId;
  returnPhase: Phase;
  returnCondition: Condition;
}

export interface Task {
  id: TaskId;
  title: string;
  description: string;
  parentId: TaskId | null;
  rootId: TaskId;

  phase: Phase | null;
  condition: Condition | null;
  terminal: Terminal | null;

  currentFenceToken: number;
  leasedTo: AgentId | null;
  leaseExpiresAt: Timestamp | null;
  retryAfter: Timestamp | null;
  lastAgentExitAt: Timestamp | null;

  attempts: AttemptBudgets;

  cost: CostBudget;

  decompositionVersion: number;
  children: TaskId[];
  checkpoints: TaskId[];
  costRecoveredToParent: boolean;
  triggeredCheckpoints: TaskId[];
  completionRule: "and";

  dependencies: Dependency[];

  approachHistory: ApproachRecord[];
  failureSummaries: FailureSummary[];
  failureDigestVersion: number;
  terminalSummary: FailureSummary | null;

  stateRef: StateRef | null;
  checkpointRefs: CheckpointRef[];

  reviewConfig: ReviewConfig | null;
  reviewState: ReviewState | null;

  sessionPolicy: "fresh" | "continuable";
  currentSessionId: SessionId | null;

  contextIsolation: IsolationRule[];
  contextBudget: number;

  waitState: WaitState | null;

  createdAt: Timestamp;
  updatedAt: Timestamp;
  metadata: Record<string, unknown>;
  verification: TaskVerificationState;
}

export interface AgentContext {
  sessionId: SessionId;
  agentId: AgentId;
  memoryRef: string | null;
  contextTokens: number | null;
  modelId: string;
}

export interface EventSource {
  type: "core" | "middle" | "agent" | "human";
  id: string;
}

export interface BaseEvent {
  type: string;
  taskId: TaskId;
  ts: Timestamp;
}

export interface TaskCreated extends BaseEvent {
  type: "TaskCreated";
  title: string;
  description: string;
  parentId: TaskId | null;
  rootId: TaskId;
  initialPhase: Phase;
  initialCondition: Condition;
  attemptBudgets: AttemptBudgetMaxInput;
  costBudget: number;
  dependencies: Dependency[];
  reviewConfig: ReviewConfig | null;
  skipAnalysis: boolean;
  metadata: Record<string, unknown>;
  source: EventSource;
  completionVerificationMode?: CompletionVerificationMode;
}

export interface LeaseGranted extends BaseEvent {
  type: "LeaseGranted";
  fenceToken: number;
  agentId: AgentId;
  phase: Phase;
  leaseTimeout: Duration;
  sessionId: SessionId;
  sessionType: "fresh" | "continued";
  contextBudget: number;
}

export interface LeaseExpired extends BaseEvent {
  type: "LeaseExpired";
  fenceToken: number;
  reason: "timeout";
  source: EventSource;
}

export interface AgentStarted extends BaseEvent {
  type: "AgentStarted";
  fenceToken: number;
  agentContext: AgentContext;
}

export interface AgentExited extends BaseEvent {
  type: "AgentExited";
  fenceToken: number;
  exitCode: number;
  reportedCost: number;
  agentContext: AgentContext;
}

export type PhaseTransitionReason =
  | "decision_execute"
  | "decision_decompose"
  | "work_complete"
  | "too_complex"
  | "approach_not_viable"
  | "changes_requested"
  | "wrong_approach"
  | "needs_redecomp"
  | "add_children"
  | "children_all_failed"
  | "children_created"
  | "children_complete";

export interface PhaseTransition extends BaseEvent {
  type: "PhaseTransition";
  from: { phase: Phase; condition: Condition };
  to: { phase: Phase; condition: Condition };
  reasonCode: PhaseTransitionReason;
  reason: string;
  fenceToken: number;
  agentContext: AgentContext;
}

export interface WaitRequested extends BaseEvent {
  type: "WaitRequested";
  fenceToken: number;
  dependency: Dependency;
  returnPhase: Phase;
  returnCondition: Condition;
  agentContext: AgentContext;
}

export interface WaitResolved extends BaseEvent {
  type: "WaitResolved";
  dependencyId: DependencyId;
  resolution: "fulfilled" | "timed_out" | "redirected";
  action: "resume" | "redirect_to_analysis" | "block" | "redirect_wait";
  payload: unknown;
  source: EventSource;
  summary?: FailureSummary;
}

export interface DependencySatisfied extends BaseEvent {
  type: "DependencySatisfied";
  dependencyId: DependencyId;
  satisfiedBy: TaskId;
  source: EventSource;
}

export interface RetryScheduled extends BaseEvent {
  type: "RetryScheduled";
  fenceToken: number;
  reason: "agent_crashed" | "agent_timeout" | "lease_expired" | "no_progress" | "agent_exit_followup_timeout" | "orphaned_on_restart";
  retryAfter: Timestamp;
  phase: Phase;
  attemptNumber: number;
}

export interface BackoffExpired extends BaseEvent {
  type: "BackoffExpired";
  phase: Phase;
  source: EventSource;
}

export interface DecompositionChildSpec {
  taskId: TaskId;
  title: string;
  description: string;
  costAllocation: number;
  skipAnalysis: boolean;
  dependencies: Dependency[];
  attemptBudgets?: AttemptBudgetMaxInput;
  reviewConfig?: ReviewConfig | null;
  metadata?: Record<string, unknown>;
  completionVerificationMode?: CompletionVerificationMode;
}

export interface DecompositionCreated extends BaseEvent {
  type: "DecompositionCreated";
  fenceToken: number;
  version: number;
  children: DecompositionChildSpec[];
  checkpoints: TaskId[];
  completionRule: "and";
  agentContext: AgentContext;
}

export interface ChildCostRecovered extends BaseEvent {
  type: "ChildCostRecovered";
  childId: TaskId;
  recoveredAmount: number;
  source: EventSource;
}

export interface CheckpointTriggered extends BaseEvent {
  type: "CheckpointTriggered";
  childId: TaskId;
  source: EventSource;
}

export interface CheckpointCreated extends BaseEvent {
  type: "CheckpointCreated";
  checkpointId: CheckpointId;
  stateRef: StateRef;
  reason: string;
  phase: Phase;
  condition: Condition;
}

export interface StateReverted extends BaseEvent {
  type: "StateReverted";
  revertTo: CheckpointId;
  targetStateRef: StateRef;
  reason: string;
  preserving: string[];
  source: EventSource;
}

export interface ReviewVerdictSubmitted extends BaseEvent {
  type: "ReviewVerdictSubmitted";
  fenceToken: number;
  reviewer: AgentId;
  round: number;
  verdict: "approve" | "changes_requested" | "reject" | "needs_discussion";
  reasoning: string;
  agentContext: AgentContext;
}

export interface ReviewPolicyMet extends BaseEvent {
  type: "ReviewPolicyMet";
  outcome: "approved" | "changes_requested" | "escalated";
  summary: string;
  source: EventSource;
}

export interface TaskCompleted extends BaseEvent {
  type: "TaskCompleted";
  stateRef: StateRef;
  verification: CompletionVerification;
}

export interface TaskFailed extends BaseEvent {
  type: "TaskFailed";
  reason: "budget_exhausted" | "cost_exhausted";
  phase: Phase;
  summary: FailureSummary;
}

export interface TaskExhausted extends BaseEvent {
  type: "TaskExhausted";
  reason: "budget_exhausted" | "cost_exhausted";
  phase: Phase;
  source: EventSource;
}

export interface BudgetIncreased extends BaseEvent {
  type: "BudgetIncreased";
  attemptBudgetIncrease: Partial<AttemptBudgetMaxInput> | null;
  costBudgetIncrease: number;
  reason: string;
  source: EventSource;
}

export interface TaskBlocked extends BaseEvent {
  type: "TaskBlocked";
  reason: string;
  reasonCode: string;
  summary: FailureSummary;
  source: EventSource;
}

export interface TaskCanceled extends BaseEvent {
  type: "TaskCanceled";
  reason: "parent_redecomposed" | "manual" | "dependency_failed";
  source: EventSource;
}

export interface TaskRevived extends BaseEvent {
  type: "TaskRevived";
  phase: Phase;
  resetAttempts: Phase[];
  reason: string;
  source: EventSource;
}

export interface TaskReparented extends BaseEvent {
  type: "TaskReparented";
  oldParentId: TaskId | null;
  newParentId: TaskId;
  oldRootId: TaskId;
  newRootId: TaskId;
  source: EventSource;
}

export interface MetadataUpdated extends BaseEvent {
  type: "MetadataUpdated";
  patch: Record<string, unknown>;
  reason: string;
  source: EventSource;
}

export type Event =
  | TaskCreated
  | LeaseGranted
  | LeaseExpired
  | AgentStarted
  | AgentExited
  | PhaseTransition
  | WaitRequested
  | WaitResolved
  | DependencySatisfied
  | RetryScheduled
  | BackoffExpired
  | DecompositionCreated
  | ChildCostRecovered
  | CheckpointTriggered
  | CheckpointCreated
  | StateReverted
  | ReviewVerdictSubmitted
  | ReviewPolicyMet
  | TaskCompleted
  | TaskFailed
  | TaskExhausted
  | BudgetIncreased
  | TaskBlocked
  | TaskCanceled
  | TaskRevived
  | TaskReparented
  | MetadataUpdated;

export type EventType = Event["type"];

export interface EventEnvelope {
  sequence: number;
  event: Event;
}

export interface SystemState {
  tasks: Record<TaskId, Task>;
  events: EventEnvelope[];
  sequence: number;
}

export interface ValidationError {
  code: string;
  message: string;
  taskId?: TaskId;
  eventType?: EventType;
  details?: Record<string, unknown>;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

export interface ReduceResult {
  state: SystemState;
  emitted: Event[];
}

export interface DependencyGraphEdge {
  fromTaskId: TaskId;
  dependencyId: DependencyId;
  to: string;
  blocking: boolean;
  timing: "before_start" | "during";
  status: Dependency["status"];
}

export interface DependencyGraph {
  nodes: TaskId[];
  edges: DependencyGraphEdge[];
}

export interface SearchTreeNode {
  taskId: TaskId;
  title: string;
  terminal: Terminal | null;
  phase: Phase | null;
  condition: Condition | null;
  approaches: ApproachRecord[];
  children: SearchTreeNode[];
}

export interface CostSummaryEntry {
  taskId: TaskId;
  allocated: number;
  consumed: number;
  remaining: number;
}

export interface CostSummary {
  rootTaskId: TaskId;
  allocated: number;
  consumed: number;
  remaining: number;
  entries: CostSummaryEntry[];
}

export interface SnapshotRow {
  sequence: number;
  state: SystemState;
  createdAt: number;
}

/**
 * Persistence backend contract. Both SQLite and JSONL backends implement this.
 * The core treats persistence as an opaque append-only event store with
 * optional snapshot support.
 */
export interface Persistence {
  appendEvent(event: Event): number;
  loadEventsSince(sequence: number): EventEnvelope[];
  loadTaskEvents(taskId: string): EventEnvelope[];
  saveSnapshot(state: SystemState): void;
  loadLatestSnapshot(): SnapshotRow | null;
  rebuildState(reducer: (state: SystemState, event: Event) => SystemState): SystemState;
  truncateAll(): void;
  close(): void;
  /** Reset internal sequence counter (used after corrupt-data recovery) */
  resetSequence?(sequence: number): void;
}

export interface CoreOptions {
  dbPath: string;
  eventLogDir?: string;
  persistenceBackend?: "jsonl" | "sqlite";
  snapshotEvery?: number;
  clockPollMs?: number;
  invariantChecks?: boolean;
}

export function computeCostRemaining(cost: CostBudget): number {
  return cost.allocated - cost.consumed - cost.childAllocated + cost.childRecovered;
}

export function cloneAttemptBudgets(input: AttemptBudgetMaxInput): AttemptBudgets {
  return {
    analysis: { used: 0, max: input.analysis.max },
    decomposition: { used: 0, max: input.decomposition.max },
    execution: { used: 0, max: input.execution.max },
    review: { used: 0, max: input.review.max },
  };
}

export function isTerminalTask(task: Task): boolean {
  return task.terminal !== null;
}

export function createInitialState(): SystemState {
  return {
    tasks: {},
    events: [],
    sequence: 0,
  };
}
