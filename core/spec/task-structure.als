module task_structure

// Formal Alloy model of task tree structure and cost constraints.

sig Task {
  parent: lone Task,
  children: set Task,
  rootId: Task,
  allocated: Int,
  consumed: Int,
  childAllocated: Int,
  childRecovered: Int
}

// Root tasks are those without a parent
fun roots: set Task {
  { t: Task | no t.parent }
}

fun remaining[t: Task]: Int {
  t.allocated - t.consumed - t.childAllocated + t.childRecovered
}

// No cycles in the parent pointer graph.
fact NoCycles {
  no t: Task | t in t.^parent
}

// Parent-child consistency.
fact ParentChildConsistency {
  all t: Task | all c: Task | (c in t.children) iff (c.parent = t)
}

// Parent-child consistency is explicit as an assertion too, for command checks.
assert parentChildConsistency {
  all t: Task | all c: Task | (c in t.children) iff (c.parent = t)
}

// Root identity is stable down the tree.
fact RootIdConsistency {
  all t: Task |
    (no t.parent and t.rootId = t) or (some t.parent and t.rootId = t.parent.rootId)
}

assert rootIdConsistency {
  all t: Task |
    (no t.parent and t.rootId = t) or (some t.parent and t.rootId = t.parent.rootId)
}

// Cost fields are non-negative and remaining budget is non-negative.
fact CostNonNegativity {
  all t: Task |
    t.allocated >= 0 and
    t.consumed >= 0 and
    t.childAllocated >= 0 and
    t.childRecovered >= 0 and
    remaining[t] >= 0
}

assert costNonNegativity {
  all t: Task |
    t.allocated >= 0 and
    t.consumed >= 0 and
    t.childAllocated >= 0 and
    t.childRecovered >= 0 and
    remaining[t] >= 0
}

assert noCycles {
  no t: Task | t in t.^parent
}

// Structural sanity checks.
check parentChildConsistency for 5
check rootIdConsistency for 5
check costNonNegativity for 5
check noCycles for 5
