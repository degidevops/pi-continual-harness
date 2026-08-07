// Pluggable delta proposers (Phase 4 of the roadmap).
//
// /refine is split into two stages:
//   1. PROPOSE — given trajectory evidence + current state, decide what deltas
//      to apply (or what to ask the agent to do).
//   2. APPLY   — either send a steering message (the agent reasons + calls
//      harness_mutate) or apply returned deltas directly.
//
// This file owns stage 1. The default `steeringProposer` preserves the
// original behavior exactly (delegates to the agent via a steering message,
// reusing the agent loop — model-agnostic, fully visible). Alternate proposers
// produce deltas directly:
//   - `dedupeProposer` (rule-based): drops near-duplicate active items by token
//     overlap, keeping the higher-importance one. Pure function of state —
//     deterministic, no model call, fully testable.
//
// A dedicated-model proposer (a hidden LLM call) is the obvious next alternate
// the interface supports, but is intentionally NOT shipped here: it is the one
// tradeoff (non-visible model spend) the roadmap flags as a separate decision.
//
// Extension is open: call registerProposer() from your own extension to add a
// named proposer, then select it via /refine --proposer <name> or config.

import type { Delta, HarnessItem, HarnessState } from "./types.js";

/** Inputs to a proposer. */
export interface ProposeInput {
  /** Recent trajectory evidence (the same string /refine gathers). */
  evidence: string;
  /** Current harness state (a snapshot; never mutated by the proposer). */
  state: HarnessState;
  /** Lookback window in turns. */
  lookback: number;
}

/** A single delta plus a human-readable reason for the audit trail. */
export interface ProposedDelta {
  delta: Delta;
  rationale: string;
}

export interface ProposeResult {
  /** Deltas the proposer produced directly (rule-based / model proposers). */
  deltas?: ProposedDelta[];
  /**
   * A steering message for the agent, when the proposer delegates reasoning to
   * the agent loop (the default). runRefine sends this via sendUserMessage.
   * A proposer MAY return both — deltas are applied first, then steering sent.
   */
  steeringMessage?: string;
}

/** A strategy for turning evidence + state into (or toward) harness deltas. */
export interface DeltaProposer {
  readonly name: string;
  propose(input: ProposeInput): Promise<ProposeResult>;
}

// ---- default: steering (delegates reasoning to the agent) ------------------

function buildSteeringPrompt(evidence: string, lookback: number): string {
  return [
    `/refine (online self-improvement, last ${lookback} turns as evidence)`,
    "",
    "Review the trajectory evidence below. Identify DURABLE, REUSABLE corrections — things that will help in future turns, not one-off fixes. Then update the Continual Harness state.",
    "",
    "Steps:",
    "1. Call harness_list to see the current state.",
    "2. Call harness_mutate with small, surgical CRUD deltas. Every create MUST include concrete evidence from the trajectory. Prefer updating existing items over creating duplicates; delete items that are wrong, stale, or contradicted.",
    "3. Keep prompt notes terse and behavioral. Memory facts should be specific. Skill/sub-agent entries should describe reusable patterns, not one task.",
    "",
    "Constraints: never rewrite the whole store; ground every change in evidence; if nothing durable is worth recording, say so and do nothing.",
    "",
    "## Trajectory evidence",
    evidence,
  ].join("\n");
}

/** Default proposer: delegates reasoning to the agent via a steering message. */
export const steeringProposer: DeltaProposer = {
  name: "steering",
  async propose({ evidence, lookback }): Promise<ProposeResult> {
    return { steeringMessage: buildSteeringPrompt(evidence, lookback) };
  },
};

// ---- rule-based alternate: dedupe -----------------------------------------

export const DEDUPE_THRESHOLD = 0.6;

/** Tokenize for overlap comparison: lowercase alnum tokens. */
export function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
}

/** Jaccard token overlap in [0,1]. 0 if either side has no tokens. */
export function tokenOverlap(a: string, b: string): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function truncate(s: string, n = 48): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/**
 * Rule-based proposer: drops near-duplicate ACTIVE items (same kind, Jaccard
 * token overlap >= DEDUPE_THRESHOLD), keeping the higher-importance one.
 *
 * Greedy and contradiction-free: items are considered in importance-descending
 * order; the first item is always a keeper, and each later item is compared
 * only against keepers, so a keeper is never subsequently dropped.
 */
export const dedupeProposer: DeltaProposer = {
  name: "dedupe",
  async propose({ state }): Promise<ProposeResult> {
    const ordered = state.items
      .filter((i) => i.active)
      .slice()
      .sort((a, b) => b.importance - a.importance);
    const keepers: HarnessItem[] = [];
    const proposals: ProposedDelta[] = [];
    for (const cand of ordered) {
      let dup: HarnessItem | undefined;
      let best = 0;
      for (const k of keepers) {
        if (k.kind !== cand.kind) continue;
        const sim = tokenOverlap(k.content, cand.content);
        if (sim >= DEDUPE_THRESHOLD && sim > best) {
          best = sim;
          dup = k;
        }
      }
      if (dup) {
        proposals.push({
          delta: {
            op: "delete",
            id: cand.id,
            reason: `near-duplicate of ${dup.id} (overlap ${best.toFixed(2)})`,
          },
          rationale: `dedupe: "${truncate(cand.content)}" ≈ keeper "${truncate(dup.content)}" (Jaccard ${best.toFixed(2)}); kept higher-importance ${dup.id}.`,
        });
      } else {
        keepers.push(cand);
      }
    }
    return proposals.length ? { deltas: proposals } : {};
  },
};

// ---- registry -------------------------------------------------------------

const registry = new Map<string, DeltaProposer>([
  ["steering", steeringProposer],
  ["dedupe", dedupeProposer],
]);

/** Register (or replace) a named proposer. For external extensions. */
export function registerProposer(p: DeltaProposer): void {
  registry.set(p.name, p);
}

/** Look up a proposer by name; falls back to the steering default. */
export function getProposer(name: string | undefined): DeltaProposer {
  return registry.get(name ?? "steering") ?? steeringProposer;
}

export function listProposers(): string[] {
  return [...registry.keys()];
}
