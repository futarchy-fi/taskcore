------------------------------ MODULE TaskCostConservation ------------------------------
EXTENDS Naturals, FiniteSets

(***************************************************************************
  Parent/child cost allocation and recovery model.

  Tracks:
  - allocated budget
  - consumed budget
  - childAllocated (sum assigned to children)
  - childRecovered (recovered from children)

  Invariant:
  consumed + remaining across all alive tasks remains equal to root allocation.
***************************************************************************)

CONSTANTS
  Tasks,
  RootTask,
  NoneTask,
  InitialAllocation,
  MaxAmount

VARIABLES
  alive,
  allocated,
  consumed,
  childAllocated,
  childRecovered,
  parent

Remaining(task) ==
  allocated[task] - consumed[task] - childAllocated[task] + childRecovered[task]

RECURSIVE ConsumedSum(_), RemainingSum(_)
ConsumedSum(tasks) ==
  IF tasks = {}
  THEN 0
  ELSE LET t == CHOOSE x \in tasks: TRUE
       IN consumed[t] + ConsumedSum(tasks \ {t})

RemainingSum(tasks) ==
  IF tasks = {}
  THEN 0
  ELSE LET t == CHOOSE x \in tasks: TRUE
       IN Remaining(t) + RemainingSum(tasks \ {t})

Init ==
  /\ RootTask \in Tasks
  /\ InitialAllocation \in Nat
  /\ MaxAmount \in 1..InitialAllocation
  /\ alive = {RootTask}
  /\ allocated = [t \in Tasks |-> IF t = RootTask THEN InitialAllocation ELSE 0]
  /\ consumed = [t \in Tasks |-> 0]
  /\ childAllocated = [t \in Tasks |-> 0]
  /\ childRecovered = [t \in Tasks |-> 0]
  /\ parent = [t \in Tasks |-> NoneTask]

TypeInvariant ==
  /\ RootTask \in Tasks
  /\ parent \in [Tasks -> (Tasks \cup {NoneTask})]
  /\ allocated \in [Tasks -> Nat]
  /\ consumed \in [Tasks -> Nat]
  /\ childAllocated \in [Tasks -> Nat]
  /\ childRecovered \in [Tasks -> Nat]
  /\ alive \subseteq Tasks
  /\ RootTask \in alive
  /\ InitialAllocation \in Nat
  /\ MaxAmount \in 1..InitialAllocation

AliveNonNegative ==
  \A t \in alive:
    /\ allocated[t] >= 0
    /\ consumed[t] >= 0
    /\ childAllocated[t] >= 0
    /\ childRecovered[t] >= 0
    /\ Remaining(t) >= 0

ParentConsistency ==
  \A t \in alive:
    IF t = RootTask
    THEN parent[t] = NoneTask
    ELSE /\ parent[t] \in alive
         /\ parent[t] # t

CostConservation ==
  LET totalConsumed == ConsumedSum(alive)
      totalRemaining == RemainingSum(alive)
  IN totalConsumed + totalRemaining = allocated[RootTask]

CreateChild(parentTask, child, amount) ==
  /\ parentTask \in alive
  /\ child \in Tasks
  /\ child \notin alive
  /\ amount \in 1..MaxAmount
  /\ amount <= Remaining(parentTask)
  /\ alive' = alive \cup {child}
  /\ allocated' = [allocated EXCEPT ![child] = amount]
  /\ consumed' = consumed
  /\ childAllocated' = [childAllocated EXCEPT ![parentTask] = childAllocated[parentTask] + amount]
  /\ childRecovered' = childRecovered
  /\ parent' = [parent EXCEPT ![child] = parentTask]

ReportCost(task, amount) ==
  /\ task \in alive
  /\ amount \in 1..MaxAmount
  /\ amount <= Remaining(task)
  /\ alive' = alive
  /\ allocated' = allocated
  /\ consumed' = [consumed EXCEPT ![task] = consumed[task] + amount]
  /\ childAllocated' = childAllocated
  /\ childRecovered' = childRecovered
  /\ parent' = parent

RecoverFromChild(parentTask, child, amount) ==
  /\ parentTask \in alive
  /\ child \in alive
  /\ parent[child] = parentTask
  /\ amount \in 1..MaxAmount
  /\ LET recoverable == Remaining(child)
         recovered == IF amount <= recoverable THEN amount ELSE recoverable
     IN
       /\ alive' = alive
       /\ allocated' = [allocated EXCEPT ![child] = allocated[child] - recovered]
       /\ consumed' = consumed
       /\ childAllocated' = childAllocated
       /\ childRecovered' = [childRecovered EXCEPT ![parentTask] = childRecovered[parentTask] + recovered]
       /\ parent' = parent

Next ==
  \/ \E p \in alive, c \in Tasks \ alive, a \in 1..MaxAmount: CreateChild(p, c, a)
  \/ \E t \in alive, a \in 1..MaxAmount: ReportCost(t, a)
  \/ \E p \in alive, c \in alive, a \in 1..MaxAmount: RecoverFromChild(p, c, a)

Spec ==
  Init /\ [][Next]_<<alive, allocated, consumed, childAllocated, childRecovered, parent>>

==============================================================================
