// /refine — the online optimizer. Manual by default; opt-in turn_end
// auto-refine lives in auto-refine.ts and reuses runRefine().
//
// Flow:
//  1. Gather recent trajectory evidence from the current branch.
//  2. Hand evidence + current state to a pluggable DeltaProposer (proposer.ts).
//     The default `steering` proposer returns a steering user message; the
//     agent then reasons and calls harness_mutate. Rule-based/model proposers
//     return deltas directly, which runRefine applies itself.
//  3. Every mutation — whether from the agent (harness_mutate) or a direct-apply
//     proposer — is recorded as a session entry, so /tree gives rollback for
//     free. Which proposer ran is captured in the audit entry.
//
// Why a steering message as the DEFAULT instead of a nested LLM call: it reuses
// the existing agent loop, is model-agnostic, and keeps every delta visible and
// reviewable in the transcript. Alternate proposers can opt out via the
// registry; the dedicated-model variant is intentionally not shipped (hidden
// model spend is a tradeoff the roadmap keeps as a separate decision).

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyDeltas, exportDurable, getState, REFINE_ENTRY } from "./store.js";
import { getProposer } from "./proposer.js";

const DEFAULT_EVIDENCE_BYTES = 16000;
export const DEFAULT_LOOKBACK_TURNS = 25;

// Minimal entry shape for trajectory walking; kept loose to avoid coupling to
// pi's internal session entry types.
type AnyEntry = {
  type?: string;
  customType?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string }>;
  };
};

export function registerRefine(pi: ExtensionAPI): void {
  pi.registerCommand("refine", {
    description:
      "Online self-improvement: review recent trajectory and propose evidence-backed CRUD deltas to the harness state. Usage: /refine [lookback-turns] [--commit] [--proposer steering|dedupe]",
    handler: async (args, ctx) => {
      const { lookback, commit, proposer } = parseArgs(args);
      await runRefine(pi, ctx, { lookback, commit, ...(proposer ? { proposer } : {}) });
    },
  });
}

export interface RefineOptions {
  lookback?: number;
  commit?: boolean;
  /** Proposer name (see proposer.ts registry). Defaults to "steering". */
  proposer?: string;
}

export interface RefineResult {
  evidenceBytes: number;
  lookback: number;
  commit: boolean;
  source: "manual" | "auto";
  /** Which proposer ran. */
  proposer: string;
  /** Deltas the proposer applied directly (0 for the steering path). */
  applied: number;
}

/**
 * Core refine routine shared by /refine (manual) and turn_end auto-refine.
 * Resolves a proposer, gathers evidence, lets the proposer decide what to do,
 * then either applies returned deltas directly or sends a steering message.
 * `source` tags the audit entry so autonomous runs are distinguishable.
 */
export async function runRefine(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: RefineOptions = {},
  source: "manual" | "auto" = "manual",
): Promise<RefineResult> {
  const lookback = options.lookback ?? DEFAULT_LOOKBACK_TURNS;
  const commit = options.commit ?? false;
  const proposer = getProposer(options.proposer);
  ctx.ui.setStatus("harness", `Refining (last ${lookback} turns)… [${proposer.name}]`);

  const evidence = gatherEvidence(ctx, lookback);
  const result = await proposer.propose({ evidence, state: getState(), lookback });
  const proposedDeltas = result.deltas ?? [];

  let applied = 0;
  if (proposedDeltas.length > 0) {
    // Direct-apply path (rule-based / model proposers): persist each batch the
    // same way harness_mutate does, so /tree rollback covers these too.
    const appliedDeltas = applyDeltas(
      proposedDeltas.map((d) => d.delta),
      (snapshot, ver) => pi.appendEntry("harness-state", { state: snapshot, version: ver }),
    );
    applied = appliedDeltas.length;
    ctx.ui.notify(`Proposer "${proposer.name}" applied ${applied} delta(s) directly.`, "info");
  }

  // Audit trail (branchable via /tree). `source` distinguishes manual /refine
  // from opt-in auto-refine; `proposer` records WHICH strategy ran; the
  // rationales make rule-based decisions visible in the transcript.
  pi.appendEntry(REFINE_ENTRY, {
    lookback,
    commit,
    startedAt: Date.now(),
    source,
    proposer: proposer.name,
    applied,
    rationales: proposedDeltas.map((d) => d.rationale),
  });

  if (commit) {
    // Flush current state to the durable file first so the agent refines
    // against the same view pi-reflect / pi-mem would see.
    try {
      const path = await exportDurable();
      ctx.ui.notify(`Durable state exported to ${path}`, "info");
    } catch (err) {
      ctx.ui.notify(`Durable export failed: ${(err as Error).message}`, "warning");
    }
  }

  if (result.steeringMessage) {
    pi.sendUserMessage(result.steeringMessage);
  }
  ctx.ui.setStatus("harness", undefined);
  return {
    evidenceBytes: evidence.length,
    lookback,
    commit,
    source,
    proposer: proposer.name,
    applied,
  };
}

function parseArgs(args: string): {
  lookback: number;
  commit: boolean;
  proposer: string | undefined;
} {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let lookback = DEFAULT_LOOKBACK_TURNS;
  let commit = false;
  let proposer: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p === "--commit") commit = true;
    else if (p === "--proposer" && i + 1 < parts.length) proposer = parts[++i];
    else if (p.startsWith("--proposer=")) proposer = p.slice("--proposer=".length);
    else if (/^\d+$/.test(p)) lookback = Math.max(1, Math.min(200, Number(p)));
  }
  return { lookback, commit, proposer };
}

function gatherEvidence(ctx: ExtensionContext, lookback: number): string {
  const entries = ctx.sessionManager.getBranch() as AnyEntry[];
  const messages = entries.filter((e) => e.type === "message" && e.message);
  const recent = messages.slice(-lookback * 2); // ~2 entries per turn (user+assistant)
  const lines: string[] = [];
  let bytes = 0;
  for (const e of recent) {
    const role = e.message?.role ?? "?";
    const text = (e.message?.content ?? [])
      .map((c) => c.text ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (!text) continue;
    const line = `[${role}] ${text}`;
    if (bytes + line.length > DEFAULT_EVIDENCE_BYTES) {
      lines.push("[…truncated…]");
      break;
    }
    lines.push(line);
    bytes += line.length;
  }
  return lines.join("\n") || "(no recent trajectory evidence found)";
}
