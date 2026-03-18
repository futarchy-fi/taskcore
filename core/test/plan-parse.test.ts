import test from "node:test";
import assert from "node:assert/strict";

import { allocateCosts, parsePlan } from "../cli/plan-parse.js";

// ---------------------------------------------------------------------------
// Parser tests
// ---------------------------------------------------------------------------

test("parsePlan: checklist items", () => {
  const items = parsePlan("- [ ] First step\n- [ ] Second step");
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, "First step");
  assert.equal(items[1]!.title, "Second step");
});

test("parsePlan: checked and unchecked checklist both parse", () => {
  const items = parsePlan("- [ ] Pending\n- [x] Done\n- [X] Also done");
  assert.equal(items.length, 3);
  assert.equal(items[0]!.title, "Pending");
  assert.equal(items[1]!.title, "Done");
  assert.equal(items[2]!.title, "Also done");
});

test("parsePlan: ordered list items", () => {
  const items = parsePlan("1. Alpha\n2. Beta\n3. Gamma");
  assert.equal(items.length, 3);
  assert.equal(items[0]!.title, "Alpha");
  assert.equal(items[1]!.title, "Beta");
  assert.equal(items[2]!.title, "Gamma");
});

test("parsePlan: plain bullet items", () => {
  const items = parsePlan("- Do thing A\n- Do thing B");
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, "Do thing A");
  assert.equal(items[1]!.title, "Do thing B");
});

test("parsePlan: headings prefix subsequent items", () => {
  const items = parsePlan("# Setup\n- Install deps\n# Cleanup\n- Remove temp files");
  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, "Setup: Install deps");
  assert.equal(items[1]!.title, "Cleanup: Remove temp files");
});

test("parsePlan: heading context resets on new heading", () => {
  const items = parsePlan("# Phase 1\n- Item A\n# Phase 2\n- Item B");
  assert.equal(items[0]!.title, "Phase 1: Item A");
  assert.equal(items[1]!.title, "Phase 2: Item B");
});

test("parsePlan: no heading means no prefix", () => {
  const items = parsePlan("- Plain item");
  assert.equal(items[0]!.title, "Plain item");
});

test("parsePlan: indented continuation lines become description", () => {
  const items = parsePlan(
    "- Do the thing\n  With extra context here\n  And more details",
  );
  assert.equal(items.length, 1);
  assert.equal(items[0]!.title, "Do the thing");
  assert.equal(items[0]!.description, "With extra context here\nAnd more details");
});

test("parsePlan: description defaults to item text when no continuations", () => {
  const items = parsePlan("- Simple item");
  assert.equal(items[0]!.description, "Simple item");
});

test("parsePlan: blank lines between items are ignored", () => {
  const items = parsePlan("- First\n\n- Second\n\n- Third");
  assert.equal(items.length, 3);
});

test("parsePlan: unrecognised prose flushes the pending item", () => {
  const items = parsePlan([
    "- First step",
    "This paragraph should not become a continuation line",
    "- Second step",
  ].join("\n"));

  assert.equal(items.length, 2);
  assert.equal(items[0]!.title, "First step");
  assert.equal(items[0]!.description, "First step");
  assert.equal(items[1]!.title, "Second step");
});

test("parsePlan: inline cost metadata", () => {
  const items = parsePlan("- Do something (cost: 15)");
  assert.equal(items[0]!.title, "Do something");
  assert.equal(items[0]!.cost, 15);
});

test("parsePlan: inline assignee and reviewer", () => {
  const items = parsePlan("- Do something (assignee: coder, reviewer: overseer)");
  assert.equal(items[0]!.assignee, "coder");
  assert.equal(items[0]!.reviewer, "overseer");
});

test("parsePlan: skip-analysis flag true", () => {
  const items = parsePlan("- Trivial task (skip-analysis: true)");
  assert.equal(items[0]!.skipAnalysis, true);
});

test("parsePlan: skip-analysis flag false", () => {
  const items = parsePlan("- Normal task (skip-analysis: false)");
  assert.equal(items[0]!.skipAnalysis, false);
});

test("parsePlan: combined metadata", () => {
  const items = parsePlan(
    "- Full item (cost: 20, assignee: coder, reviewer: lead, skip-analysis: true)",
  );
  assert.equal(items[0]!.title, "Full item");
  assert.equal(items[0]!.cost, 20);
  assert.equal(items[0]!.assignee, "coder");
  assert.equal(items[0]!.reviewer, "lead");
  assert.equal(items[0]!.skipAnalysis, true);
});

test("parsePlan: metadata stripped from title", () => {
  const items = parsePlan("- Fix the bug (cost: 5)");
  assert.equal(items[0]!.title, "Fix the bug");
  assert.equal(items[0]!.cost, 5);
});

test("parsePlan: heading prefix not applied to description", () => {
  const items = parsePlan("# Phase\n- Task title");
  assert.equal(items[0]!.title, "Phase: Task title");
  assert.equal(items[0]!.description, "Task title"); // description has no heading prefix
});

test("parsePlan: mixed formats in one plan", () => {
  const plan = [
    "# Bootstrap",
    "- [ ] Install dependencies (cost: 5)",
    "1. Configure environment (cost: 10, assignee: infra)",
    "# Feature",
    "- Build the thing",
    "  Detailed instructions here",
  ].join("\n");

  const items = parsePlan(plan);
  assert.equal(items.length, 3);
  assert.equal(items[0]!.title, "Bootstrap: Install dependencies");
  assert.equal(items[0]!.cost, 5);
  assert.equal(items[1]!.title, "Bootstrap: Configure environment");
  assert.equal(items[1]!.cost, 10);
  assert.equal(items[1]!.assignee, "infra");
  assert.equal(items[2]!.title, "Feature: Build the thing");
  assert.equal(items[2]!.description, "Detailed instructions here");
});

// ---------------------------------------------------------------------------
// Cost allocation tests
// ---------------------------------------------------------------------------

test("allocateCosts: errors on empty items", () => {
  const result = allocateCosts([], 100);
  assert.equal(result.ok, false);
});

test("allocateCosts: errors on zero budget", () => {
  const items = parsePlan("- Step");
  const result = allocateCosts(items, 0);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no positive budget/);
});

test("allocateCosts: errors on negative budget", () => {
  const items = parsePlan("- Step");
  const result = allocateCosts(items, -5);
  assert.equal(result.ok, false);
});

test("allocateCosts: uses explicit costs as-is", () => {
  const items = parsePlan("- Step A (cost: 10)\n- Step B (cost: 20)");
  const result = allocateCosts(items, 100);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items[0]!.cost, 10);
  assert.equal(result.items[1]!.cost, 20);
});

test("allocateCosts: distributes remaining budget evenly", () => {
  const items = parsePlan("- A\n- B\n- C");
  const result = allocateCosts(items, 30);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items[0]!.cost, 10);
  assert.equal(result.items[1]!.cost, 10);
  assert.equal(result.items[2]!.cost, 10);
});

test("allocateCosts: distributes remainder cents to first items", () => {
  // $10.01 across 3 items → 3.34, 3.34, 3.33 (1 extra cent to first two)
  const items = parsePlan("- A\n- B\n- C");
  const result = allocateCosts(items, 10.01);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const totalCents = result.items.reduce((s, i) => s + Math.round(i.cost * 100), 0);
  assert.equal(totalCents, 1001);
  assert.equal(result.items[0]!.cost, 3.34);
  assert.equal(result.items[1]!.cost, 3.34);
  assert.equal(result.items[2]!.cost, 3.33);
});

test("allocateCosts: mixes explicit and auto-distributed costs", () => {
  const items = parsePlan("- A (cost: 10)\n- B\n- C");
  const result = allocateCosts(items, 30);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items[0]!.cost, 10); // explicit
  assert.equal(result.items[1]!.cost, 10); // (30 - 10) / 2
  assert.equal(result.items[2]!.cost, 10);
});

test("allocateCosts: total equals budget when all auto", () => {
  const items = parsePlan("- A\n- B");
  const result = allocateCosts(items, 50);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  const totalCents = result.items.reduce((s, i) => s + Math.round(i.cost * 100), 0);
  assert.equal(totalCents, 5000);
});

test("allocateCosts: errors if explicit costs exceed budget", () => {
  const items = parsePlan("- A (cost: 60)\n- B (cost: 50)");
  const result = allocateCosts(items, 100);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /exceed/);
});

test("allocateCosts: errors if no budget left for unspecified items", () => {
  const items = parsePlan("- A (cost: 100)\n- B");
  const result = allocateCosts(items, 100);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.match(result.error, /no budget/);
});

test("allocateCosts: preserves assignee and reviewer on items", () => {
  const items = parsePlan("- Task (cost: 10, assignee: coder, reviewer: lead)");
  const result = allocateCosts(items, 100);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items[0]!.assignee, "coder");
  assert.equal(result.items[0]!.reviewer, "lead");
});

test("allocateCosts: preserves skipAnalysis flag", () => {
  const items = parsePlan("- Task (cost: 10, skip-analysis: true)");
  const result = allocateCosts(items, 100);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items[0]!.skipAnalysis, true);
});

test("allocateCosts: single item gets full budget when no cost specified", () => {
  const items = parsePlan("- Single task");
  const result = allocateCosts(items, 25);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.items[0]!.cost, 25);
});
