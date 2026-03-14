/**
 * plan-parse.ts — parse markdown-ish plans into child task specs and allocate costs.
 *
 * Supports:
 *   - Checklist items:    `- [ ] title` or `- [x] title`
 *   - Ordered items:      `1. title`
 *   - Bullet items:       `- title`
 *   - Headings:           `# Section` — prefix subsequent items' titles with "Section: "
 *   - Continuation lines: indented (2+ spaces) lines after an item enrich its description
 *   - Trailing meta:      `(cost: 15, assignee: coder, reviewer: overseer, skip-analysis: true)`
 */

export interface ParsedItem {
  title: string;
  description: string;
  cost: number | undefined;
  assignee: string | undefined;
  reviewer: string | undefined;
  skipAnalysis: boolean;
}

export interface AllocatedItem {
  title: string;
  description: string;
  cost: number;
  assignee: string | undefined;
  reviewer: string | undefined;
  skipAnalysis: boolean;
}

interface ItemMeta {
  cost?: number;
  assignee?: string;
  reviewer?: string;
  skipAnalysis?: boolean;
}

function extractMeta(raw: string): { baseTitle: string; meta: ItemMeta } {
  // Match trailing parenthetical: `title (key: val, key: val)`
  const parenMatch = raw.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
  if (!parenMatch) return { baseTitle: raw.trim(), meta: {} };

  const baseTitle = parenMatch[1]!.trim();
  const metaStr = parenMatch[2]!;
  const meta: ItemMeta = {};

  for (const pair of metaStr.split(",")) {
    const colonIdx = pair.indexOf(":");
    if (colonIdx < 0) continue;
    const key = pair.slice(0, colonIdx).trim().toLowerCase();
    const value = pair.slice(colonIdx + 1).trim();

    switch (key) {
      case "cost": {
        const n = Number(value);
        if (Number.isFinite(n) && n > 0) meta.cost = n;
        break;
      }
      case "assignee":
        if (value) meta.assignee = value;
        break;
      case "reviewer":
        if (value) meta.reviewer = value;
        break;
      case "skip-analysis":
        meta.skipAnalysis = value === "true" || value === "1" || value === "yes";
        break;
    }
  }
  return { baseTitle, meta };
}

interface PendingItem {
  title: string;
  rawTitle: string; // item text without heading prefix, used as default description
  cost: number | undefined;
  assignee: string | undefined;
  reviewer: string | undefined;
  skipAnalysis: boolean;
}

/**
 * Parse a markdown-ish plan text into ParsedItem[].
 *
 * Item markers:
 *   - `- [ ] title` / `- [x] title`  — checklist
 *   - `1. title`                      — ordered list
 *   - `- title`                       — plain bullet
 *
 * Headings (`# …`) set a context prefix applied to all following items until
 * the next heading.
 *
 * Indented lines (2+ spaces) following an item are appended to its description.
 *
 * A trailing parenthetical `(key: value, …)` on any item line supplies metadata.
 */
export function parsePlan(text: string): ParsedItem[] {
  const lines = text.split("\n");
  const items: ParsedItem[] = [];
  let headingContext = "";
  let pending: PendingItem | null = null;
  const descLines: string[] = [];

  function flush(): void {
    if (!pending) return;
    const description = descLines.length > 0 ? descLines.join("\n") : pending.rawTitle;
    items.push({
      title: pending.title,
      description,
      cost: pending.cost,
      assignee: pending.assignee,
      reviewer: pending.reviewer,
      skipAnalysis: pending.skipAnalysis,
    });
    pending = null;
    descLines.length = 0;
  }

  for (const line of lines) {
    const trimmed = line.trim();

    // Blank lines — skip (don't flush; a blank between item and continuation is fine)
    if (trimmed === "") continue;

    // Heading: reset context prefix
    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flush();
      headingContext = headingMatch[1]!.trim();
      continue;
    }

    // Checklist: `- [ ] title`  or  `- [x] title`  (any char inside brackets)
    const checklistMatch = trimmed.match(/^-\s+\[[^\]]*\]\s+(.+)$/);
    // Ordered: `1. title`  (must not have already matched checklist)
    const orderedMatch = !checklistMatch ? trimmed.match(/^\d+\.\s+(.+)$/) : null;
    // Bullet: `- title`  (only when neither of the above matched)
    const bulletMatch = !checklistMatch && !orderedMatch ? trimmed.match(/^-\s+(.+)$/) : null;

    const itemText = checklistMatch?.[1] ?? orderedMatch?.[1] ?? bulletMatch?.[1];

    if (itemText !== undefined) {
      flush();
      const { baseTitle, meta } = extractMeta(itemText);
      const prefix = headingContext ? `${headingContext}: ` : "";
      pending = {
        title: prefix + baseTitle,
        rawTitle: baseTitle,
        cost: meta.cost,
        assignee: meta.assignee,
        reviewer: meta.reviewer,
        skipAnalysis: meta.skipAnalysis ?? false,
      };
      continue;
    }

    // Continuation: indented line (2+ spaces or a tab) while we have a pending item
    if (pending && /^[ \t]{2,}/.test(line)) {
      descLines.push(trimmed);
      continue;
    }

    // Unrecognised line — flush pending (don't silently swallow item boundaries)
    flush();
  }

  flush();
  return items;
}

/**
 * Allocate costs to items. Items with an explicit `cost` keep it; items without
 * share the remaining budget evenly. Uses integer arithmetic (cents) to avoid
 * float drift.
 *
 * Returns an error string on failure, or the allocated items on success.
 */
export function allocateCosts(
  items: ParsedItem[],
  budgetRemainingDollars: number,
): { ok: true; items: AllocatedItem[] } | { ok: false; error: string } {
  if (items.length === 0) {
    return { ok: false, error: "plan contains no items" };
  }

  // Work in integer cents to avoid float drift
  const budgetCents = Math.round(budgetRemainingDollars * 100);
  if (budgetCents <= 0) {
    return {
      ok: false,
      error: `no positive budget remaining (${budgetRemainingDollars.toFixed(2)})`,
    };
  }

  let specifiedCents = 0;
  let unspecifiedCount = 0;
  for (const item of items) {
    if (item.cost !== undefined) {
      specifiedCents += Math.round(item.cost * 100);
    } else {
      unspecifiedCount++;
    }
  }

  if (specifiedCents > budgetCents) {
    return {
      ok: false,
      error:
        `explicit costs (${(specifiedCents / 100).toFixed(2)}) exceed remaining budget` +
        ` (${budgetRemainingDollars.toFixed(2)})`,
    };
  }

  const remainingCents = budgetCents - specifiedCents;
  let perItemCents = 0;
  let extraCents = 0;

  if (unspecifiedCount > 0) {
    if (remainingCents <= 0) {
      return {
        ok: false,
        error: `no budget remains for ${unspecifiedCount} item(s) without explicit cost`,
      };
    }
    perItemCents = Math.floor(remainingCents / unspecifiedCount);
    extraCents = remainingCents % unspecifiedCount;
    if (perItemCents === 0) {
      return {
        ok: false,
        error:
          `remaining budget (${(remainingCents / 100).toFixed(2)}) too small to distribute` +
          ` across ${unspecifiedCount} uncosted item(s)`,
      };
    }
  }

  // Distribute extra cents to the first items (deterministic, no float drift)
  let extraGiven = 0;
  const allocated: AllocatedItem[] = items.map((item) => {
    let costCents: number;
    if (item.cost !== undefined) {
      costCents = Math.round(item.cost * 100);
    } else {
      costCents = perItemCents + (extraGiven < extraCents ? 1 : 0);
      if (extraGiven < extraCents) extraGiven++;
    }
    return {
      title: item.title,
      description: item.description,
      cost: costCents / 100,
      assignee: item.assignee,
      reviewer: item.reviewer,
      skipAnalysis: item.skipAnalysis,
    };
  });

  return { ok: true, items: allocated };
}
