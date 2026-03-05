------------------------------ MODULE TaskLeaseProtocol ------------------------------
EXTENDS Naturals, FiniteSets

(***************************************************************************
  Fence-based single-task lease protocol with competing agents.

  This model checks:
  - Mutual exclusion: at most one agent can be active.
  - Stale events are rejected and do not mutate lease/task state.
***************************************************************************)

CONSTANTS
  Agents,
  NoneAgent,
  MaxFence

TASK_STATES == {"free", "leased", "active"}
ACTION_TYPES == {"lease", "work_accepted", "work_stale", "release", "none"}

VARIABLES
  fence,
  holder,
  taskState,
  active,
  lastAction,
  lastActionAccepted,
  attemptAgent,
  attemptToken,
  prevFence,
  prevHolder,
  prevTaskState,
  prevActive

vars ==
  << fence, holder, taskState, active, lastAction, lastActionAccepted,
     attemptAgent, attemptToken, prevFence, prevHolder, prevTaskState, prevActive >>

Init ==
  /\ fence = 0
  /\ holder = NoneAgent
  /\ taskState = "free"
  /\ active = [a \in Agents |-> FALSE]
  /\ lastAction = "none"
  /\ lastActionAccepted = TRUE
  /\ attemptAgent = NoneAgent
  /\ attemptToken = 0
  /\ prevFence = fence
  /\ prevHolder = holder
  /\ prevTaskState = taskState
  /\ prevActive = active

TypeInvariant ==
  /\ MaxFence \in Nat
  /\ fence \in Nat
  /\ fence <= MaxFence
  /\ holder \in Agents \cup {NoneAgent}
  /\ taskState \in TASK_STATES
  /\ active \in [Agents -> BOOLEAN]
  /\ lastAction \in ACTION_TYPES
  /\ lastActionAccepted \in BOOLEAN
  /\ attemptAgent \in Agents \cup {NoneAgent}
  /\ attemptToken \in 0..MaxFence
  /\ prevFence \in Nat
  /\ prevHolder \in Agents \cup {NoneAgent}
  /\ prevTaskState \in TASK_STATES
  /\ prevActive \in [Agents -> BOOLEAN]

Snapshot ==
  /\ prevFence' = fence
  /\ prevHolder' = holder
  /\ prevTaskState' = taskState
  /\ prevActive' = active

NoStateChangeOnStaleAttempt ==
  lastAction = "work_stale" =>
    /\ fence = prevFence
    /\ holder = prevHolder
    /\ taskState = prevTaskState
    /\ active = prevActive

StaleEventRejected ==
  lastAction = "work_stale" => ~lastActionAccepted

GrantLease(agent) ==
  /\ agent \in Agents
  /\ taskState = "free"
  /\ holder = NoneAgent
  /\ fence < MaxFence
  /\ \A a \in Agents: ~active[a]
  /\ Snapshot
  /\ fence' = fence + 1
  /\ holder' = agent
  /\ taskState' = "leased"
  /\ active' = active
  /\ lastAction' = "lease"
  /\ lastActionAccepted' = TRUE
  /\ attemptAgent' = NoneAgent
  /\ attemptToken' = 0

WorkAttempt(agent, token) ==
  /\ agent \in Agents
  /\ token \in 0..MaxFence
  /\ Snapshot
  /\ attemptAgent' = agent
  /\ attemptToken' = token
  /\ IF /\ token = fence
        /\ holder = agent
        /\ taskState = "leased"
        /\ ~active[agent]
        /\ \A other \in Agents \ {agent}: ~active[other]
     THEN /\ fence' = fence
          /\ holder' = holder
          /\ taskState' = "active"
          /\ active' = [active EXCEPT ![agent] = TRUE]
          /\ lastAction' = "work_accepted"
          /\ lastActionAccepted' = TRUE
     ELSE /\ fence' = fence
          /\ holder' = holder
          /\ taskState' = taskState
          /\ active' = active
          /\ lastAction' = "work_stale"
          /\ lastActionAccepted' = FALSE

Release(agent) ==
  /\ agent \in Agents
  /\ taskState = "active"
  /\ holder = agent
  /\ active[agent]
  /\ fence < MaxFence
  /\ Snapshot
  /\ fence' = fence + 1
  /\ holder' = NoneAgent
  /\ taskState' = "free"
  /\ active' = [active EXCEPT ![agent] = FALSE]
  /\ lastAction' = "release"
  /\ lastActionAccepted' = TRUE
  /\ attemptAgent' = NoneAgent
  /\ attemptToken' = 0

Next ==
  \/ \E agent \in Agents: GrantLease(agent)
  \/ \E agent \in Agents: Release(agent)
  \/ \E agent \in Agents, token \in 0..MaxFence: WorkAttempt(agent, token)

MutualExclusion ==
  Cardinality({a \in Agents: active[a]}) <= 1

Spec ==
  Init /\ [][Next]_vars

==============================================================================
