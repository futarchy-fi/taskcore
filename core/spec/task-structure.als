module task_structure

// Draft Alloy skeleton for structure invariants of the orchestration tree.

sig Task {
  parent: lone Task,
  children: set Task,
  terminal: lone Terminal,
  failureSummary: lone FailureSummary
}

abstract sig Terminal {}
one sig Done, Failed, Blocked, Canceled extends Terminal {}

sig FailureSummary {}

fact ParentChildConsistency {
  all t: Task | all c: t.children | c.parent = t
}

fact AcyclicParent {
  no t: Task | t in t.^parent
}

fact TerminalRequiresSummary {
  all t: Task |
    (t.terminal = Failed or t.terminal = Blocked) implies some t.failureSummary
}

run {}
