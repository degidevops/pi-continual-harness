// turn_end reminder (Phase 2 of the roadmap). Purely informational — it nudges
// the user to run /refine on a cadence; it never mutates state. Opt-in via
// harness.json { remindRefine: { enabled: true, everyTurns: 50 } }.
//
// The decision logic is factored into evaluateReminder() so it is unit-testable
// without a live pi runtime; registerReminder() is thin glue over pi.on.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DEFAULT_EVERY_TURNS, type HarnessConfig, loadConfig } from "./config.js";
import { markSteeringActed, pendingSteeringOlderThan } from "./refine.js";
import { isQuiet } from "./quiet.js";

// turnIndex of the last reminder (or the baseline we seeded from). -1 = unseen.
let lastTurn = -1;

/** Test hook: reset internal counter. */
export function resetReminder(): void {
  lastTurn = -1;
}

/**
 * Decide whether to remind this turn. Side-effectful: the first observed turn
 * seeds the baseline (no reminder then), and each fired reminder resets it.
 * Returns true when it is time to nudge.
 */
export function evaluateReminder(config: HarnessConfig, turnIndex: number): boolean {
  if (!config.remindRefine?.enabled) return false;
  const every = config.remindRefine.everyTurns ?? DEFAULT_EVERY_TURNS;
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

/** Subscribe to turn_end: (a) nudge once when a steering refine was never
 *  acted upon (informational — always on), and (b) the opt-in cadence reminder. */
export function registerReminder(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    // (a) Steering follow-through: a /refine handed reasoning to the agent but
    // no harness_mutate followed within 10 minutes → surface it once.
    if (pendingSteeringOlderThan(10 * 60_000)) {
      markSteeringActed();
      ctx.ui.notify(
        "A recent /refine sent a refinement request to the agent, but no harness_mutate followed. Run /refine again or ask the agent to apply the pending harness updates.",
        "warning",
      );
    }

    // (b) Cadence reminder (opt-in) — silenced under quiet mode; the steering
    // follow-through warning above intentionally still shows.
    const config = await loadConfig();
    if (!evaluateReminder(config, event.turnIndex)) return;
    if (await isQuiet()) return;
    const every = config.remindRefine?.everyTurns ?? DEFAULT_EVERY_TURNS;
    ctx.ui.notify(
      `${every} turns since the last check — consider running /refine to refine harness state.`,
      "info",
    );
  });
}
