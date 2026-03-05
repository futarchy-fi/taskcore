------------------------------ MODULE TaskLeaseProtocol ------------------------------
EXTENDS Naturals, FiniteSets

(***************************************************************************
  Fence-based lease protocol with competing agents.

  This model checks:
  - Mutual exclusion: no task has more than one active agent.
  - Stale fence events are always rejected and do not change state.
***************************************************************************)

CONSTANTS
  Agents,
  NoneAgent,
  Task

TASK_STATES == {"free", "leased", "active"}
ACTION_TYPES == {"lease", "work_accepted", "work_stale", "release", "none"}

VARIABLES
  fence,
  holder,
  taskState,
  activeTask,
  lastAction,
  lastActionAccepted,
  prevFence,
  prevHolder,
  prevTaskState,
  prevActiveTask

Init ==
  /\ fence = [t \in Task |-> 0]
  /\ holder = [t \in Task |-> NoneAgent]
  /\ taskState = [t \in Task |-> "free"]
  /\ activeTask = [a \in Agents |-> NoneAgent]
  /\ lastAction = "none"
  /\ lastActionAccepted = TRUE
  /\ prevFence = fence
  /\ prevHolder = holder
  /\ prevTaskState = taskState
  /\ prevActiveTask = activeTask

TypeInvariant ==
  /\ fence ∈ [Task -> Nat]
  /\ holder ∈ [Task -> Agents ∪ {NoneAgent}]
  /\ taskState ∈ [Task -> TASK_STATES]
  /\ activeTask ∈ [Agents -> (Task ∪ {NoneAgent})]
  /\ lastAction ∈ ACTION_TYPES
  /\ lastActionAccepted ∈ BOOLEAN
  /\ prevFence ∈ [Task -> Nat]
  /\ prevHolder ∈ [Task -> Agents ∪ {NoneAgent}]
  /\ prevTaskState ∈ [Task -> TASK_STATES]
  /\ prevActiveTask ∈ [Agents -> (Task ∪ {NoneAgent})]

Snapshot ==
  /\ prevFence' = fence
  /\ prevHolder' = holder
  /\ prevTaskState' = taskState
  /\ prevActiveTask' = activeTask

NoStateChangeOnStaleAttempt ==
  /\ lastAction = "work_stale" =>
     /\ fence = prevFence
     /\ holder = prevHolder
     /\ taskState = prevTaskState
     /\ activeTask = prevActiveTask

GrantLease(agent) ==
  /\ agent ∈ Agents
  /\ ∀ a ∈ Agents: activeTask[a] = NoneAgent
  /\ Snapshot
  /\ lastAction' = "lease"
  /\ lastActionAccepted' = TRUE
  /\ fence' = [fence EXCEPT ![Task] = fence[Task] + 1]
  /\ holder' = [holder EXCEPT ![Task] = agent]
  /\ taskState' = [taskState EXCEPT ![Task] = "leased"]
  /\ activeTask' = [activeTask EXCEPT ![agent] = NoneAgent]

WorkAttempt(agent, token) ==
  /\ agent ∈ Agents
  /\ Snapshot
  /\ IF /\ token = fence[Task]
        /\ holder[Task] = agent
        /\ taskState[Task] = "leased"
        /\ activeTask[agent] = NoneAgent
        /\ ∀ other ∈ Agents \ {agent}: activeTask[other] = NoneAgent
     THEN /\ lastAction' = "work_accepted"
          /\ lastActionAccepted' = TRUE
          /\ fence' = fence
          /\ holder' = holder
          /\ taskState' = [taskState EXCEPT ![Task] = "active"]
          /\ activeTask' = [activeTask EXCEPT ![agent] = Task]
     ELSE /\ lastAction' = "work_stale"
          /\ lastActionAccepted' = FALSE
          /\ fence' = fence
          /\ holder' = holder
          /\ taskState' = taskState
          /\ activeTask' = activeTask

Release(agent) ==
  /\ agent ∈ Agents
  /\ activeTask[agent] = Task
  /\ holder[Task] = agent
  /\ taskState[Task] = "active"
  /\ Snapshot
  /\ lastAction' = "release"
  /\ lastActionAccepted' = TRUE
  /\ fence' = [fence EXCEPT ![Task] = fence[Task] + 1]
  /\ holder' = [holder EXCEPT ![Task] = NoneAgent]
  /\ taskState' = [taskState EXCEPT ![Task] = "free"]
  /\ activeTask' = [activeTask EXCEPT ![agent] = NoneAgent]

Next ==
  \\/ ∃ agent ∈ Agents: GrantLease(agent)
  \\/ ∃ agent ∈ Agents: Release(agent)
  \\/ ∃ agent ∈ Agents, token ∈ Nat: WorkAttempt(agent, token)

MutualExclusion ==
  ∀ t ∈ Task: Cardinality({a ∈ Agents: activeTask[a] = t}) <= 1

Spec ==
  Init /\ [][Next]_<<fence, holder, taskState, activeTask, lastAction, lastActionAccepted,
                   prevFence, prevHolder, prevTaskState, prevActiveTask>>

==============================================================================
