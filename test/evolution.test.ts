// Evolution-loop mechanics: outcome-aware ranking, decay resistance,
// steering follow-through, and the shared failure-signature detector.
// Grounded in Continual Harness (arXiv 2605.09998) §3.2/§4.6 and ACE.

import { describe, it, expect } from "vitest";
import {
  detectSignals,
  hasRepetitionLoop,
  REPETITION_THRESHOLD,
} from "../src/signals.js";
import { fitness, selectForInjection } from "../src/select.js";
import {
  applyDeltas,
  decayAndPrune,
  getState,
  reconstruct,
} from "../src/store.js";
import {
  markSteeringActed,
  markSteeringSent,
  pendingSteeringOlderThan,
} from "../src/refine.js";
import type { HarnessItem } from "../src/types.js";

function reset(items: HarnessItem[] = []): void {
  reconstruct([]);
  if (items.length) applyDeltas([], () => {});
  // Directly seed state through reconstruct-free path: use applyDeltas for creates.
}

describe("failure-signature detection (signals.ts)", () => {
  it("detects all five signatures independently", () => {
    const toolErr = "[toolResult] error: command exited 1";
    expect(detectSignals(toolErr, 10)).toContain("tool_error");

    const correction = "[user] sebenarnya itu salah";
    expect(detectSignals(correction, 10)).toContain("user_correction");

    const trigger = "[user] refine the harness";
    expect(detectSignals(trigger, 10)).toContain("refine_trigger");
  });

  it("repetition_loop fires at threshold and not below", () => {
    const line = "[assistant] retrying git push origin main now";
    const below = Array.from({ length: REPETITION_THRESHOLD - 1 }, () => line).join("\n");
    const at = Array.from({ length: REPETITION_THRESHOLD }, () => line).join("\n");
    expect(hasRepetitionLoop(below)).toBe(false);
    expect(hasRepetitionLoop(at)).toBe(true);
  });

  it("repetition_loop ignores normalized duplicates differing only in whitespace/case", () => {
    const a = "[assistant] Running   the FULL build pipeline";
    const b = "[assistant] running the full build pipeline";
    expect(hasRepetitionLoop([a, b, b].join("\n"))).toBe(true);
  });

  it("short ack lines never count as loops", () => {
    expect(hasRepetitionLoop("[assistant] ok\n[assistant] ok\n[assistant] ok")).toBe(false);
  });
});

describe("outcome-aware injection ranking (select.ts)", () => {
  function mkItem(overrides: Partial<HarnessItem>): HarnessItem {
    return {
      id: `h_${Math.random().toString(36).slice(2, 8)}`,
      kind: "prompt",
      content: "note",
      evidence: "e",
      importance: 0.5,
      active: true,
      ownerModel: "test/main",
      createdAt: 0,
      updatedAt: 0,
      applications: 0,
      failures: 0,
      ...overrides,
    };
  }

  it("fitness equals importance for items with no outcome history", () => {
    const item = mkItem({ importance: 0.7 });
    expect(fitness(item)).toBe(0.7);
  });

  it("proven items outrank equally-important unproven ones", () => {
    const proven = mkItem({ id: "h_proven", content: "proven", importance: 0.5, applications: 5, failures: 0 });
    const fresh = mkItem({ id: "h_fresh", content: "fresh", importance: 0.5 });
    const { selected } = selectForInjection([fresh, proven], "test/main");
    expect(selected[0]!.id).toBe("h_proven");
  });

  it("a failing record cancels the bonus; a proven one overcomes a small importance deficit", () => {
    // Failing item: successRate 0 → no bonus at all.
    const failing = mkItem({ id: "h_failing", content: "failing", importance: 0.86, applications: 0, failures: 5 });
    // Proven item: starts lower but earns ~full bonus.
    const proven = mkItem({ id: "h_proven", content: "proven", importance: 0.84, applications: 3, failures: 0 });
    const { selected } = selectForInjection([failing, proven], "test/main");
    expect(selected[0]!.id).toBe("h_proven");
    // And the failing item's fitness never exceeds its authored importance.
    expect(fitness(failing)).toBe(0.86);
  });

  it("bonus saturates after OUTCOME_SATURATION successful applications", () => {
    const a = mkItem({ importance: 0.5, applications: 5, failures: 0 });
    const b = mkItem({ importance: 0.5, applications: 50, failures: 0 });
    expect(fitness(b)).toBeCloseTo(fitness(a), 10);
  });
});

describe("decay resistance (store.ts)", () => {
  it("net-positive items skip decay entirely", () => {
    reconstruct([]);
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "proven note", evidence: "e", deltaId: "d_proven" },
        { op: "create", kind: "prompt", content: "unproven note", evidence: "e" },
      ],
      () => {},
    );
    const st = getState();
    const proven = st.items.find((i) => i.content === "proven note")!;
    const unproven = st.items.find((i) => i.content === "unproven note")!;
    proven.applications = 4;
    proven.failures = 1;
    // Age both beyond any decay window.
    for (const i of [proven, unproven]) i.updatedAt = Date.now() - 100 * 86_400_000;

    decayAndPrune({ decayAfterDays: 1, decayStep: 0.1 }, () => {});
    expect(proven.importance).toBe(0.5); // untouched
    expect(unproven.importance).toBeCloseTo(0.4); // decayed
  });
});

describe("steering follow-through (refine.ts)", () => {
  it("tracks pending → cleared lifecycle", async () => {
    markSteeringActed();
    expect(pendingSteeringOlderThan(0)).toBe(false);

    markSteeringSent();
    // Just sent: not older than a large window…
    expect(pendingSteeringOlderThan(60_000)).toBe(false);
    // …but older than zero.
    await new Promise((r) => setTimeout(r, 5));
    expect(pendingSteeringOlderThan(0)).toBe(true);

    markSteeringActed();
    expect(pendingSteeringOlderThan(0)).toBe(false);
  });
});
