// /refine — the online optimizer. Manual only (no turn_end auto-trigger).
//
// Flow:
//  1. Gather recent trajectory evidence from the current branch.
//  2. Send a steering user message that asks the agent to propose evidence-
//     backed CRUD deltas via harness_mutate (and to inspect state with
//     harness_list first).
//  3. The agent does the reasoning and calls the tools. Each accepted delta is
//     recorded as a session entry, so /tree gives rollback for free.
//
// Why a steering message instead of a nested LLM call: it reuses the existing
// agent loop, is model-agnostic, and keeps every delta visible and reviewable
// in the transcript. No hidden model calls.

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { exportDurable, REFINE_ENTRY } from "./store.js";

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
      "Online self-improvement: review recent trajectory and propose evidence-backed CRUD deltas to the harness state. Usage: /refine [lookback-turns] [--commit]",
    handler: async (args, ctx) => {
      const { lookback, commit } = parseArgs(args);
      await runRefine(pi, ctx, { lookback, commit });
    },
  });
}

export interface RefineOptions {
  lookback?: number;
  commit?: boolean;
}

export interface RefineResult {
  evidenceBytes: number;
  lookback: number;
  commit: boolean;
  source: "manual" | "auto";
}

/** Core refine routine shared by /refine (manual) and turn_end auto-refine.
 *  Gathers trajectory evidence, records an audit entry, optionally flushes the
 *  durable state, then sends the steering user message that drives the agent to
 *  propose evidence-backed CRUD deltas. `source` tags the audit entry so
 *  autonomous runs are distinguishable in the transcript. */
export async function runRefine(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  options: RefineOptions = {},
  source: "manual" | "auto" = "manual",
): Promise<RefineResult> {
  const lookback = options.lookback ?? DEFAULT_LOOKBACK_TURNS;
  const commit = options.commit ?? false;
  ctx.ui.setStatus("harness", `Refining (last ${lookback} turns)…`);
  const evidence = gatherEvidence(ctx, lookback);
  const prompt = buildSteeringPrompt(evidence, lookback);
  // Audit trail (branchable via /tree). `source` distinguishes manual /refine
  // from opt-in auto-refine so autonomous runs are visible in the transcript.
  pi.appendEntry(REFINE_ENTRY, { lookback, commit, startedAt: Date.now(), source });
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
  pi.sendUserMessage(prompt);
  ctx.ui.setStatus("harness", undefined);
  return { evidenceBytes: evidence.length, lookback, commit, source };
}

function parseArgs(args: string): { lookback: number; commit: boolean } {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  let lookback = DEFAULT_LOOKBACK_TURNS;
  let commit = false;
  for (const p of parts) {
    if (p === "--commit") commit = true;
    else if (/^\d+$/.test(p)) lookback = Math.max(1, Math.min(200, Number(p)));
  }
  return { lookback, commit };
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
