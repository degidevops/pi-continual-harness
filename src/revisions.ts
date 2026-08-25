// Pairwise revision comparison (grounded in Recursive Harness Self-Improvement,
// arXiv 2607.15524): decisions about an item's content are informed by its own
// revision history — "which variant produced the better outcomes?" — rather
// than by raw counters alone.

import type { HarnessItem } from "./types.js";

export interface RevisionComparison {
  /** "current" or the archived revision index (0-based, oldest first). */
  variant: string;
  content: string;
  applications: number;
  failures: number;
  successRate: number;
}

/**
 * Build the full variant list for an item: current content first, then its
 * archived revisions (oldest → newest). Pure.
 */
export function compareRevisions(item: HarnessItem): RevisionComparison[] {
  const rows: RevisionComparison[] = [
    {
      variant: "current",
      content: item.content,
      applications: item.applications ?? 0,
      failures: item.failures ?? 0,
      successRate: successRate(item.applications ?? 0, item.failures ?? 0),
    },
  ];
  for (let i = 0; i < (item.revisions?.length ?? 0); i++) {
    const r = item.revisions![i]!;
    rows.push({
      variant: `revision-${i}`,
      content: r.content,
      applications: r.applications,
      failures: r.failures,
      successRate: successRate(r.applications, r.failures),
    });
  }
  return rows;
}

function successRate(apps: number, fails: number): number {
  return apps + fails === 0 ? -1 : apps / (apps + fails); // -1 = untested
}

/**
 * RHI-style verdict: which known variant has the best measured success rate?
 * Returns null while the item has no outcome history at all (nothing to
 * compare). Ties prefer the CURRENT content (stability bias — a repair should
 * only be reverted on clear evidence).
 */
export function bestRevision(
  item: HarnessItem,
): { variant: string; successRate: number } | null {
  const rows = compareRevisions(item).filter((r) => r.successRate >= 0);
  if (rows.length === 0) return null;
  let best = rows[0]!;
  for (const r of rows.slice(1)) {
    if (r.successRate > best.successRate) best = r;
  }
  return { variant: best.variant, successRate: best.successRate };
}
