import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HarnessItem, HarnessState } from "../src/types.js";
import {
  getState,
  reconstruct,
  promoteToShared,
  demoteFromShared,
  setCrossModelEnabled,
  optIntoSharedPool,
  optOutOfSharedPool,
  recordOutcome,
  getPromotionCandidates,
  getDemotionCandidates,
  applyDeltas,
} from "../src/store.js";
import { modelKey } from "../src/store.js";

function item(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "kind" | "content">): HarnessItem {
  const now = 10_000;
  return { evidence: "e", importance: 0.5, active: true, ownerModel: "", createdAt: now, updatedAt: now, ...over };
}

function state(items: HarnessItem[]): HarnessState {
  return { items, crossModel: { enabled: false, optedInModels: [] }, outcomeTracking: { minApplications: 3, failureRatioThreshold: 0.5, demotionPenalty: 0.15 } };
}

const persist = (s: HarnessState, v: number) => { };

describe("cross-model sharing (B2)", () => {
  beforeEach(() => {
    reconstruct([]);
  });

  it("promoteToShared moves item to shared pool", () => {
    const applied = applyDeltas([{ op: "create", kind: "prompt", content: "shared note", evidence: "e", ownerModel: "anthropic/claude" }], persist);
    const createDelta = applied[0]!;
    if (createDelta.op !== "create") throw new Error("expected create");
    const itemId = createDelta.item.id;
    const promoted = promoteToShared(itemId, persist);
    expect(promoted).toBeDefined();
    expect(promoted!.ownerModel).toBe("shared");
  });

  it("demoteFromShared moves item back to model", () => {
    const applied = applyDeltas([{ op: "create", kind: "prompt", content: "shared note", evidence: "e", ownerModel: "shared" }], persist);
    const createDelta = applied[0]!;
    if (createDelta.op !== "create") throw new Error("expected create");
    const itemId = createDelta.item.id;
    const demoted = demoteFromShared(itemId, "anthropic/claude", persist);
    expect(demoted).toBeDefined();
    expect(demoted!.ownerModel).toBe("anthropic/claude");
  });

  it("setCrossModelEnabled toggles shared pool", () => {
    setCrossModelEnabled(true, persist);
    expect(getState().crossModel?.enabled).toBe(true);
    setCrossModelEnabled(false, persist);
    expect(getState().crossModel?.enabled).toBe(false);
  });

  it("optIntoSharedPool adds model to opted-in list", () => {
    setCrossModelEnabled(true, persist);
    optIntoSharedPool("anthropic/claude", persist);
    expect(getState().crossModel?.optedInModels).toContain("anthropic/claude");
  });

  it("optOutOfSharedPool removes model from opted-in list", () => {
    setCrossModelEnabled(true, persist);
    optIntoSharedPool("anthropic/claude", persist);
    optOutOfSharedPool("anthropic/claude", persist);
    expect(getState().crossModel?.optedInModels).not.toContain("anthropic/claude");
  });
});

describe("outcome tracking (B3)", () => {
  beforeEach(() => {
    reconstruct([]);
  });

  it("recordOutcome increments applications on success", () => {
    applyDeltas([{ op: "create", kind: "prompt", content: "test", evidence: "e", deltaId: "d_1" }], persist);
    recordOutcome({ deltaId: "d_1", success: true, turnIndex: 1 }, persist);
    const item = getState().items.find((i) => i.deltaId === "d_1");
    expect(item?.applications).toBe(1);
    expect(item?.failures).toBe(0);
  });

  it("recordOutcome increments failures on failure", () => {
    applyDeltas([{ op: "create", kind: "prompt", content: "test", evidence: "e", deltaId: "d_2" }], persist);
    recordOutcome({ deltaId: "d_2", success: false, turnIndex: 1 }, persist);
    const item = getState().items.find((i) => i.deltaId === "d_2");
    expect(item?.applications).toBe(0);
    expect(item?.failures).toBe(1);
  });

  it("auto-demotes item when failure ratio exceeds threshold", () => {
    // minApplications=3, failureRatioThreshold=0.5
    const applied = applyDeltas([{ op: "create", kind: "prompt", content: "bad item", evidence: "e", deltaId: "d_3", importance: 0.8 }], persist);
    const createDelta = applied[0]!;
    if (createDelta.op !== "create") throw new Error("expected create");
    const itemId = createDelta.item.id;
    // 3 successes, 4 failures -> ratio = 4/7 = 0.57 > 0.5
    recordOutcome({ deltaId: "d_3", success: true, turnIndex: 1 }, persist);
    recordOutcome({ deltaId: "d_3", success: true, turnIndex: 2 }, persist);
    recordOutcome({ deltaId: "d_3", success: true, turnIndex: 3 }, persist);
    recordOutcome({ deltaId: "d_3", success: false, turnIndex: 4 }, persist);
    recordOutcome({ deltaId: "d_3", success: false, turnIndex: 5 }, persist);
    recordOutcome({ deltaId: "d_3", success: false, turnIndex: 6 }, persist);
    recordOutcome({ deltaId: "d_3", success: false, turnIndex: 7 }, persist);
    const item = getState().items.find((i) => i.id === itemId);
    expect(item?.importance).toBeLessThan(0.8); // demoted by 0.15
  });

  it("getPromotionCandidates returns high-quality items", () => {
    applyDeltas([
      { op: "create", kind: "prompt", content: "good", evidence: "e", deltaId: "d_4", importance: 0.9 },
      { op: "create", kind: "prompt", content: "bad", evidence: "e", deltaId: "d_5", importance: 0.3 },
    ], persist);
    // Simulate good track record for d_4
    const item4 = getState().items.find((i) => i.deltaId === "d_4")!;
    item4.applications = 10;
    item4.failures = 1;
    const candidates = getPromotionCandidates(0.7, 5);
    expect(candidates.some((c) => c.deltaId === "d_4")).toBe(true);
    expect(candidates.some((c) => c.deltaId === "d_5")).toBe(false);
  });

  it("getDemotionCandidates returns poor track record items", () => {
    applyDeltas([{ op: "create", kind: "prompt", content: "bad", evidence: "e", deltaId: "d_6", importance: 0.6 }], persist);
    const item6 = getState().items.find((i) => i.deltaId === "d_6")!;
    item6.applications = 5;
    item6.failures = 3; // ratio = 0.6 > 0.5
    const candidates = getDemotionCandidates();
    expect(candidates.some((c) => c.deltaId === "d_6")).toBe(true);
  });
});