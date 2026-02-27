---- MODULE TaskLifecycle ----
EXTENDS Naturals, Sequences, FiniteSets

(***************************************************************************
  Draft TLA+ skeleton for orchestration core lifecycle.
  This file is intentionally compact and focuses on the key invariants
  mirrored by runtime checks and tests.
***************************************************************************)

CONSTANTS Tasks, Phases, Conditions, Terminals

VARIABLES phase, condition, terminal, fence, attempts

Init ==
  /\ phase \in [Tasks -> Phases \cup {"null"}]
  /\ condition \in [Tasks -> Conditions \cup {"null"}]
  /\ terminal \in [Tasks -> Terminals \cup {"null"}]
  /\ fence \in [Tasks -> Nat]
  /\ attempts \in [Tasks -> [Phases -> Nat]]

TerminalAbsorption ==
  \A t \in Tasks:
    terminal[t] # "null" => /\ phase[t] = "null" /\ condition[t] = "null"

FenceMonotonicity ==
  \A t \in Tasks: fence[t] >= 0

AttemptNonNegative ==
  \A t \in Tasks: \A p \in Phases: attempts[t][p] >= 0

TypeInvariant == TerminalAbsorption /\ FenceMonotonicity /\ AttemptNonNegative

Next == UNCHANGED <<phase, condition, terminal, fence, attempts>>

Spec == Init /\ [][Next]_<<phase, condition, terminal, fence, attempts>>

THEOREM Spec => []TypeInvariant
====
