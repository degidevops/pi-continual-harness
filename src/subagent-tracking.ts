// Sub-agent run tracking — closes the execution→outcome loop for sub-agents.
//
// The pi-subagents orchestrator is fire-and-forget: it hands the agent a
// steering message and returns "started". Without this module, sub-agent specs
// in the harness are evolution-blind (Continual Harness §3.2ii deletes
// sub-agent entries "that have not been invoked productively" — you need
// invocation outcomes to know that).
//
// How reconciliation works: each tracked run embeds a unique runId. At turn_end
// we scan recent branch entries for that id. The steering REQUEST itself also
// contains the id, so entries matching the request marker are skipped; only
// later tool-call/tool-result-shaped entries count as completion signals.
// Outcome heuristic per matched completion entry:
//   - isError:true or error/failed/exception wording → failure
//   - otherwise → success
// Runs unresolved for > RUN_TIMEOUT_MS are dropped (no fabricated outcomes).

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { recordOutcome } from "./store.js";

export const RUN_TIMEOUT_MS = 30 * 60_000;
/** How many trailing branch entries to scan for completions. */
const SCAN_DEPTH = 80;

interface PendingRun {
  runId: string;
  itemId: string;
  deltaId?: string;
  startedAt: number;
}

const pending = new Map<string, PendingRun>();

/** Register a launched sub-agent run for outcome correlation. */
export function trackSubagentRun(
  runId: string,
  itemId: string,
  deltaId?: string,
  startedAt = Date.now(),
): void {
  pending.set(runId, { runId, itemId, ...(deltaId ? { deltaId } : {}), startedAt });
}

export function pendingSubagentRuns(): number {
  return pending.size;
}

/** Test hook. */
export function resetSubagentRuns(): void {
  pending.clear();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

const REQUEST_MARKER = (runId: string) => `subagent:execute ${runId}`;

function classifyCompletion(raw: string): boolean | undefined {
  if (/["']?isError["']?\s*:\s*true/i.test(raw)) return false;
  if (/\b(error|failed|exception)\b[\w\s]{0,40}(\.|:|$|")/i.test(raw)) return false;
  return true;
}

/**
 * Scan the branch for completions of tracked sub-agent runs and record
 * outcomes against their items' deltas. Cheap: runs only when something is
 * pending, stringifies at most SCAN_DEPTH entries once.
 */
export function reconcileSubagentRuns(
  ctx: ExtensionContext,
  persist: (snapshot: unknown, version: number) => void,
): { resolved: number; successes: number; failures: number } {
  if (pending.size === 0) return { resolved: 0, successes: 0, failures: 0 };

  const entries = ctx.sessionManager.getBranch() as unknown[];
  const strings = entries.slice(-SCAN_DEPTH).map((e) => safeStringify(e));

  let resolved = 0;
  let successes = 0;
  let failures = 0;

  for (const [runId, run] of [...pending]) {
    let outcome: boolean | undefined;

    // Walk backwards so the LATEST mention wins over the steering request.
    for (let i = strings.length - 1; i >= 0; i--) {
      const raw = strings[i]!;
      if (!raw.includes(runId)) continue;
      // The steering request echoes the id too — it is not a completion.
      if (raw.includes(REQUEST_MARKER(runId)) && !raw.includes('"tool_call"') && !raw.includes("toolResult")) {
        continue;
      }
      outcome = classifyCompletion(raw);
      break;
    }

    if (outcome === undefined) {
      if (Date.now() - run.startedAt > RUN_TIMEOUT_MS) pending.delete(runId);
      continue;
    }

    pending.delete(runId);
    resolved += 1;
    if (outcome) successes += 1;
    else failures += 1;
    if (run.deltaId) {
      recordOutcome({ deltaId: run.deltaId, success: outcome, turnIndex: -1 }, persist as never);
    }
  }

  return { resolved, successes, failures };
}
