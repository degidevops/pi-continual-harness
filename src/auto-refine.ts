// turn_end auto-refine (Phase 3 of the roadmap). This is the package's ONE
// autonomous-self-mutation path, so it is locked behind an explicit opt-in:
//
//   ~/.pi/agent/harness.json
//   { "autoRefine": { "enabled": true, "everyTurns": 1, "commit": false } }
//
// When enabled and the cadence elapses, it runs a TWO-STAGE gate approach (A2):
//   1. GATE: Detect failure signatures in the recent window (tool errors,
//      user corrections, repetition loops, explicit refine requests, task
//      boundaries). This is CHEAP — pure detection, no model call.
//   2. ESCALATE: Only if signatures are detected, run the actual refine with
//      the configured proposer (default: `steering` — and the signal-gate
//      steering prompt names the signatures so the refine targets them).
//
// This avoids the noise of running the expensive steering proposer on every
// low-signal turn, while still being genuinely online/reset-free (every turn
// is evaluated, not just periodic cadence).
//
// It inherits all the safety properties: structured evidence-backed deltas,
// an audited REFINE_ENTRY (tagged source: "auto"), branch-local snapshots,
// and /tree rollback.
//
// It is also visible: it notifies before firing and the steering message
// appears in the transcript. The decision logic is factored into
// evaluateAutoRefine() so it is unit-testable without a live pi runtime.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_AUTO_EVERY_TURNS, type HarnessConfig, loadConfig } from "./config.js";
import { DEFAULT_LOOKBACK_TURNS, runRefine } from "./refine.js";
import { detectSignals } from "./signals.js";

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

/**
 * Run the failure-signature gate (Continual Harness §3.2) to detect if this
 * turn's window is worth a full refine. Pure detection — no proposer call,
 * no state snapshot. Returns detected signatures ([] = skip refine).
 */
function runSignalGate(ctx: ExtensionContext, lookback: number): string[] {
  const entries = ctx.sessionManager.getBranch() as any[];
  const messages = entries.filter((e) => e.type === "message" && e.message);
  
  // Build evidence same as gatherEvidence but simpler - just for signal detection
  const evidenceLines: string[] = [];
  for (const e of messages.slice(-lookback * 2)) {
    const role = e.message?.role ?? "?";
    const text = (e.message?.content ?? [])
      .map((c: { text?: string }) => c.text ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    evidenceLines.push(`[${role}] ${text}`);
  }
  return detectSignals(evidenceLines.join("\n"), lookback);
}

/** Subscribe to turn_end and run two-stage auto-refine on the configured cadence. */
export function registerAutoRefine(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    const config = await loadConfig();
    if (!evaluateAutoRefine(config, event.turnIndex)) return;
    
    const lookback = DEFAULT_LOOKBACK_TURNS;
    
    // STAGE 1: GATE - detect failure signatures in the recent window
    const signals = runSignalGate(ctx, lookback);
    
    if (signals.length === 0) {
      // No signals detected - skip expensive refine, but log for visibility
      ctx.ui.setStatus("harness", `Auto-refine gate: no signals, skipping refine`);
      // Clear status after a moment
      setTimeout(() => ctx.ui.setStatus("harness", undefined), 2000);
      return;
    }
    
    // STAGE 2: ESCALATE - signals detected, run full refine
    ctx.ui.notify(`Auto-refine gate: signals detected [${signals.join(", ")}] — running refine`, "info");
    
    try {
      await runRefine(
        pi,
        ctx,
        { 
          lookback,
          commit: config.autoRefine?.commit ?? false, 
          ...(config.escalateProposer ? { proposer: config.escalateProposer } : {}) 
        },
        "auto",
      );
    } catch (err) {
      ctx.ui.notify(`Auto-refine failed: ${(err as Error).message}`, "error");
    }
  });
}