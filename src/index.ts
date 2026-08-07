// pi-continual-harness — online self-improvement layer for pi.
//
// Owns ONLY the online optimizer layer over a unified harness-state store.
// Composes with pi-reflect (offline refinement) and pi-mem (storage); does not
// reinvent either. Manual /refine only — no autonomous mutation.
//
// See README for design rationale and the research it is grounded in.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerHarness } from "./harness.js";
import { registerInjection } from "./inject.js";
import { registerRefine } from "./refine.js";
import { registerTools } from "./tools.js";
import { registerReminder } from "./remind.js";
import { registerAutoRefine } from "./auto-refine.js";
import { getState, reconstruct, STATE_ENTRY } from "./store.js";

export default function continualHarness(pi: ExtensionAPI): void {
  // Rebuild in-memory state from the current branch on every session start /
  // reload / resume / fork. This is what makes refinements branch-local and
  // rollback-able via /tree.
  pi.on("session_start", async (_event, ctx) => {
    reconstruct(ctx.sessionManager.getBranch() as Iterable<unknown>);
    const n = getState().items.length;
    if (n > 0) {
      ctx.ui.notify(`Continual Harness: ${n} item(s) restored`, "info");
    }
  });

  registerInjection(pi);
  registerTools(pi);
  registerRefine(pi);
  registerHarness(pi);
  registerReminder(pi);
  registerAutoRefine(pi);
}

export { STATE_ENTRY };
