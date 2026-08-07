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
import {
  bumpImportance,
  decayAndPrune,
  exportDurable,
  getState,
  reconstructFromDurable,
} from "./store.js";
import { loadConfig, resolveDurablePath } from "./config.js";
import type { ComponentKind } from "./types.js";

export function registerHarness(pi: ExtensionAPI): void {
  pi.registerCommand("harness", {
    description:
      "Durable harness-state I/O + importance hygiene. Subcommands: " +
      "import [--prune] [path] · export [path] · status [path] · " +
      "prune [--decay <days>] · keep <id> · drop <id>.",
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
        case "prune":
          await handlePrune(pi, ctx, rest);
          return;
        case "keep":
          await handleBump(pi, ctx, rest, 0.1, "keep");
          return;
        case "drop":
          await handleBump(pi, ctx, rest, -0.1, "drop");
          return;
        case "status":
        default:
          await handleStatus(ctx, rest);
          return;
      }
    },
  });
}

async function resolvePath(rest: string[], ctx: ExtensionCommandContext): Promise<string> {
  const explicit = rest.find((a) => !a.startsWith("-"));
  if (explicit) return explicit;
  const config = await loadConfig();
  return resolveDurablePath(config, ctx.cwd);
}

async function handleImport(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const prune = rest.includes("--prune");
  const path = await resolvePath(rest, ctx);
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
  const path = await resolvePath(rest, ctx);
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

async function handlePrune(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  let decayAfterDays: number | undefined;
  const idx = rest.indexOf("--decay");
  if (idx >= 0) {
    const n = Number(rest[idx + 1]);
    decayAfterDays = Number.isFinite(n) && n > 0 ? n : undefined;
  }
  ctx.ui.setStatus("harness", "Pruning…");
  try {
    const options: { decayAfterDays?: number; decayStep?: number } = { decayStep: 0.1 };
    if (decayAfterDays !== undefined) options.decayAfterDays = decayAfterDays;
    const res = decayAndPrune(options, (snapshot, ver) => {
      pi.appendEntry("harness-state", { state: snapshot, version: ver });
    });
    const bits = [`${res.pruned} pruned`];
    if (decayAfterDays !== undefined) bits.push(`${res.decayed} decayed (>${decayAfterDays}d)`);
    ctx.ui.notify(`Harness: ${bits.join(", ")}.`, "info");
  } catch (err) {
    ctx.ui.notify(`Harness prune failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

async function handleBump(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
  delta: number,
  label: string,
): Promise<void> {
  const id = rest.find((a) => a && !a.startsWith("-"));
  if (!id) {
    ctx.ui.notify(
      `/harness ${label} requires an item id (see /harness status or harness_list).`,
      "warning",
    );
    return;
  }
  const item = bumpImportance(id, delta, (snapshot, ver) => {
    pi.appendEntry("harness-state", { state: snapshot, version: ver });
  });
  if (!item) {
    ctx.ui.notify(`No harness item with id ${id}.`, "warning");
    return;
  }
  const preview = item.content.length > 60 ? `${item.content.slice(0, 60)}…` : item.content;
  ctx.ui.notify(`${label}: "${preview}" → importance ${item.importance.toFixed(2)}`, "info");
}

async function handleStatus(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const path = await resolvePath(rest, ctx);
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
