// turn_end auto-refine (Phase 3 of the roadmap). This is the package's ONE
// autonomous-self-mutation path, so it is locked behind an explicit opt-in:
//
//   ~/.pi/agent/harness.json
//   { "autoRefine": { "enabled": true, "everyTurns": 1, "commit": false } }
//
// When enabled and the cadence elapses, it runs a TWO-STAGE gate approach (A2):
//   1. GATE: Run the rule-based `signal` proposer on every turn to detect
//      HIGH-SIGNAL turns (tool errors, user corrections, task boundaries,
//      explicit refine requests). This is CHEAP — no model call.
//   2. ESCALATE: Only if the gate detects signals, run the actual refine
//      with the configured proposer (default: `signal` which applies the
//      signal note directly, or `steering` for full agent reasoning).
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
import { runRefine } from "./refine.js";
import { signalProposer, type ProposeInput } from "./proposer.js";
import { snapshotState } from "./store.js";

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
 * Run the signal proposer as a cheap gate to detect if this turn has
 * high-signal events worth a full refine. Returns the detected signals
 * (empty array = no signals, skip refine).
 */
async function runSignalGate(ctx: ExtensionContext, lookback: number): Promise<string[]> {
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
  const evidence = evidenceLines.join("\n");
  
  const input: ProposeInput = {
    evidence,
    state: snapshotState(),
    lookback,
  };
  
  const result = await signalProposer.propose(input);
  if (!result.deltas || result.deltas.length === 0) {
    return [];
  }
  
  // Extract signals from the rationale (deltas is non-empty here)
  const firstDelta = result.deltas[0]!;
  const rationale = firstDelta.rationale ?? "";
  const match = rationale.match(/signal gate: (.+) triggered refine/);
  if (match && match[1]) {
    return match[1].split(", ").map(s => s.trim());
  }
  return ["signal_detected"];
}

/** Subscribe to turn_end and run two-stage auto-refine on the configured cadence. */
export function registerAutoRefine(pi: ExtensionAPI): void {
  pi.on("turn_end", async (event, ctx) => {
    const config = await loadConfig();
    if (!evaluateAutoRefine(config, event.turnIndex)) return;
    
    const every = config.autoRefine?.everyTurns ?? DEFAULT_AUTO_EVERY_TURNS;
    const lookback = config.autoRefine?.everyTurns === 1 ? 25 : 25; // default lookback
    
    // STAGE 1: GATE - run signal proposer to detect high-signal turns
    const signals = await runSignalGate(ctx, lookback);
    
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
          ...(config.proposer ? { proposer: config.proposer } : {}) 
        },
        "auto",
      );
    } catch (err) {
      ctx.ui.notify(`Auto-refine failed: ${(err as Error).message}`, "error");
    }
  });
}