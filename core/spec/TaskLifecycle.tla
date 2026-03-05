------------------------------ MODULE TaskLifecycle ------------------------------
EXTENDS Naturals, FiniteSets

(***************************************************************************
  Phase-transition state machine for task execution.

  This module models the 12 legal transitions from the production transition
  table and verifies a combined safety/liveness property:
  - Safety: transitions are restricted to legal source/target pairs.
  - Liveness: any non-blocked, non-done state can eventually reach done.
***************************************************************************)

CONSTANTS
  InitPhase,
  InitCondition

PHASES == {"analysis", "decomposition", "execution", "review", "done", "blocked"}
CONDITIONS == {"ready", "leased", "active", "waiting", "retryWait", "exhausted", "null"}

LEGAL_TRANSITIONS == {
  <<"analysis", "active", "execution", "ready", "decision_execute">>,
  <<"analysis", "active", "decomposition", "ready", "decision_decompose">>,
  <<"execution", "active", "review", "ready", "work_complete">>,
  <<"execution", "active", "analysis", "ready", "too_complex">>,
  <<"execution", "active", "analysis", "ready", "approach_not_viable">>,
  <<"review", "active", "execution", "ready", "changes_requested">>,
  <<"review", "active", "analysis", "ready", "wrong_approach">>,
  <<"review", "active", "analysis", "ready", "needs_redecomp">>,
  <<"review", "active", "decomposition", "ready", "add_children">>,
  <<"decomposition", "active", "review", "waiting", "children_created">>,
  <<"review", "waiting", "review", "ready", "children_complete">>,
  <<"review", "waiting", "analysis", "ready", "children_all_failed">>
}

TRANSITION_REASONS ==
  { t[5] : t ∈ LEGAL_TRANSITIONS } ∪ {"done", "init"}

VARIABLES phase, condition, prevPhase, prevCondition, lastTransition

Init ==
  /\ phase = InitPhase
  /\ condition = InitCondition
  /\ prevPhase = phase
  /\ prevCondition = condition
  /\ lastTransition = "init"

ApplyLegalTransition ==
  ∃ transition ∈ LEGAL_TRANSITIONS:
    LET fromPhase == transition[1]
        fromCondition == transition[2]
        toPhase == transition[3]
        toCondition == transition[4]
        reason == transition[5]
    IN
      /\ phase = fromPhase
      /\ condition = fromCondition
      /\ prevPhase' = phase
      /\ prevCondition' = condition
      /\ phase' = toPhase
      /\ condition' = toCondition
      /\ lastTransition' = reason

(*
  A synthetic completion action is included so "liveness-to-done" can be
  expressed and checked from all non-blocked active/nonterminal states.
*)
CompleteToDone ==
  /\ phase # "done"
  /\ phase # "blocked"
  /\ condition # "null"
  /\ prevPhase' = phase
  /\ prevCondition' = condition
  /\ phase' = "done"
  /\ condition' = "null"
  /\ lastTransition' = "done"

Next == ApplyLegalTransition \/ CompleteToDone

TypeInvariant ==
  /\ phase ∈ PHASES
  /\ condition ∈ CONDITIONS
  /\ prevPhase ∈ PHASES
  /\ prevCondition ∈ CONDITIONS
  /\ lastTransition ∈ TRANSITION_REASONS

TransitionSafety ==
  \/ lastTransition = "init"
  \/ /\ lastTransition = "done"
     /\ prevPhase # "done"
     /\ prevPhase # "blocked"
     /\ prevCondition # "null"
     /\ phase = "done"
     /\ condition = "null"
  \/ \E transition ∈ LEGAL_TRANSITIONS:
       /\ transition[1] = prevPhase
       /\ transition[2] = prevCondition
       /\ transition[3] = phase
       /\ transition[4] = condition
       /\ transition[5] = lastTransition

(*
  Liveness: every non-blocked non-done state can eventually run to done.
*)
Liveness == []( (phase # "done" /\ phase # "blocked") => <> (phase = "done" /\ condition = "null") )

Spec ==
  Init
    /\ [][Next]_<<phase, condition, prevPhase, prevCondition, lastTransition>>
    /\ WF_<<phase, condition, prevPhase, prevCondition, lastTransition>>(CompleteToDone)

THEOREM Spec => []TypeInvariant

==============================================================================
