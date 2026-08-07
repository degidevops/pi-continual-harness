// turn_end auto-refine (Phase 3 of the roadmap). This is the package's ONE
// autonomous-self-mutation path, so it is locked behind an explicit opt-in:
//
//   ~/.pi/agent/harness.json
//   { "autoRefine": { "enabled": true, "everyTurns": 100, "commit": false } }
//
// When enabled and the cadence elapses, it runs the SAME runRefine() routine as
// /refine — no parallel mutation logic — so it inherits all the safety
// properties: structured evidence-backed deltas, an audited REFINE_ENTRY
// (tagged source: "auto"), branch-local snapshots, and /tree rollback.
//
// It is also visible: it notifies before firing and the steering message
// appears in the transcript. The decision logic is factored into
// evaluateAutoRefine() so it is unit-testable without a live pi runtime.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AUTO_EVERY_TURNS, type HarnessConfig, loadConfig } from "./config.js";
import { runRefine } from "./refine.js";

// turnIndex of the last auto-refine (or the seeded baseline). -1 = unseen.
let lastTurn = -1;

/** Test hook: reset internal counter. */
export function resetAutoRefine(): void {
  lastTurn = -1;
}

/**
 * Decide whether to auto-refine this turn. Side-effectful: the first observed
 * turn seeds the baseline (no refine then); each fired refine resets it, which
 * also prevents the refine turn itself from immediately re-triggering.
 */
export function evaluateAutoRefine(config: HarnessConfig, turnIndex: number): boolean {
  if (!config.autoRefine?.enabled) return false;
  const every = config.autoRefine.everyTurns ?? DEFAULT_AUTO_EVERY_TURNS;
  if (every <= 0) return false;
  if (lastTurn < 0) {
    lastTurn = turnIndex;
    return false;
  }
  if (turnIndex - lastTurn >= every) {
    lastTurn = turnIndex;
    return true;
  }
  return false;
}

/** Subscribe to turn_end and run /refine on the configured cadence. */
export function registerAutoRefine(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    const config = await loadConfig();
    if (!evaluateAutoRefine(config, event.turnIndex)) return;
    const every = config.autoRefine?.everyTurns ?? DEFAULT_AUTO_EVERY_TURNS;
    ctx.ui.notify(`Auto-refine: running /refine (every ${every} turns, opt-in).`, "info");
    try {
      await runRefine(pi, ctx, { commit: config.autoRefine?.commit ?? false }, "auto");
    } catch (err) {
      ctx.ui.notify(`Auto-refine failed: ${(err as Error).message}`, "error");
    }
  });
}
