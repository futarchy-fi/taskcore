import { z } from "zod";

// ---------------------------------------------------------------------------
// Basic types
// ---------------------------------------------------------------------------

export const TaskIdSchema = z.string();
export const AgentIdSchema = z.string();
export const SessionIdSchema = z.string();
export const CheckpointIdSchema = z.string();
export const DependencyIdSchema = z.string();
export const TimestampSchema = z.number().int().nonnegative();
export const DurationSchema = z.number().int().nonnegative();

// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------

export const PhaseSchema = z.enum(["analysis", "decomposition", "execution", "review"]);
export const ConditionSchema = z.enum(["ready", "active", "waiting", "retryWait", "exhausted"]);
export const TerminalSchema = z.enum(["done", "failed", "blocked", "canceled"]);

export const PHASES = ["analysis", "decomposition", "execution", "review"] as const;
export const CONDITIONS = ["ready", "active", "waiting", "retryWait", "exhausted"] as const;
export const TERMINALS = ["done", "failed", "blocked", "canceled"] as const;

// ---------------------------------------------------------------------------
// Attempt budgets
// ---------------------------------------------------------------------------

export const AttemptBudgetSchema = z.object({
  used: z.number().int().nonnegative(),
  max: z.number().int().positive(),
});

export const AttemptBudgetMaxInputSchema = z.object({
  analysis: z.object({ max: z.number().int().positive() }),
  decomposition: z.object({ max: z.number().int().positive() }),
  execution: z.object({ max: z.number().int().positive() }),
  review: z.object({ max: z.number().int().positive() }),
});

export const AttemptBudgetsSchema = z.object({
  analysis: AttemptBudgetSchema,
  decomposition: AttemptBudgetSchema,
  execution: AttemptBudgetSchema,
  review: AttemptBudgetSchema,
});

export const DEFAULT_ATTEMPT_BUDGETS: z.infer<typeof AttemptBudgetMaxInputSchema> = {
  analysis: { max: 4 },
  decomposition: { max: 3 },
  execution: { max: 8 },
  review: { max: 6 },
};

// ---------------------------------------------------------------------------
// Cost budgets
// ---------------------------------------------------------------------------

export const CostBudgetSchema = z.object({
  allocated: z.number().nonnegative(),
  consumed: z.number().nonnegative(),
  childAllocated: z.number().nonnegative(),
  childRecovered: z.number().nonnegative(),
});

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

export const DependencySchema = z.object({
  id: DependencyIdSchema,
  type: z.enum(["task", "consultation", "ack", "external"]),
  target: z.string(),
  blocking: z.boolean(),
  timing: z.enum(["before_start", "during"]),
  status: z.enum(["pending", "fulfilled", "timed_out", "skipped"]),
});

// ---------------------------------------------------------------------------
// State references
// ---------------------------------------------------------------------------

export const StateRefSchema = z.object({
  branch: z.string(),
  commit: z.string(),
  parentCommit: z.string(),
});

export const CheckpointRefSchema = z.object({
  id: CheckpointIdSchema,
  stateRef: StateRefSchema,
  createdAt: TimestampSchema,
  reason: z.string(),
  phase: PhaseSchema.nullable(),
  condition: ConditionSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Approach and failure tracking
// ---------------------------------------------------------------------------

export const ApproachRecordSchema = z.object({
  version: z.number().int().nonnegative(),
  description: z.string(),
  childIds: z.array(TaskIdSchema),
  outcome: z.enum(["active", "succeeded", "failed", "superseded"]),
  failureSummary: z.string().nullable(),
});

export const FailureSummarySchema = z.object({
  childId: TaskIdSchema.nullable(),
  approach: z.string().min(1),
  whatFailed: z.string().min(1),
  whatWasLearned: z.string().min(1),
  artifactRef: StateRefSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Isolation rules
// ---------------------------------------------------------------------------

export const IsolationRuleSchema = z.object({
  exclude: z.string(),
  reason: z.string(),
});

// ---------------------------------------------------------------------------
// Review system
// ---------------------------------------------------------------------------

export const ReviewConfigSchema = z.object({
  required: z.boolean(),
  attemptBudget: z.number().int().nonnegative(),
  isolationRules: z.array(IsolationRuleSchema),
});

export const ReviewVerdictSchema = z.object({
  reviewer: AgentIdSchema,
  round: z.number().int().nonnegative(),
  verdict: z.enum(["approve", "changes_requested", "reject", "needs_discussion"]),
  reasoning: z.string(),
});

export const ReviewStateSchema = z.object({
  round: z.number().int().nonnegative(),
  verdicts: z.array(ReviewVerdictSchema),
  status: z.enum(["collecting", "consensus", "escalated"]),
});

// ---------------------------------------------------------------------------
// Wait states
// ---------------------------------------------------------------------------

export const DependencyWaitStateSchema = z.object({
  dependencyId: DependencyIdSchema,
  returnPhase: PhaseSchema,
  returnCondition: ConditionSchema,
});

export const SiblingTurnWaitStateSchema = z.object({
  kind: z.literal("sibling_turn"),
  parentId: TaskIdSchema,
});

export const WaitStateSchema = z.discriminatedUnion("kind", [
  SiblingTurnWaitStateSchema,
  z.object({
    kind: z.literal("dependency"),
    dependencyId: DependencyIdSchema,
    returnPhase: PhaseSchema,
    returnCondition: ConditionSchema,
  }),
]);

// ---------------------------------------------------------------------------
// Sequential coordination
// ---------------------------------------------------------------------------

export const SequentialCoordinationSchema = z.object({
  mode: z.enum(["legacy_parallel", "sequential_children"]),
  reviewBetweenChildren: z.boolean(),
  childOrder: z.array(TaskIdSchema),
  nextChildIndex: z.number().int().nonnegative(),
  activeChildId: TaskIdSchema.nullable(),
  lastCompletedChildId: TaskIdSchema.nullable(),
});

// ---------------------------------------------------------------------------
// Task
// ---------------------------------------------------------------------------

export const TaskSchema = z.object({
  id: TaskIdSchema,
  title: z.string(),
  description: z.string(),
  parentId: TaskIdSchema.nullable(),
  rootId: TaskIdSchema,

  phase: PhaseSchema.nullable(),
  condition: ConditionSchema.nullable(),
  terminal: TerminalSchema.nullable(),

  currentFenceToken: z.number().int().nonnegative(),
  leasedTo: AgentIdSchema.nullable(),
  leaseExpiresAt: TimestampSchema.nullable(),
  retryAfter: TimestampSchema.nullable(),
  lastAgentExitAt: TimestampSchema.nullable(),

  attempts: AttemptBudgetsSchema,
  cost: CostBudgetSchema,

  decompositionVersion: z.number().int().nonnegative(),
  children: z.array(TaskIdSchema),
  checkpoints: z.array(TaskIdSchema),
  costRecoveredToParent: z.boolean(),
  triggeredCheckpoints: z.array(TaskIdSchema),
  completionRule: z.literal("and"),

  dependencies: z.array(DependencySchema),

  approachHistory: z.array(ApproachRecordSchema),
  failureSummaries: z.array(FailureSummarySchema),
  failureDigestVersion: z.number().int().nonnegative(),
  terminalSummary: FailureSummarySchema.nullable(),

  stateRef: StateRefSchema.nullable(),
  checkpointRefs: z.array(CheckpointRefSchema),

  reviewConfig: ReviewConfigSchema.nullable(),
  reviewState: ReviewStateSchema.nullable(),

  sessionPolicy: z.enum(["fresh", "continuable"]),
  currentSessionId: SessionIdSchema.nullable(),

  contextIsolation: z.array(IsolationRuleSchema),
  contextBudget: z.number().nonnegative(),

  waitState: WaitStateSchema.nullable(),
  coordination: SequentialCoordinationSchema.nullable(),
  lastCompletionVerification: z.any().nullable(), // CompletionVerification defined later

  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  metadata: z.record(z.unknown()),
});

// ---------------------------------------------------------------------------
// Agent context
// ---------------------------------------------------------------------------

export const AgentContextSchema = z.object({
  sessionId: SessionIdSchema,
  agentId: AgentIdSchema,
  memoryRef: z.string().nullable(),
  contextTokens: z.number().int().nullable(),
  modelId: z.string(),
});

// ---------------------------------------------------------------------------
// Event sources
// ---------------------------------------------------------------------------

export const EventSourceSchema = z.object({
  type: z.enum(["core", "middle", "agent", "human"]),
  id: z.string(),
});

// ---------------------------------------------------------------------------
// Base event
// ---------------------------------------------------------------------------

export const BaseEventSchema = z.object({
  type: z.string(),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
});

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export const TaskCreatedSchema = z.object({
  type: z.literal("TaskCreated"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  title: z.string(),
  description: z.string(),
  parentId: TaskIdSchema.nullable(),
  rootId: TaskIdSchema,
  initialPhase: PhaseSchema,
  initialCondition: ConditionSchema,
  attemptBudgets: AttemptBudgetMaxInputSchema,
  costBudget: z.number().nonnegative(),
  dependencies: z.array(DependencySchema),
  reviewConfig: ReviewConfigSchema.nullable(),
  skipAnalysis: z.boolean(),
  metadata: z.record(z.unknown()),
  source: EventSourceSchema,
});

export const LeaseGrantedSchema = z.object({
  type: z.literal("LeaseGranted"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  agentId: AgentIdSchema,
  phase: PhaseSchema,
  leaseTimeout: DurationSchema,
  sessionId: SessionIdSchema,
  sessionType: z.enum(["fresh", "continued"]),
  contextBudget: z.number().nonnegative(),
  agentContext: AgentContextSchema,
});

export const LeaseExpiredSchema = z.object({
  type: z.literal("LeaseExpired"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  reason: z.literal("timeout"),
  source: EventSourceSchema,
});

export const LeaseReleasedSchema = z.object({
  type: z.literal("LeaseReleased"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  reason: z.string(),
  phase: PhaseSchema,
  workPerformed: z.boolean(),
  source: EventSourceSchema,
});

export const LeaseExtendedSchema = z.object({
  type: z.literal("LeaseExtended"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  leaseTimeout: DurationSchema,
  source: EventSourceSchema,
});

export const AgentStartedSchema = z.object({
  type: z.literal("AgentStarted"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  agentContext: AgentContextSchema,
});

export const AgentExitedSchema = z.object({
  type: z.literal("AgentExited"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  exitCode: z.number().int(),
  reportedCost: z.number().nonnegative(),
  agentContext: AgentContextSchema,
});

export const CostReportedSchema = z.object({
  type: z.literal("CostReported"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  reportedCost: z.number().nonnegative(),
  source: EventSourceSchema,
});

export const PhaseTransitionReasonSchema = z.enum([
  "decision_execute",
  "decision_decompose",
  "work_complete",
  "too_complex",
  "approach_not_viable",
  "changes_requested",
  "wrong_approach",
  "needs_redecomp",
  "add_children",
  "children_all_failed",
  "children_created",
  "children_complete",
  "child_review_due",
]);

export const PhaseTransitionSchema = z.object({
  type: z.literal("PhaseTransition"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  from: z.object({
    phase: PhaseSchema,
    condition: ConditionSchema,
  }),
  to: z.object({
    phase: PhaseSchema,
    condition: ConditionSchema,
  }),
  reasonCode: PhaseTransitionReasonSchema,
  reason: z.string(),
  fenceToken: z.number().int().nonnegative(),
  agentContext: AgentContextSchema,
});

export const WaitRequestedSchema = z.object({
  type: z.literal("WaitRequested"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  dependency: DependencySchema,
  returnPhase: PhaseSchema,
  returnCondition: ConditionSchema,
  agentContext: AgentContextSchema,
});

export const WaitResolvedSchema = z.object({
  type: z.literal("WaitResolved"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  dependencyId: DependencyIdSchema,
  resolution: z.enum(["fulfilled", "timed_out", "redirected"]),
  action: z.enum(["resume", "redirect_to_analysis", "block", "redirect_wait"]),
  payload: z.unknown(),
  source: EventSourceSchema,
  summary: FailureSummarySchema.optional(),
});

export const DependencySatisfiedSchema = z.object({
  type: z.literal("DependencySatisfied"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  dependencyId: DependencyIdSchema,
  satisfiedBy: TaskIdSchema,
  source: EventSourceSchema,
});

export const RetryScheduledSchema = z.object({
  type: z.literal("RetryScheduled"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  reason: z.enum([
    "agent_crashed",
    "agent_timeout",
    "lease_expired",
    "no_progress",
    "agent_exit_followup_timeout",
    "orphaned_on_restart",
  ]),
  retryAfter: TimestampSchema,
  phase: PhaseSchema,
  attemptNumber: z.number().int().positive(),
});

export const BackoffExpiredSchema = z.object({
  type: z.literal("BackoffExpired"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  phase: PhaseSchema,
  source: EventSourceSchema,
});

export const DecompositionChildSpecSchema = z.object({
  taskId: TaskIdSchema,
  title: z.string(),
  description: z.string(),
  costAllocation: z.number().nonnegative(),
  skipAnalysis: z.boolean(),
  dependencies: z.array(DependencySchema),
  attemptBudgets: AttemptBudgetMaxInputSchema.optional(),
  reviewConfig: ReviewConfigSchema.nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const DecompositionCreatedSchema = z.object({
  type: z.literal("DecompositionCreated"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  version: z.number().int().nonnegative(),
  children: z.array(DecompositionChildSpecSchema),
  checkpoints: z.array(TaskIdSchema),
  completionRule: z.literal("and"),
  agentContext: AgentContextSchema,
  coordinationMode: z
    .object({
      mode: z.literal("sequential_children"),
      reviewBetweenChildren: z.boolean(),
    })
    .nullable()
    .optional(),
});

export const ChildActivatedSchema = z.object({
  type: z.literal("ChildActivated"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  parentId: TaskIdSchema,
  index: z.number().int().nonnegative(),
  source: EventSourceSchema,
});

export const ChildReviewDecisionSchema = z.enum([
  "continue_next_child",
  "redecompose_remaining",
  "stop_children",
]);

export const ChildReviewDecisionSubmittedSchema = z.object({
  type: z.literal("ChildReviewDecisionSubmitted"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  childId: TaskIdSchema,
  decision: ChildReviewDecisionSchema,
  fenceToken: z.number().int().nonnegative(),
  notes: z.string(),
  agentContext: AgentContextSchema,
});

export const ChildCostRecoveredSchema = z.object({
  type: z.literal("ChildCostRecovered"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  childId: TaskIdSchema,
  recoveredAmount: z.number().nonnegative(),
  source: EventSourceSchema,
});

export const CheckpointTriggeredSchema = z.object({
  type: z.literal("CheckpointTriggered"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  childId: TaskIdSchema,
  source: EventSourceSchema,
});

export const CheckpointCreatedSchema = z.object({
  type: z.literal("CheckpointCreated"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  checkpointId: CheckpointIdSchema,
  stateRef: StateRefSchema,
  reason: z.string(),
  phase: PhaseSchema,
  condition: ConditionSchema,
});

export const StateRevertedSchema = z.object({
  type: z.literal("StateReverted"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  revertTo: CheckpointIdSchema,
  targetStateRef: StateRefSchema,
  reason: z.string(),
  preserving: z.array(z.string()),
  source: EventSourceSchema,
});

export const ReviewVerdictSubmittedSchema = z.object({
  type: z.literal("ReviewVerdictSubmitted"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  fenceToken: z.number().int().nonnegative(),
  reviewer: AgentIdSchema,
  round: z.number().int().nonnegative(),
  verdict: z.enum(["approve", "changes_requested", "reject", "needs_discussion"]),
  reasoning: z.string(),
  agentContext: AgentContextSchema,
});

export const ReviewPolicyMetSchema = z.object({
  type: z.literal("ReviewPolicyMet"),
  taskId: TaskIdSchema,
  ts: TimestampSchema,
  outcome: z.enum(["approved", "changes_requested", "escalated"]),
  summary: z.string(),
  source: EventSourceSchema,
});

// ---------------------------------------------------------------------------
// Completion verification
// ---------------------------------------------------------------------------

export const ArtifactKindSchema = z.enum(["journal", "code", "pr"]);

export const ArtifactEvidenceSchema = z.object({
  kind: ArtifactKindSchema,
  repo: z.string().optional(),
  branch: z.string().optional(),
  baseRef: z.string().nullable().optional(),
  headRef: z.string().nullable().optional(),
  aheadCount: z.number().int().nullable().optional(),
  changedFiles: z.array(z.string()).optional(),
  prUrl: z.string().nullable().optional(),
});

export const CompletionVerificationSchema = z.object({
  passed: z.boolean(),
  reason: z.string(),
  checkedAt: z.string(),
  evidence: z.array(ArtifactEvidenceSchema),
});

export const CompletionVerificationRecordedSchema = BaseEventSchema.extend({
  type: z.literal("CompletionVerificationRecorded"),
  verification: CompletionVerificationSchema,
});

export const TaskCompletedSchema = BaseEventSchema.extend({
  type: z.literal("TaskCompleted"),
  stateRef: StateRefSchema,
});

export const TaskFailedSchema = BaseEventSchema.extend({
  type: z.literal("TaskFailed"),
  reason: z.enum(["budget_exhausted", "cost_exhausted", "review_rejected"]),
  phase: PhaseSchema,
  summary: FailureSummarySchema,
});

export const TaskExhaustedSchema = BaseEventSchema.extend({
  type: z.literal("TaskExhausted"),
  reason: z.enum(["budget_exhausted", "cost_exhausted"]),
  phase: PhaseSchema,
  source: EventSourceSchema,
});

export const BudgetIncreasedSchema = BaseEventSchema.extend({
  type: z.literal("BudgetIncreased"),
  attemptBudgetIncrease: AttemptBudgetMaxInputSchema.partial().nullable(),
  costBudgetIncrease: z.number().nonnegative(),
  reason: z.string(),
  source: EventSourceSchema,
});

export const TaskBlockedSchema = BaseEventSchema.extend({
  type: z.literal("TaskBlocked"),
  reason: z.string(),
  reasonCode: z.string(),
  summary: FailureSummarySchema,
  source: EventSourceSchema,
});

export const TaskCanceledSchema = BaseEventSchema.extend({
  type: z.literal("TaskCanceled"),
  reason: z.enum(["parent_redecomposed", "manual", "dependency_failed"]),
  source: EventSourceSchema,
});

export const TaskRevivedSchema = BaseEventSchema.extend({
  type: z.literal("TaskRevived"),
  phase: PhaseSchema,
  resetAttempts: z.array(PhaseSchema),
  reason: z.string(),
  source: EventSourceSchema,
});

export const TaskReparentedSchema = BaseEventSchema.extend({
  type: z.literal("TaskReparented"),
  oldParentId: TaskIdSchema.nullable(),
  newParentId: TaskIdSchema,
  oldRootId: TaskIdSchema,
  newRootId: TaskIdSchema,
  source: EventSourceSchema,
});

export const MetadataUpdatedSchema = BaseEventSchema.extend({
  type: z.literal("MetadataUpdated"),
  patch: z.record(z.unknown()),
  reason: z.string(),
  source: EventSourceSchema,
});

// ---------------------------------------------------------------------------
// Union of all events
// ---------------------------------------------------------------------------

export const EventSchema = z.discriminatedUnion("type", [
  TaskCreatedSchema,
  LeaseGrantedSchema,
  LeaseExpiredSchema,
  LeaseReleasedSchema,
  LeaseExtendedSchema,
  AgentStartedSchema,
  AgentExitedSchema,
  CostReportedSchema,
  PhaseTransitionSchema,
  WaitRequestedSchema,
  WaitResolvedSchema,
  DependencySatisfiedSchema,
  RetryScheduledSchema,
  BackoffExpiredSchema,
  DecompositionCreatedSchema,
  ChildActivatedSchema,
  ChildReviewDecisionSubmittedSchema,
  ChildCostRecoveredSchema,
  CheckpointTriggeredSchema,
  CheckpointCreatedSchema,
  StateRevertedSchema,
  ReviewVerdictSubmittedSchema,
  ReviewPolicyMetSchema,
  CompletionVerificationRecordedSchema,
  TaskCompletedSchema,
  TaskFailedSchema,
  TaskExhaustedSchema,
  BudgetIncreasedSchema,
  TaskBlockedSchema,
  TaskCanceledSchema,
  TaskRevivedSchema,
  TaskReparentedSchema,
  MetadataUpdatedSchema,
]);

// ---------------------------------------------------------------------------
// Event envelope
// ---------------------------------------------------------------------------

export const EventEnvelopeSchema = z.object({
  sequence: z.number().int().nonnegative(),
  event: EventSchema,
});

// ---------------------------------------------------------------------------
// System state
// ---------------------------------------------------------------------------

export const SystemStateSchema = z.object({
  tasks: z.record(TaskIdSchema, TaskSchema),
  events: z.array(EventEnvelopeSchema),
  sequence: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Validation error
// ---------------------------------------------------------------------------

export const ValidationErrorSchema = z.object({
  code: z.string(),
  message: z.string(),
  taskId: TaskIdSchema.optional(),
  eventType: z.string().optional(),
  details: z.record(z.unknown()).optional(),
});

// ---------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------

export const ResultSchema = z.union([
  z.object({
    ok: z.literal(true),
    value: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.unknown(),
  }),
]);

// ---------------------------------------------------------------------------
// Reduce result
// ---------------------------------------------------------------------------

export const ReduceResultSchema = z.object({
  state: SystemStateSchema,
  emitted: z.array(EventSchema),
});

// ---------------------------------------------------------------------------
// Dependency graph
// ---------------------------------------------------------------------------

export const DependencyGraphEdgeSchema = z.object({
  fromTaskId: TaskIdSchema,
  dependencyId: DependencyIdSchema,
  to: z.string(),
  blocking: z.boolean(),
  timing: z.enum(["before_start", "during"]),
  status: DependencySchema.shape.status,
});

export const DependencyGraphSchema = z.object({
  nodes: z.array(TaskIdSchema),
  edges: z.array(DependencyGraphEdgeSchema),
});

// ---------------------------------------------------------------------------
// Search tree
// ---------------------------------------------------------------------------

export const SearchTreeNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    taskId: TaskIdSchema,
    title: z.string(),
    terminal: TerminalSchema.nullable(),
    phase: PhaseSchema.nullable(),
    condition: ConditionSchema.nullable(),
    approaches: z.array(ApproachRecordSchema),
    children: z.array(SearchTreeNodeSchema),
  })
);

// ---------------------------------------------------------------------------
// Cost summary
// ---------------------------------------------------------------------------

export const CostSummaryEntrySchema = z.object({
  taskId: TaskIdSchema,
  allocated: z.number().nonnegative(),
  consumed: z.number().nonnegative(),
  remaining: z.number(),
});

export const CostSummarySchema = z.object({
  rootTaskId: TaskIdSchema,
  allocated: z.number().nonnegative(),
  consumed: z.number().nonnegative(),
  remaining: z.number(),
  entries: z.array(CostSummaryEntrySchema),
});

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

export const SnapshotRowSchema = z.object({
  sequence: z.number().int().nonnegative(),
  state: SystemStateSchema,
  createdAt: z.number().int().nonnegative(),
});

// ---------------------------------------------------------------------------
// Persistence options
// ---------------------------------------------------------------------------

export const CoreOptionsSchema = z.object({
  dbPath: z.string(),
  eventLogDir: z.string().optional(),
  persistenceBackend: z.enum(["jsonl", "sqlite"]).optional(),
  snapshotEvery: z.number().int().positive().optional(),
  clockPollMs: z.number().int().positive().optional(),
  invariantChecks: z.boolean().optional(),
});

// ---------------------------------------------------------------------------
// Re-export type inference helpers
// ---------------------------------------------------------------------------

export type TaskId = z.infer<typeof TaskIdSchema>;
export type AgentId = z.infer<typeof AgentIdSchema>;
export type SessionId = z.infer<typeof SessionIdSchema>;
export type CheckpointId = z.infer<typeof CheckpointIdSchema>;
export type DependencyId = z.infer<typeof DependencyIdSchema>;
export type Timestamp = z.infer<typeof TimestampSchema>;
export type Duration = z.infer<typeof DurationSchema>;

export type Phase = z.infer<typeof PhaseSchema>;
export type Condition = z.infer<typeof ConditionSchema>;
export type Terminal = z.infer<typeof TerminalSchema>;

export type AttemptBudget = z.infer<typeof AttemptBudgetSchema>;
export type AttemptBudgets = z.infer<typeof AttemptBudgetsSchema>;
export type AttemptBudgetMaxInput = z.infer<typeof AttemptBudgetMaxInputSchema>;

export type CostBudget = z.infer<typeof CostBudgetSchema>;

export type Dependency = z.infer<typeof DependencySchema>;

export type StateRef = z.infer<typeof StateRefSchema>;
export type CheckpointRef = z.infer<typeof CheckpointRefSchema>;

export type ApproachRecord = z.infer<typeof ApproachRecordSchema>;
export type FailureSummary = z.infer<typeof FailureSummarySchema>;

export type IsolationRule = z.infer<typeof IsolationRuleSchema>;

export type ReviewConfig = z.infer<typeof ReviewConfigSchema>;
export type ReviewVerdict = z.infer<typeof ReviewVerdictSchema>;
export type ReviewState = z.infer<typeof ReviewStateSchema>;

export type DependencyWaitState = z.infer<typeof DependencyWaitStateSchema>;
export type SiblingTurnWaitState = z.infer<typeof SiblingTurnWaitStateSchema>;
export type WaitState = z.infer<typeof WaitStateSchema>;

export type SequentialCoordination = z.infer<typeof SequentialCoordinationSchema>;

export type Task = z.infer<typeof TaskSchema>;

export type AgentContext = z.infer<typeof AgentContextSchema>;
export type EventSource = z.infer<typeof EventSourceSchema>;
export type BaseEvent = z.infer<typeof BaseEventSchema>;

export type TaskCreated = z.infer<typeof TaskCreatedSchema>;
export type LeaseGranted = z.infer<typeof LeaseGrantedSchema>;
export type LeaseExpired = z.infer<typeof LeaseExpiredSchema>;
export type LeaseReleased = z.infer<typeof LeaseReleasedSchema>;
export type LeaseExtended = z.infer<typeof LeaseExtendedSchema>;
export type AgentStarted = z.infer<typeof AgentStartedSchema>;
export type AgentExited = z.infer<typeof AgentExitedSchema>;
export type CostReported = z.infer<typeof CostReportedSchema>;

export type PhaseTransitionReason = z.infer<typeof PhaseTransitionReasonSchema>;
export type PhaseTransition = z.infer<typeof PhaseTransitionSchema>;

export type WaitRequested = z.infer<typeof WaitRequestedSchema>;
export type WaitResolved = z.infer<typeof WaitResolvedSchema>;
export type DependencySatisfied = z.infer<typeof DependencySatisfiedSchema>;
export type RetryScheduled = z.infer<typeof RetryScheduledSchema>;
export type BackoffExpired = z.infer<typeof BackoffExpiredSchema>;

export type DecompositionChildSpec = z.infer<typeof DecompositionChildSpecSchema>;
export type DecompositionCreated = z.infer<typeof DecompositionCreatedSchema>;

export type ChildActivated = z.infer<typeof ChildActivatedSchema>;
export type ChildReviewDecision = z.infer<typeof ChildReviewDecisionSchema>;
export type ChildReviewDecisionSubmitted = z.infer<typeof ChildReviewDecisionSubmittedSchema>;
export type ChildCostRecovered = z.infer<typeof ChildCostRecoveredSchema>;

export type CheckpointTriggered = z.infer<typeof CheckpointTriggeredSchema>;
export type CheckpointCreated = z.infer<typeof CheckpointCreatedSchema>;
export type StateReverted = z.infer<typeof StateRevertedSchema>;

export type ReviewVerdictSubmitted = z.infer<typeof ReviewVerdictSubmittedSchema>;
export type ReviewPolicyMet = z.infer<typeof ReviewPolicyMetSchema>;

export type ArtifactKind = z.infer<typeof ArtifactKindSchema>;
export type ArtifactEvidence = z.infer<typeof ArtifactEvidenceSchema>;
export type CompletionVerification = z.infer<typeof CompletionVerificationSchema>;
export type CompletionVerificationRecorded = z.infer<typeof CompletionVerificationRecordedSchema>;

export type TaskCompleted = z.infer<typeof TaskCompletedSchema>;
export type TaskFailed = z.infer<typeof TaskFailedSchema>;
export type TaskExhausted = z.infer<typeof TaskExhaustedSchema>;
export type BudgetIncreased = z.infer<typeof BudgetIncreasedSchema>;
export type TaskBlocked = z.infer<typeof TaskBlockedSchema>;
export type TaskCanceled = z.infer<typeof TaskCanceledSchema>;
export type TaskRevived = z.infer<typeof TaskRevivedSchema>;
export type TaskReparented = z.infer<typeof TaskReparentedSchema>;
export type MetadataUpdated = z.infer<typeof MetadataUpdatedSchema>;

export type Event = z.infer<typeof EventSchema>;
export type EventType = Event["type"];

export type EventEnvelope = z.infer<typeof EventEnvelopeSchema>;
export type SystemState = z.infer<typeof SystemStateSchema>;

export type ValidationError = z.infer<typeof ValidationErrorSchema>;
export type Result<T, E> = z.infer<typeof ResultSchema> extends { ok: true; value: infer U }
  ? { ok: true; value: U }
  : z.infer<typeof ResultSchema>;

export type ReduceResult = z.infer<typeof ReduceResultSchema>;

export type DependencyGraphEdge = z.infer<typeof DependencyGraphEdgeSchema>;
export type DependencyGraph = z.infer<typeof DependencyGraphSchema>;

export type SearchTreeNode = z.infer<typeof SearchTreeNodeSchema>;

export type CostSummaryEntry = z.infer<typeof CostSummaryEntrySchema>;
export type CostSummary = z.infer<typeof CostSummarySchema>;

export type SnapshotRow = z.infer<typeof SnapshotRowSchema>;

export type CoreOptions = z.infer<typeof CoreOptionsSchema>;
