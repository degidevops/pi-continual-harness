// Failure-signature detection over rendered trajectory evidence.
//
// Grounded in Continual Harness (arXiv 2605.09998 §3.2): the Refiner reads the
// recent trajectory window for FAILURE SIGNATURES and conditions every edit on
// them. The paper's embodied signatures (navigation loops, tool-call failures,
// stalled objectives) translate to coding agents as:
//
//   - tool_error        : tool results reporting errors
//   - user_correction   : explicit user pushback ("salah", "actually...", ...)
//   - repetition_loop   : near-identical assistant/tool lines repeated ≥3×
//                         (the navigation-loop analog: the agent retrying the
//                         same thing without progress)
//   - refine_trigger    : explicit request to update/refine the harness
//   - task_boundary     : sparse window after a long session (new task starting)
//
// Single source of truth: the signal-gate proposer, turn_end auto-refine, and
// any custom gate all read this one implementation. Pure + deterministic so it
// is fully unit-testable without a live pi runtime.

/** Correction patterns: what a user says when the agent got it wrong. */
export const CORRECTION_PATTERNS = [
  /\bsebenarnya\b/i,
  /\bsalah\b/i,
  /\bbukan begitu\b/i,
  /\bkurang\b/i,
  /\bharusnya\b/i,
  /\bbetulnya\b/i,
  /\bseharusnya\b/i,
  /\bjangan\b/i,
  // English equivalents, kept conservative to limit false positives.
  /\bsorry\b/i,
  /\bmy mistake\b/i,
  /\brevert\b/i,
  /\bthat'?s wrong\b/i,
];

const REFINE_TRIGGER_PATTERNS = [
  /\brefine\b/i,
  /\bperbaiki\b/i,
  /\bupdate harness\b/i,
  /\bharness.*update\b/i,
  /\bcatat\b/i,
  /\bingat\b/i,
];

/** Lines of evidence, tagged by role ("[user] ...", "[assistant] ...", ...). */
function linesByRole(evidence: string, role: string): string[] {
  const prefix = `[${role}]`;
  return evidence.split("\n").filter((l) => l.startsWith(prefix));
}

export function hasToolError(evidence: string): boolean {
  // gatherEvidence renders every message entry as "[<role>] text" — roles like
  // toolResult/tool_call all start with "[tool", so match the prefix family,
  // not just the literal "[tool]", or real errors are silently missed.
  return /\[tool\w*\][^\n]*\berror\b/i.test(evidence) ||
         /\[assistant\].*\btool[^\n]*error\b/i.test(evidence) ||
         /isError["']?\s*[:=]\s*["']?true/i.test(evidence);
}

export function hasUserCorrection(evidence: string): boolean {
  return linesByRole(evidence, "user").some((msg) =>
    CORRECTION_PATTERNS.some((p) => p.test(msg)),
  );
}

export function hasRefineTrigger(evidence: string): boolean {
  return linesByRole(evidence, "user").some((msg) =>
    REFINE_TRIGGER_PATTERNS.some((p) => p.test(msg)),
  );
}

export function hasTaskBoundary(evidence: string, lookback: number): boolean {
  const userLines = linesByRole(evidence, "user");
  if (userLines.length <= 1) return false;
  const totalEntries = evidence.split("\n").length;
  return totalEntries < lookback * 0.3;
}

/**
 * Repetition-loop detection: the same non-trivial line appearing ≥3 times in
 * the window means the agent is retrying something that keeps failing (the
 * coding-agent analog of a navigation loop). Lines are normalized (lowercase,
 * whitespace-collapsed, timestamps stripped) and trivially short ones ignored.
 */
export const REPETITION_THRESHOLD = 3;

export function hasRepetitionLoop(evidence: string): boolean {
  const counts = new Map<string, number>();
  for (const raw of evidence.split("\n")) {
    const line = raw.replace(/^\[[^\]]+\]\s*/, "").replace(/\s+/g, " ").trim().toLowerCase();
    if (line.length < 15) continue; // greetings/acks are not loops
    const n = (counts.get(line) ?? 0) + 1;
    counts.set(line, n);
    if (n >= REPETITION_THRESHOLD) return true;
  }
  return false;
}

/** All failure signatures present in the evidence window, in stable order.
 *  Refine-echo lines (prior steering prompts, prior no-op replies) are stripped
 *  FIRST: otherwise the gate re-triggers on its own output forever — the words
 *  "refine", "catat", "harness" appear in every echo, and each cycle's output
 *  becomes the next cycle's "signal". */
const ECHO_LINE_RE = /\/refine \(online self-improvement|^\[assistant\] \*\*No-op\*\*/i;

export function stripEchoLines(evidence: string): string {
  return evidence
    .split("\n")
    .filter((l) => !ECHO_LINE_RE.test(l))
    .join("\n");
}

export function detectSignals(rawEvidence: string, lookback: number): string[] {
  const evidence = stripEchoLines(rawEvidence);
  const signals: string[] = [];
  if (hasToolError(evidence)) signals.push("tool_error");
  if (hasUserCorrection(evidence)) signals.push("user_correction");
  if (hasRepetitionLoop(evidence)) signals.push("repetition_loop");
  if (hasRefineTrigger(evidence)) signals.push("refine_trigger");
  if (hasTaskBoundary(evidence, lookback)) signals.push("task_boundary");
  return signals;
}
