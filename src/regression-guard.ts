// Regression guard (grounded in Harness Continual Learning, arXiv 2608.19013):
// harness-level forgetting — autonomous edits can destroy previously reliable
// behavior even when the model is frozen. This guard enforces the minimal
// invariant that keeps evolution safe:
//
//   1. PROVEN items are protected from AUTONOMOUS deletion. An item whose
//      fitness >= PROTECTED_FITNESS_FLOOR has earned its place (authored at
//      high importance and/or validated by outcomes); a model batch may not
//      delete it. Manual /harness drop remains the escape hatch.
//   2. Mass deletion is capped: even weak items cannot be wiped in bulk by a
//      single autonomous batch.
//
// Enforcement happens ONLY on model-authored batches (actorModel set) — manual
// commands and maintenance paths bypass it entirely. Creates/updates are never
// blocked: adding lessons and repairing content is how evolution progresses.

import type { Delta, HarnessItem } from "./types.js";
import { fitness } from "./select.js";

/** Items at or above this fitness are protected from autonomous deletion. */
export const PROTECTED_FITNESS_FLOOR = 0.7;

/** Max deletions allowed in a single autonomous batch. */
export const MAX_AUTONOMOUS_DELETIONS = 3;

export interface GuardResult {
  ok: boolean;
  violations: string[];
}

/**
 * Evaluate an autonomous delta batch against the current store.
 * Pure: takes the items snapshot, returns violations (empty = allowed).
 * Only `delete` deltas are inspected — creates/updates never regress
 * existing behavior.
 */
export function evaluateRegressionGuard(
  deltas: Delta[],
  items: HarnessItem[],
): GuardResult {
  const violations: string[] = [];
  let deletes = 0;

  for (const d of deltas) {
    if (d.op !== "delete") continue;
    deletes += 1;

    const item = items.find((i) => i.id === d.id);
    if (!item || !item.active) continue;

    if (fitness(item) >= PROTECTED_FITNESS_FLOOR) {
      violations.push(
        `delete [${item.id}] rejected: proven item (fitness ${fitness(item).toFixed(2)} ≥ ${PROTECTED_FITNESS_FLOOR}, ${item.applications ?? 0} ok / ${item.failures ?? 0} failed). If removal is truly needed, use /harness drop ${item.id} manually.`,
      );
    }
  }

  if (deletes > MAX_AUTONOMOUS_DELETIONS) {
    violations.push(
      `batch deletes ${deletes} items — more than the autonomous limit of ${MAX_AUTONOMOUS_DELETIONS}. Split the cleanup or use manual /harness prune.`,
    );
  }

  return { ok: violations.length === 0, violations };
}
