// Periodic store consolidation — the "refine" half of ACE's grow-and-refine.
//
// Without consolidation the store grows monotonically: near-duplicates
// accumulate, stale items linger below the injection cut. This module runs
// the two existing hygiene primitives on a cadence so the store stays healthy
// without manual /harness commands:
//
//   1. dedupe proposer  → deletes near-duplicate active items (same kind+owner)
//   2. decayAndPrune    → drops items below the importance floor
//
// Everything flows through applyDeltas/persist, so consolidations are audited
// harness-state entries and rollbackable via /tree like any other mutation.

import type { HarnessConfig } from "./config.js";
import { dedupeProposer } from "./proposer.js";
import { applyDeltas, decayAndPrune, snapshotState } from "./store.js";

export const DEFAULT_CONSOLIDATE_EVERY_TURNS = 25;

export interface ConsolidationResult {
  /** Near-duplicate items removed by the dedupe proposer. */
  merged: number;
  /** Stale items dropped by decay/prune. */
  pruned: number;
}

// turnIndex of the last consolidation. -1 = unseen (first observed turn seeds).
let lastConsolidatedTurn = -1;

/** Test hook. */
export function resetConsolidation(): void {
  lastConsolidatedTurn = -1;
}

/** Cadence decision, same pattern as evaluateAutoRefine/evaluateReminder. */
export function evaluateConsolidation(config: HarnessConfig, turnIndex: number): boolean {
  if (!config.consolidate?.enabled) return false;
  const every = config.consolidate.everyTurns ?? DEFAULT_CONSOLIDATE_EVERY_TURNS;
  if (every <= 0) return false;
  if (lastConsolidatedTurn < 0) {
    lastConsolidatedTurn = turnIndex;
    return false;
  }
  if (turnIndex - lastConsolidatedTurn >= every) {
    lastConsolidatedTurn = turnIndex;
    return true;
  }
  return false;
}

/** Run one consolidation pass: dedupe near-duplicates, then decay/prune. */
export async function runConsolidation(
  persist: (snapshot: unknown, version: number) => void,
): Promise<ConsolidationResult> {
  let merged = 0;

  // 1. Dedupe: rule-based proposer produces delete deltas for near-duplicates.
  const proposal = await dedupeProposer.propose({ evidence: "", state: snapshotState(), lookback: 0 });
  if (proposal.deltas && proposal.deltas.length > 0) {
    const applied = applyDeltas(
      proposal.deltas.map((d) => d.delta),
      persist as never,
    );
    merged = applied.length;
  }

  // 2. Decay/prune: drop whatever now sits below the importance floor.
  const prune = decayAndPrune({}, persist as never);

  return { merged, pruned: prune.pruned };
}
