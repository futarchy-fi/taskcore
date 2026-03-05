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
  InitialAllocation

VARIABLES
  alive,
  allocated,
  consumed,
  childAllocated,
  childRecovered,
  parent

Min(x, y) == IF x < y THEN x ELSE y

Remaining(task) == allocated[task] - consumed[task] - childAllocated[task] + childRecovered[task]

Init ==
  /\ RootTask ∈ Tasks
  /\ alive = {RootTask}
  /\ allocated = [t \in Tasks |-> IF t = RootTask THEN InitialAllocation ELSE 0]
  /\ consumed = [t \in Tasks |-> 0]
  /\ childAllocated = [t \in Tasks |-> 0]
  /\ childRecovered = [t \in Tasks |-> 0]
  /\ parent = [t \in Tasks |-> NoneTask]

TypeInvariant ==
  /\ RootTask ∈ Tasks
  /\ parent ∈ [Tasks -> (Tasks ∪ {NoneTask})]
  /\ allocated ∈ [Tasks -> Nat]
  /\ consumed ∈ [Tasks -> Nat]
  /\ childAllocated ∈ [Tasks -> Nat]
  /\ childRecovered ∈ [Tasks -> Nat]
  /\ alive ⊆ Tasks
  /\ RootTask ∈ alive
  /\ InitialAllocation >= 0

AliveNonNegative ==
  ∀ t ∈ alive:
    /\ allocated[t] >= 0
    /\ consumed[t] >= 0
    /\ childAllocated[t] >= 0
    /\ childRecovered[t] >= 0
    /\ Remaining(t) >= 0

ParentConsistency ==
  ∀ t ∈ alive:
    \/ t = RootTask => parent[t] = NoneTask
    \/ (parent[t] ∈ alive /\ parent[t] # t)

CostConservation ==
  LET totalConsumed == Sum({consumed[t] : t ∈ alive})
      totalRemaining == Sum({Remaining(t) : t ∈ alive})
      remainingRoot == allocated[RootTask]
  IN
    totalConsumed + totalRemaining = remainingRoot

CreateChild(parentTask, child, amount) ==
  /\ parentTask ∈ alive
  /\ child ∈ Tasks
  /\ child ∉ alive
  /\ amount ∈ Nat \ {0}
  /\ amount <= Remaining(parentTask)
  /\ alive' = alive ∪ {child}
  /\ allocated' = [allocated EXCEPT ![child] = amount]
  /\ consumed' = consumed
  /\ childAllocated' = [childAllocated EXCEPT ![parentTask] = childAllocated[parentTask] + amount]
  /\ childRecovered' = childRecovered
  /\ parent' = [parent EXCEPT ![child] = parentTask]

ReportCost(task, amount) ==
  /\ task ∈ alive
  /\ amount ∈ Nat \ {0}
  /\ amount <= Remaining(task)
  /\ alive' = alive
  /\ allocated' = allocated
  /\ consumed' = [consumed EXCEPT ![task] = consumed[task] + amount]
  /\ childAllocated' = childAllocated
  /\ childRecovered' = childRecovered
  /\ parent' = parent

RecoverFromChild(parentTask, child, amount) ==
  /\ parentTask ∈ alive
  /\ parent[child] = parentTask
  /\ child ∈ alive
  /\ amount ∈ Nat
  /\ amount > 0
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
  \/ ∃ p ∈ alive, c ∈ Tasks \ alive, a ∈ Nat: CreateChild(p, c, a)
  \/ ∃ t ∈ alive, a ∈ Nat \ {0}: ReportCost(t, a)
  \/ ∃ p ∈ alive, c ∈ alive, a ∈ Nat: RecoverFromChild(p, c, a)

Spec ==
  Init /\ [][Next]_<<alive, allocated, consumed, childAllocated, childRecovered, parent>>

THEOREM Spec => [](TypeInvariant /\ AliveNonNegative /\ CostConservation)

==============================================================================
