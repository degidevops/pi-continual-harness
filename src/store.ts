// The unified harness-state store.
//
// Two persistence layers:
//  1. Session-scoped (the core): the full state is snapshotted via
//     pi.appendEntry("harness-state", ...) after every mutation and
//     reconstructed on session_start from the current branch. Because pi's
//     session tree branches at any entry, navigating /tree to before a
//     refinement and resuming gives rollback for free.
//  2. Durable (the composition seam): exportDurable() writes the active items
//     to a markdown file pi-reflect can read and refine offline, and pi-mem can
//     ingest. Best-effort; the package works without it.

import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AppliedDelta, ComponentKind, Delta, HarnessItem, HarnessState } from "./types.js";

const STATE_ENTRY = "harness-state";
const REFINE_ENTRY = "harness-refinement";

const DEFAULT_DURABLE_PATH = join(homedir(), ".pi", "agent", "harness-state.md");

const IMPORTANCE_FLOOR = 0.3;

// Module-scoped state. Rebuilt on every session_start, so it tracks the active
// branch. Mutations are synchronous, so concurrent tool calls cannot interleave
// inside a single mutation.
let state: HarnessState = { items: [] };
let version = 0;

export function getState(): HarnessState {
  return state;
}

export function listItems(kind?: ComponentKind): HarnessItem[] {
  return kind ? state.items.filter((i) => i.kind === kind) : state.items;
}

function genId(): string {
  return `h_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(1, n));
}

/** Apply a single delta against the in-memory state. Does not persist. */
function applyOne(delta: Delta): AppliedDelta {
  if (delta.op === "create") {
    const now = Date.now();
    const item: HarnessItem = {
      id: genId(),
      kind: delta.kind,
      content: delta.content,
      evidence: delta.evidence,
      importance: clamp(delta.importance ?? 0.5),
      active: true,
      createdAt: now,
      updatedAt: now,
    };
    state.items.push(item);
    return { op: "create", item };
  }

  if (delta.op === "update") {
    const idx = state.items.findIndex((i) => i.id === delta.id);
    if (idx < 0) throw new Error(`update: no item with id ${delta.id}`);
    const before = state.items[idx]!;
    const after: HarnessItem = {
      ...before,
      content: delta.content ?? before.content,
      evidence: delta.evidence ?? before.evidence,
      importance: clamp(delta.importance ?? before.importance),
      active: delta.active ?? before.active,
      updatedAt: Date.now(),
    };
    state.items[idx] = after;
    return { op: "update", before, after };
  }

  // delete
  const idx = state.items.findIndex((i) => i.id === delta.id);
  if (idx < 0) throw new Error(`delete: no item with id ${delta.id}`);
  state.items.splice(idx, 1);
  return { op: "delete", id: delta.id, reason: delta.reason };
}

/**
 * Apply a batch of deltas. All-or-nothing: if any delta throws, nothing is
 * applied. Returns the applied deltas and the new version.
 */
export function applyDeltas(
  deltas: Delta[],
  persist: (snapshot: HarnessState, version: number) => void,
): AppliedDelta[] {
  const snapshotBefore = { items: state.items.map((i) => ({ ...i })) };
  const applied: AppliedDelta[] = [];
  try {
    for (const d of deltas) applied.push(applyOne(d));
  } catch (err) {
    // Roll back in-memory state on failure.
    state = snapshotBefore;
    throw err;
  }
  version += 1;
  persist(state, version);
  return applied;
}

/** Reconstruct state from the current branch's last harness-state snapshot. */
export function reconstruct(entries: Iterable<unknown>): void {
  let last: HarnessState | undefined;
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: { state?: HarnessState } };
    if (entry.type === "custom" && entry.customType === STATE_ENTRY && entry.data?.state) {
      last = entry.data.state;
    }
  }
  state = last ? { items: last.items.map((i) => ({ ...i })) } : { items: [] };
  version = 0;
}

/** Decrement importance of inactive/low-signal items; prune below the floor. */
export function decayAndPrune(persist: (snapshot: HarnessState, version: number) => void): {
  pruned: number;
} {
  const before = state.items.length;
  state.items = state.items.filter((i) => i.importance >= IMPORTANCE_FLOOR);
  version += 1;
  persist(state, version);
  return { pruned: before - state.items.length };
}

export { STATE_ENTRY, REFINE_ENTRY, IMPORTANCE_FLOOR };

// ---- Durable export (composition seam with pi-reflect / pi-mem) -------------

export async function exportDurable(path = DEFAULT_DURABLE_PATH): Promise<string> {
  const lines: string[] = ["# Continual Harness State", ""];
  const kinds: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];
  for (const kind of kinds) {
    const items = state.items.filter((i) => i.kind === kind && i.active);
    if (items.length === 0) continue;
    lines.push(`## ${titleFor(kind)}`, "");
    for (const i of items) {
      lines.push(`- **[${i.id}]** (importance ${i.importance.toFixed(2)}) ${i.content}`);
      lines.push(`  - evidence: ${i.evidence}`);
    }
    lines.push("");
  }
  if (lines.length <= 2) lines.push("_(no active items)_", "");
  const body = lines.join("\n");
  await mkdir(dirname(path), { recursive: true }).catch(() => {});
  await writeFile(path, body, "utf8");
  return path;
}

function titleFor(kind: ComponentKind): string {
  switch (kind) {
    case "prompt":
      return "Supplemental prompt notes";
    case "memory":
      return "Memory facts";
    case "skill":
      return "Skill descriptions";
    case "subagent":
      return "Sub-agent specs";
  }
}
