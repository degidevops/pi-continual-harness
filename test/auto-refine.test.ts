import { describe, it, expect, beforeEach } from "vitest";
import { evaluateAutoRefine, resetAutoRefine } from "../src/auto-refine.js";
import type { HarnessConfig } from "../src/config.js";

const cfg = (over: Partial<HarnessConfig> = {}): HarnessConfig => ({
  durableScope: "global",
  autoRefine: { enabled: true, everyTurns: 10 },
  ...over,
});

describe("evaluateAutoRefine", () => {
  beforeEach(resetAutoRefine);

  it("never fires when disabled (the default)", () => {
    const disabled = cfg({ autoRefine: { enabled: false, everyTurns: 10 } });
    for (let i = 0; i < 60; i++) {
      expect(evaluateAutoRefine(disabled, i)).toBe(false);
    }
  });

  it("seeds a baseline, then fires exactly every N turns", () => {
    const enabled = cfg({ autoRefine: { enabled: true, everyTurns: 10 } });
    expect(evaluateAutoRefine(enabled, 0)).toBe(false); // seed baseline at 0
    expect(evaluateAutoRefine(enabled, 9)).toBe(false);
    expect(evaluateAutoRefine(enabled, 10)).toBe(true); // first fire
    expect(evaluateAutoRefine(enabled, 11)).toBe(false);
    expect(evaluateAutoRefine(enabled, 19)).toBe(false);
    expect(evaluateAutoRefine(enabled, 20)).toBe(true); // second fire, cadence resets
  });

  it("never fires when everyTurns <= 0", () => {
    const zero = cfg({ autoRefine: { enabled: true, everyTurns: 0 } });
    expect(evaluateAutoRefine(zero, 0)).toBe(false);
    expect(evaluateAutoRefine(zero, 10000)).toBe(false);
  });

  it("falls back to the default cadence (1) when everyTurns is absent", () => {
    const noEvery = cfg({ autoRefine: { enabled: true } });
    expect(evaluateAutoRefine(noEvery, 0)).toBe(false); // seed baseline at turn 0
    expect(evaluateAutoRefine(noEvery, 1)).toBe(true); // fires on turn 1 (everyTurns=1)
    expect(evaluateAutoRefine(noEvery, 2)).toBe(true); // fires every turn
  });
});
