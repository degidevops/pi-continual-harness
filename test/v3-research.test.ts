// Evolution v3 research features:
//   - Regression guard (HCL, arXiv 2608.19013): autonomous batches may not
//     delete proven items or mass-delete.
//   - Revision history + pairwise comparison (RHI, arXiv 2607.15524):
//     repairs archive predecessors; variants are compared by success rate.

import { describe, it, expect, beforeEach } from "vitest";
import { evaluateRegressionGuard, PROTECTED_FITNESS_FLOOR, MAX_AUTONOMOUS_DELETIONS } from "../src/regression-guard.js";
import { compareRevisions, bestRevision } from "../src/revisions.js";
import { applyDeltas, getState, reconstruct } from "../src/store.js";
import type { HarnessItem } from "../src/types.js";

function reset(): void {
  reconstruct([]);
}

function mkItem(id: string, content: string): HarnessItem {
  return {
    id,
    kind: "prompt",
    content,
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "test/main",
    createdAt: 0,
    updatedAt: 0,
    applications: 0,
    failures: 0,
  };
}

describe("regression guard (regression-guard.ts)", () => {
  it("rejects deletion of a proven item", () => {
    const proven = mkItem("h_proven", "critical lesson");
    proven.importance = 0.9;
    const guard = evaluateRegressionGuard([{ op: "delete", id: "h_proven", reason: "cleanup" }], [proven]);
    expect(guard.ok).toBe(false);
    expect(guard.violations[0]).toContain("h_proven");
    expect(guard.violations[0]).toContain("/harness drop");
  });

  it("allows deletion of weak items below the protection floor", () => {
    const weak = mkItem("h_weak", "barely used note");
    weak.importance = 0.35;
    const guard = evaluateRegressionGuard([{ op: "delete", id: "h_weak", reason: "cleanup" }], [weak]);
    expect(guard.ok).toBe(true);
  });

  it("caps mass deletion in one batch", () => {
    const items = Array.from({ length: MAX_AUTONOMOUS_DELETIONS + 1 }, (_, i) =>
      mkItem(`h_w${i}`, `weak note ${i} with filler words here`),
    );
    for (const i of items) i.importance = 0.3;
    const deltas = items.map((i) => ({ op: "delete" as const, id: i.id, reason: "bulk" }));
    const guard = evaluateRegressionGuard(deltas, items);
    expect(guard.ok).toBe(false);
    expect(guard.violations[0]).toContain("autonomous limit");
  });

  it("never blocks creates/updates — only deletions are guarded", () => {
    const proven = mkItem("h_proven", "critical lesson");
    proven.importance = 0.95;
    const guard = evaluateRegressionGuard(
      [
        { op: "create", kind: "prompt", content: "new lesson", evidence: "e" },
        { op: "update", id: "h_proven", importance: 0.5 },
      ],
      [proven],
    );
    expect(guard.ok).toBe(true);
  });

  it("floor constant is sane", () => {
    expect(PROTECTED_FITNESS_FLOOR).toBeGreaterThanOrEqual(0.6);
    expect(PROTECTED_FITNESS_FLOOR).toBeLessThanOrEqual(0.85);
  });
});

describe("revision history + pairwise comparison (revisions.ts)", () => {
  beforeEach(() => {
    reset();
  });

  it("repair archives the predecessor with its outcome record", () => {
    applyDeltas([{ op: "create", kind: "skill", content: "v1 approach", evidence: "e", deltaId: "d1" }], () => {});
    const item = getState().items[0]!;
    item.applications = 4;
    item.failures = 2;

    applyDeltas([{ op: "update", id: item.id, content: "v2 improved approach" }], () => {});

    const repaired = getState().items.find((i) => i.id === item.id)!;
    expect(repaired.revisions).toHaveLength(1);
    expect(repaired.revisions![0]!.content).toBe("v1 approach");
    expect(repaired.revisions![0]!.applications).toBe(4);
    expect(repaired.revisions![0]!.failures).toBe(2);
    // fresh trial started
    expect(repaired.applications).toBe(0);
  });

  it("archives at most MAX_REVISIONS predecessors (bounded history)", () => {
    applyDeltas([{ op: "create", kind: "prompt", content: "v0", evidence: "e" }], () => {});
    const item = getState().items[0]!;
    for (let v = 1; v <= 8; v++) {
      applyDeltas([{ op: "update", id: item.id, content: `v${v}` }], () => {});
    }
    const stored = getState().items.find((i) => i.id === item.id)!;
    expect(stored.revisions!.length).toBeLessThanOrEqual(5);
    // newest-last ordering: latest archived is v7 (v8 is current)
    expect(stored.revisions!.at(-1)!.content).toBe("v7");
    expect(stored.content).toBe("v8");
  });

  it("compareRevisions ranks by success rate; bestRevision prefers clear winners over current", () => {
    const item: HarnessItem = {
      ...mkItem("h_cmp", "current variant"),
      applications: 1,
      failures: 3, // successRate 0.25
      revisions: [
        { content: "old better variant", importance: 0.5, applications: 8, failures: 0, archivedAt: 1 }, // 1.0
      ],
    };
    const rows = compareRevisions(item);
    expect(rows).toHaveLength(2);

    const best = bestRevision(item)!;
    expect(best.variant.startsWith("revision-")).toBe(true);
    expect(best.successRate).toBe(1);
  });

  it("ties prefer CURRENT content (stability bias)", () => {
    const item: HarnessItem = {
      ...mkItem("h_tie", "current"),
      applications: 5,
      failures: 0,
      revisions: [{ content: "older equal", importance: 0.5, applications: 5, failures: 0, archivedAt: 1 }],
    };
    expect(bestRevision(item)!.variant).toBe("current");
  });

  it("returns null when there is no outcome history to compare", () => {
    const fresh = mkItem("h_fresh", "brand new");
    expect(bestRevision(fresh)).toBeNull();
  });
});
