// /harness — durable I/O. The two-way round-trip seam with pi-reflect.
//
//   /harness status [path]               counts + durable file presence/mtime
//   /harness export [path]               write active items to a markdown file
//   /harness import [--prune] [path]     parse it back and merge (durable wins)
//
// export writes the active items to ~/.pi/agent/harness-state.md (best-effort);
// import parses that file and merges into the live store. Because pi-reflect
// edits markdown files and git-commits, pointing it at the same file closes the
// loop: offline refinement flows back into the online store.
//
// Manual only (no session_start auto-import): importing is an explicit,
// reviewable action, matching the package's "no autonomous mutation" stance.

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { stat } from "node:fs/promises";
import { DEFAULT_DURABLE_PATH, exportDurable, getState, reconstructFromDurable } from "./store.js";
import type { ComponentKind } from "./types.js";

export function registerHarness(pi: ExtensionAPI): void {
  pi.registerCommand("harness", {
    description:
      "Durable harness-state I/O (round-trip seam with pi-reflect). " +
      "Subcommands: import [--prune] [path] · export [path] · status [path].",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/).filter(Boolean);
      const sub = (parts[0] ?? "status").toLowerCase();
      const rest = parts.slice(1);
      switch (sub) {
        case "import":
          await handleImport(pi, ctx, rest);
          return;
        case "export":
          await handleExport(ctx, rest);
          return;
        case "status":
        default:
          await handleStatus(ctx, rest);
          return;
      }
    },
  });
}

function resolvePath(rest: string[]): string {
  return rest.find((a) => !a.startsWith("-")) ?? DEFAULT_DURABLE_PATH;
}

async function handleImport(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const prune = rest.includes("--prune");
  const path = resolvePath(rest);
  ctx.ui.setStatus("harness", `Importing durable state${prune ? " (prune)" : ""}…`);
  try {
    const res = await reconstructFromDurable(path, { prune }, (snapshot, ver) => {
      pi.appendEntry("harness-state", { state: snapshot, version: ver });
    });
    if (res.missingFile) {
      ctx.ui.notify(
        `No durable file at ${path}. Run /refine --commit or /harness export first.`,
        "warning",
      );
      return;
    }
    const bits = [`${res.created} created`, `${res.updated} updated`];
    if (prune) bits.push(`${res.pruned} pruned`);
    ctx.ui.notify(`Imported ${res.imported} item(s) from ${path} (${bits.join(", ")}).`, "info");
  } catch (err) {
    ctx.ui.notify(`Harness import failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

async function handleExport(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const path = resolvePath(rest);
  ctx.ui.setStatus("harness", "Exporting durable state…");
  try {
    const written = await exportDurable(path);
    const n = getState().items.filter((i) => i.active).length;
    ctx.ui.notify(`Exported ${n} active item(s) to ${written}`, "info");
  } catch (err) {
    ctx.ui.notify(`Harness export failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

async function handleStatus(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const path = resolvePath(rest);
  const items = getState().items;
  const active = items.filter((i) => i.active);
  const counts: Record<ComponentKind, number> = { prompt: 0, memory: 0, skill: 0, subagent: 0 };
  for (const i of active) counts[i.kind] += 1;
  let fileState: string;
  try {
    const st = await stat(path);
    fileState = `${path} (modified ${st.mtime.toISOString()})`;
  } catch {
    fileState = `none at ${path}`;
  }
  ctx.ui.setStatus("harness", undefined);
  ctx.ui.notify(
    `Harness: ${active.length} active / ${items.length} total — ` +
      `prompt ${counts.prompt}, memory ${counts.memory}, skill ${counts.skill}, subagent ${counts.subagent}. ` +
      `Durable: ${fileState}.`,
    "info",
  );
}
