import * as fs from "node:fs";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentEntry {
  id: string;
  role?: string;
  assignable: boolean;
  reviewer: boolean;
  consulted: boolean;
}

export interface MemberEntry {
  id: string;
  name?: string;
  role?: string;
  assignable: boolean;
  reviewer: boolean;
  consulted: boolean;
}

interface RegistryFile {
  agents: AgentEntry[];
  members?: MemberEntry[];
  specialRoles?: {
    reviewer?: string[];
    consulted?: string[];
  };
}

export interface Registry {
  agents: AgentEntry[];
  members: MemberEntry[];
  /** All valid IDs for the assignee field (agents + members with assignable=true) */
  validAssignees: ReadonlySet<string>;
  /** All valid IDs for the reviewer field */
  validReviewers: ReadonlySet<string>;
  /** All valid IDs for the consulted field */
  validConsulted: ReadonlySet<string>;
  /** Human member IDs */
  memberIds: ReadonlySet<string>;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export function loadRegistry(registryPath: string): Registry {
  let data: RegistryFile;
  try {
    data = JSON.parse(fs.readFileSync(registryPath, "utf-8")) as RegistryFile;
  } catch {
    console.warn("[registry] Could not load registry:", registryPath);
    data = { agents: [], members: [], specialRoles: {} };
  }

  const agents = data.agents ?? [];
  const members = data.members ?? [];
  const specialRoles = data.specialRoles ?? {};

  const validAssignees = new Set<string>();
  const validReviewers = new Set<string>();
  const validConsulted = new Set<string>();
  const memberIds = new Set<string>();

  for (const a of agents) {
    if (a.assignable) validAssignees.add(a.id);
    if (a.reviewer) validReviewers.add(a.id);
    if (a.consulted) validConsulted.add(a.id);
  }

  for (const m of members) {
    memberIds.add(m.id);
    if (m.assignable) validAssignees.add(m.id);
    if (m.reviewer) validReviewers.add(m.id);
    if (m.consulted) validConsulted.add(m.id);
  }

  for (const id of specialRoles.reviewer ?? []) validReviewers.add(id);
  for (const id of specialRoles.consulted ?? []) validConsulted.add(id);

  return {
    agents,
    members,
    validAssignees,
    validReviewers,
    validConsulted,
    memberIds,
  };
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

export function validateAssignee(registry: Registry, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value);
  if (!registry.validAssignees.has(id)) {
    return `Unknown assignee "${id}". Valid: ${[...registry.validAssignees].join(", ")}`;
  }
  return null;
}

export function validateReviewer(registry: Registry, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value);
  if (!registry.validReviewers.has(id)) {
    return `Unknown reviewer "${id}". Valid: ${[...registry.validReviewers].join(", ")}`;
  }
  return null;
}

export function validateConsulted(registry: Registry, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const id = String(value);
  if (!registry.validConsulted.has(id)) {
    return `Unknown consulted "${id}". Valid: ${[...registry.validConsulted].join(", ")}`;
  }
  return null;
}

/** Returns error message or null if all metadata role fields are valid. */
export function validateMetadataRoles(
  registry: Registry,
  patch: Record<string, unknown>,
): string | null {
  if ("assignee" in patch && patch["assignee"] !== null) {
    const err = validateAssignee(registry, patch["assignee"]);
    if (err) return err;
  }
  if ("reviewer" in patch && patch["reviewer"] !== null) {
    const err = validateReviewer(registry, patch["reviewer"]);
    if (err) return err;
  }
  if ("consulted" in patch && patch["consulted"] !== null) {
    const err = validateConsulted(registry, patch["consulted"]);
    if (err) return err;
  }
  return null;
}
