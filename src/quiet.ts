// Quiet-mode helper: the harness works in the background without disturbing
// the session. Informational messages from AUTONOMOUS paths are demoted to
// audited session entries (invisible in chat, recoverable in the transcript);
// warnings/errors and everything the USER explicitly invoked still surface.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";

/** True when harness.json sets { "quiet": true }. */
export async function isQuiet(): Promise<boolean> {
  return (await loadConfig()).quiet === true;
}

/**
 * Surface a message unless quiet mode swallows it:
 *   - level "info"   → shown normally; under quiet, demoted to an audited
 *                      `harness-event` session entry (no chat disturbance).
 *   - "warning"/"error" → ALWAYS shown, quiet or not (real problems matter).
 */
export async function notifyOrAudit(
  pi: ExtensionAPI,
  ctx: { ui: { notify: (message: string, level?: "info" | "warning" | "error") => void } },
  msg: string,
  level: "info" | "warning" | "error" = "info",
): Promise<void> {
  if (level !== "info" || !(await isQuiet())) {
    ctx.ui.notify(msg, level);
    return;
  }
  pi.appendEntry("harness-event", { msg, level });
}
