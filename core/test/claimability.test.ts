import test from "node:test";
import assert from "node:assert/strict";

import {
  agentRole,
  claimabilityRoleTag,
  compareClaimableTasks,
  filterClaimableTasks,
  includeReviewQueueTask,
  isClaimableByRole,
} from "../cli/claimability.js";

function makeTask(overrides: Record<string, unknown> = {}, metadata: Record<string, unknown> = {}): Record<string, unknown> {
  const base = {
    id: "1",
    phase: "execution",
    condition: "ready",
    updatedAt: 1_000,
    metadata: {
      priority: "medium",
      ...metadata,
    },
  };
  return {
    ...base,
    ...overrides,
    metadata: {
      ...(base.metadata as Record<string, unknown>),
      ...(metadata ?? {}),
      ...(typeof overrides.metadata === "object" && overrides.metadata !== null && !Array.isArray(overrides.metadata)
        ? overrides.metadata as Record<string, unknown>
        : {}),
    },
  };
}

test("agentRole normalizes instance ids", () => {
  assert.equal(agentRole("codex.22"), "codex");
  assert.equal(agentRole("coder"), "coder");
});

test("execution claimability matches by normalized assignee role", () => {
  const mine = makeTask({ id: "mine" }, { assignee: "codex.7" });
  const other = makeTask({ id: "other" }, { assignee: "ceo" });

  const result = filterClaimableTasks([mine, other], "codex");
  assert.deepEqual(result.map((task) => task.id), ["mine"]);
  assert.equal(isClaimableByRole(mine, "codex"), true);
});

test("review claimability uses reviewer instead of assignee", () => {
  const misleading = makeTask(
    { id: "wrong", phase: "review" },
    { assignee: "codex", reviewer: "ceo" },
  );
  const correct = makeTask(
    { id: "right", phase: "review" },
    { assignee: "ceo", reviewer: "codex.11" },
  );

  const result = filterClaimableTasks([misleading, correct], "codex");
  assert.deepEqual(result.map((task) => task.id), ["right"]);
});

test("review sorting ranks mine before unassigned before other reviewers", () => {
  const mine = makeTask({ id: "mine", phase: "review", updatedAt: 100 }, { reviewer: "codex.11" });
  const unassigned = makeTask({ id: "open", phase: "review", updatedAt: 200 }, { reviewer: "" });
  const other = makeTask({ id: "other", phase: "review", updatedAt: 300 }, { reviewer: "ceo" });

  const sorted = [other, unassigned, mine].sort((a, b) => compareClaimableTasks(a, b, "codex"));
  assert.deepEqual(sorted.map((task) => task.id), ["mine", "open", "other"]);
});

test("claimability role tags follow normalized reviewer ownership", () => {
  const mine = makeTask({ phase: "review" }, { reviewer: "codex.11" });
  const open = makeTask({ phase: "review" }, { reviewer: "unset" });
  const other = makeTask({ phase: "review" }, { assignee: "codex", reviewer: "ceo" });

  assert.equal(claimabilityRoleTag(mine, "codex"), " *");
  assert.equal(claimabilityRoleTag(open, "codex"), " +");
  assert.equal(claimabilityRoleTag(other, "codex"), "");
});

test("review queue scopes match claimable, mine, and all semantics", () => {
  const mine = makeTask({ id: "mine", phase: "review" }, { reviewer: "codex.3" });
  const open = makeTask({ id: "open", phase: "review" }, { reviewer: "" });
  const other = makeTask({ id: "other", phase: "review" }, { reviewer: "ceo" });
  const nonReview = makeTask({ id: "exec", phase: "execution" }, { assignee: "codex" });

  assert.equal(includeReviewQueueTask(mine, "codex", "claimable"), true);
  assert.equal(includeReviewQueueTask(open, "codex", "claimable"), true);
  assert.equal(includeReviewQueueTask(other, "codex", "claimable"), false);

  assert.equal(includeReviewQueueTask(mine, "codex", "mine"), true);
  assert.equal(includeReviewQueueTask(open, "codex", "mine"), false);

  assert.equal(includeReviewQueueTask(other, "codex", "all"), true);
  assert.equal(includeReviewQueueTask(nonReview, "codex", "all"), false);
});
