// /harness — durable I/O. The two-way round-trip seam with pi-reflect.
//
//   /harness status [path]               counts + durable file presence/mtime
//   /harness export [path]               write active items to a markdown file
//   /harness import [--prune] [path]     parse it back and merge (durable wins)
//   /harness run-subagent <id>           execute a subagent spec from harness
//   /harness run-skill <id>              execute an executable skill from harness
//   /harness cross-model <on|off>        enable/disable cross-model shared pool
//   /harness cross-model-optin           opt current model into shared pool
//   /harness cross-model-optout          opt current model out of shared pool
//   /harness promote <id>                promote item to shared pool
//   /harness demote <id>                 demote item from shared pool
//   /harness outcome <deltaId> <success|failure>  record outcome for delta
//   /harness promotion-candidates        list items eligible for promotion
//   /harness demotion-candidates         list items eligible for demotion
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
  modelKey,
  reconstructFromDurable,
  promoteToShared,
  demoteFromShared,
  setCrossModelEnabled,
  optIntoSharedPool,
  optOutOfSharedPool,
  recordOutcome,
  getPromotionCandidates,
  getDemotionCandidates,
} from "./store.js";
import { loadConfig, resolveDurablePath } from "./config.js";
import { executeSubagentSpec, maybeExecuteSkill, parseSubagentSpec } from "./orchestration.js";
import { trackSubagentRun } from "./subagent-tracking.js";
import type { ComponentKind, HarnessItem } from "./types.js";

export function registerHarness(pi: ExtensionAPI): void {
  pi.registerCommand("harness", {
    description:
      "Durable harness-state I/O + importance hygiene + orchestration + cross-model + outcomes. Subcommands: " +
      "import [--prune] [path] · export [path] · status [path] · " +
      "prune [--decay <days>] · keep <id> · drop <id> · " +
      "push-mem [--all|--kind <kind>|--model <provider/id|active>] · " +
      "run-subagent <id> · run-skill <id> · " +
      "cross-model <on|off> · cross-model-optin · cross-model-optout · " +
      "promote <id> · demote <id> · " +
      "outcome <deltaId> <success|failure> · " +
      "promotion-candidates · demotion-candidates",
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
        case "push-mem":
          await handlePushMem(pi, ctx, rest);
          return;
        case "run-subagent":
          await handleRunSubagent(pi, ctx, rest);
          return;
        case "run-skill":
          await handleRunSkill(ctx, rest);
          return;
        case "cross-model":
          await handleCrossModel(pi, ctx, rest);
          return;
        case "cross-model-optin":
          await handleCrossModelOptin(pi, ctx, rest);
          return;
        case "cross-model-optout":
          await handleCrossModelOptout(pi, ctx, rest);
          return;
        case "promote":
          await handlePromote(pi, ctx, rest);
          return;
        case "demote":
          await handleDemote(pi, ctx, rest);
          return;
        case "outcome":
          await handleOutcome(pi, ctx, rest);
          return;
        case "promotion-candidates":
          await handlePromotionCandidates(ctx, rest);
          return;
        case "demotion-candidates":
          await handleDemotionCandidates(ctx, rest);
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

/** Compose a steering message that asks the agent to persist the given active
 *  items to long-term memory via a memory tool (pi-mem's save_memory).
 *  Tool-agnostic: if no memory tool is present the agent says so; we never
 *  fabricate one. No dependency on pi-mem — soft-fail composition. */
function buildPushMemPrompt(items: HarnessItem[], scope: string): string {
  const lines = [
    `/harness push-mem — persist ${items.length} Continual Harness ${scope} to long-term memory`,
    "",
    "For EACH item below, call your memory tool (pi-mem exposes `save_memory`) once, mapping it as shown. This copies harness state into the semantic memory store so it is searchable across sessions.",
    "",
    "If you do NOT have a memory tool, do not fabricate one: tell the user to install pi-mem (`pi install npm:pi-mem`) and stop.",
    "",
  ];
  items.forEach((i, n) => {
    const title = `${i.id} ${i.content.slice(0, 48)}`;
    const text = `${i.content} (evidence: ${i.evidence})`;
    lines.push(
      `${n + 1}. [${i.id}] ${i.content}`,
      `   evidence: ${i.evidence}`,
      `   → save_memory({ title: ${JSON.stringify(title)}, text: ${JSON.stringify(text)}, concepts: ["${i.kind}", "continual-harness"] })`,
      "",
    );
  });
  return lines.join("\n");
}

async function handlePushMem(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const all = rest.includes("--all");
  const kindIdx = rest.indexOf("--kind");
  let kind: ComponentKind | undefined;
  if (kindIdx >= 0 && kindIdx + 1 < rest.length) {
    const k = rest[kindIdx + 1]!;
    if (k === "prompt" || k === "memory" || k === "skill" || k === "subagent") kind = k;
  }
  // --model scopes the push to one owner model (default: every model). "active"
  // resolves to the model driving this command, so you don't have to name it.
  const modelIdx = rest.indexOf("--model");
  let modelFilter: string | undefined;
  if (modelIdx >= 0 && modelIdx + 1 < rest.length) {
    const m = rest[modelIdx + 1]!;
    modelFilter = m === "active" ? (modelKey(ctx.model) ?? "") : m;
  }
  // Default: memory kind (the clean 1:1 mapping). --all or --kind override.
  const items = getState().items.filter(
    (i) =>
      i.active &&
      (all || (kind ? i.kind === kind : i.kind === "memory")) &&
      (modelFilter === undefined || i.ownerModel === modelFilter),
  );
  if (items.length === 0) {
    ctx.ui.notify(
      "No active items to push (default: memory kind; use --all, --kind <kind>, or --model <provider/id|active>).",
      "warning",
    );
    return;
  }
  const scope = all ? "item(s)" : `${kind ?? "memory"} item(s)`;
  const modelNote = modelFilter !== undefined ? ` [model ${modelFilter || "(orphan)"}]` : "";
  // deliverAs "steer" — safe when the user runs /harness push-mem mid-turn.
  const msg = buildPushMemPrompt(items, scope);
  pi.sendUserMessage(msg, { deliverAs: "steer" });
  ctx.ui.notify(`Steering agent to persist ${items.length} ${scope}${modelNote} to pi-mem.`, "info");
}

async function handleRunSubagent(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const id = rest.find((a) => a && !a.startsWith("-"));
  if (!id) {
    ctx.ui.notify(
      `"/harness run-subagent" requires an item id (see /harness status or harness_list).`,
      "warning",
    );
    return;
  }
  const item = getState().items.find((i) => i.id === id);
  if (!item) {
    ctx.ui.notify(`No harness item with id ${id}.`, "warning");
    return;
  }
  if (item.kind !== "subagent") {
    ctx.ui.notify(`Item ${id} is not a subagent (kind: ${item.kind}).`, "warning");
    return;
  }
  if (!item.active) {
    ctx.ui.notify(`Item ${id} is inactive.`, "warning");
    return;
  }

  // Check orchestration mode
  const config = await loadConfig();
  const orchestrationEnabled = config.orchestration?.enabled ?? true;
  if (!orchestrationEnabled) {
    ctx.ui.notify(`Orchestration is disabled in config.`, "warning");
    return;
  }

  const spec = parseSubagentSpec(item);
  if (!spec) {
    ctx.ui.notify(`Could not parse subagent spec from item ${id}.`, "warning");
    return;
  }

  ctx.ui.setStatus("harness", `Executing subagent ${id}…`);
  try {
    const result = await executeSubagentSpec(ctx, spec);
    // Track for outcome correlation at turn_end (subagent-tracking).
    trackSubagentRun(result.runId, item.id, item.deltaId);
    ctx.ui.notify(
      `Subagent ${id} started (run: ${result.runId}, agent: ${result.agent}).`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(`Subagent execution failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

async function handleRunSkill(
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const id = rest.find((a) => a && !a.startsWith("-"));
  if (!id) {
    ctx.ui.notify(
      `"/harness run-skill" requires an item id (see /harness status or harness_list).`,
      "warning",
    );
    return;
  }
  const item = getState().items.find((i) => i.id === id);
  if (!item) {
    ctx.ui.notify(`No harness item with id ${id}.`, "warning");
    return;
  }
  if (item.kind !== "skill") {
    ctx.ui.notify(`Item ${id} is not a skill (kind: ${item.kind}).`, "warning");
    return;
  }
  if (!item.active) {
    ctx.ui.notify(`Item ${id} is inactive.`, "warning");
    return;
  }

  // Check orchestration mode
  const config = await loadConfig();
  const orchestrationEnabled = config.orchestration?.enabled ?? true;
  if (!orchestrationEnabled) {
    ctx.ui.notify(`Orchestration is disabled in config.`, "warning");
    return;
  }

  ctx.ui.setStatus("harness", `Executing skill ${id}…`);
  try {
    const result = await maybeExecuteSkill(ctx, item);
    if (!result) {
      ctx.ui.notify(`Skill ${id} is not executable (no language/entryPoint in front-matter).`, "warning");
      return;
    }
    ctx.ui.notify(
      `Skill ${id} executed (exit: ${result.exitCode}): ${result.output.slice(0, 200)}${result.output.length > 200 ? "…" : ""}`,
      result.exitCode === 0 ? "info" : "error",
    );
    if (result.error) {
      ctx.ui.notify(`Error: ${result.error}`, "error");
    }
  } catch (err) {
    ctx.ui.notify(`Skill execution failed: ${(err as Error).message}`, "error");
  }
  ctx.ui.setStatus("harness", undefined);
}

// ---- Cross-model sharing commands (Phase 3 / B2) -------------------------

async function handleCrossModel(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const action = rest[0]?.toLowerCase();
  if (action !== "on" && action !== "off") {
    ctx.ui.notify(`Usage: /harness cross-model <on|off>`, "warning");
    return;
  }
  const enabled = action === "on";
  setCrossModelEnabled(enabled, (snapshot, ver) => {
    pi.appendEntry("harness-state", { state: snapshot, version: ver });
  });
  ctx.ui.notify(`Cross-model sharing ${enabled ? "enabled" : "disabled"}.`, "info");
}

async function handleCrossModelOptin(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  _rest: string[],
): Promise<void> {
  const key = modelKey(ctx.model);
  if (!key) {
    ctx.ui.notify("No active model to opt in.", "warning");
    return;
  }
  optIntoSharedPool(key, (snapshot, ver) => {
    pi.appendEntry("harness-state", { state: snapshot, version: ver });
  });
  ctx.ui.notify(`Model ${key} opted into shared pool.`, "info");
}

async function handleCrossModelOptout(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  _rest: string[],
): Promise<void> {
  const key = modelKey(ctx.model);
  if (!key) {
    ctx.ui.notify("No active model to opt out.", "warning");
    return;
  }
  optOutOfSharedPool(key, (snapshot, ver) => {
    pi.appendEntry("harness-state", { state: snapshot, version: ver });
  });
  ctx.ui.notify(`Model ${key} opted out of shared pool.`, "info");
}

async function handlePromote(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const id = rest.find((a) => a && !a.startsWith("-"));
  if (!id) {
    ctx.ui.notify(`"/harness promote" requires an item id.`, "warning");
    return;
  }
  const item = promoteToShared(id, (snapshot, ver) => {
    pi.appendEntry("harness-state", { state: snapshot, version: ver });
  });
  if (!item) {
    ctx.ui.notify(`No harness item with id ${id} or already shared.`, "warning");
    return;
  }
  ctx.ui.notify(`Item ${id} promoted to shared pool.`, "info");
}

async function handleDemote(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const id = rest.find((a) => a && !a.startsWith("-"));
  if (!id) {
    ctx.ui.notify(`"/harness demote" requires an item id.`, "warning");
    return;
  }
  const key = modelKey(ctx.model) ?? "";
  const item = demoteFromShared(id, key, (snapshot, ver) => {
    pi.appendEntry("harness-state", { state: snapshot, version: ver });
  });
  if (!item) {
    ctx.ui.notify(`No shared item with id ${id}.`, "warning");
    return;
  }
  ctx.ui.notify(`Item ${id} demoted to model ${key || "(orphan)"}.`, "info");
}

// ---- Outcome tracking commands (Phase 3 / B3) ----------------------------

async function handleOutcome(
  pi: ExtensionAPI,
  ctx: ExtensionCommandContext,
  rest: string[],
): Promise<void> {
  const deltaId = rest[0];
  const result = rest[1]?.toLowerCase();
  if (!deltaId || (result !== "success" && result !== "failure")) {
    ctx.ui.notify(`Usage: /harness outcome <deltaId> <success|failure>`, "warning");
    return;
  }
  // Get current turn index from session
  const entries = ctx.sessionManager.getBranch() as any[];
  const turnIndex = entries.filter((e) => e.type === "message" && e.message?.role === "assistant").length;

  recordOutcome(
    { deltaId, success: result === "success", turnIndex },
    (snapshot, ver) => {
      pi.appendEntry("harness-state", { state: snapshot, version: ver });
    },
  );
  ctx.ui.notify(`Outcome recorded for delta ${deltaId}: ${result}.`, "info");
}

async function handlePromotionCandidates(
  ctx: ExtensionCommandContext,
  _rest: string[],
): Promise<void> {
  const candidates = getPromotionCandidates();
  if (candidates.length === 0) {
    ctx.ui.notify("No promotion candidates found.", "info");
    return;
  }
  const lines = candidates.map(
    (i) => `[${i.id}] (importance ${i.importance.toFixed(2)}, apps: ${i.applications ?? 0}, fails: ${i.failures ?? 0}) ${i.content.slice(0, 80)}`,
  );
  ctx.ui.notify(`Promotion candidates:\n${lines.join("\n")}`, "info");
}

async function handleDemotionCandidates(
  ctx: ExtensionCommandContext,
  _rest: string[],
): Promise<void> {
  const candidates = getDemotionCandidates();
  if (candidates.length === 0) {
    ctx.ui.notify("No demotion candidates found.", "info");
    return;
  }
  const lines = candidates.map(
    (i) => `[${i.id}] (importance ${i.importance.toFixed(2)}, apps: ${i.applications ?? 0}, fails: ${i.failures ?? 0}, ratio: ${((i.failures ?? 0) / Math.max(1, i.applications ?? 1)).toFixed(2)}) ${i.content.slice(0, 80)}`,
  );
  ctx.ui.notify(`Demotion candidates:\n${lines.join("\n")}`, "warning");
}

async function handleStatus(ctx: ExtensionCommandContext, rest: string[]): Promise<void> {
  const path = await resolvePath(rest, ctx);
  const items = getState().items;
  const active = items.filter((i) => i.active);
  const key = modelKey(ctx.model);
  const models = [...new Set(active.map((i) => i.ownerModel).filter(Boolean))];
  const mine = key ? active.filter((i) => i.ownerModel === key).length : active.length;
  // Status is a whole-store view: kind counts span every model. Annotate with
  // the current model's share so the per-model picture is still visible.
  const counts: Record<ComponentKind, number> = { prompt: 0, memory: 0, skill: 0, subagent: 0 };
  for (const i of active) counts[i.kind] += 1;
  let fileState: string;
  try {
    const st = await stat(path);
    fileState = `${path} (modified ${st.mtime.toISOString()})`;
  } catch {
    fileState = `none at ${path}`;
  }
  const crossModel = getState().crossModel;
  const crossModelStatus = crossModel?.enabled
    ? `Cross-model: ON (${crossModel.optedInModels?.length ?? 0} opted in)`
    : "Cross-model: OFF";
  ctx.ui.setStatus("harness", undefined);
  ctx.ui.notify(
    `Harness: ${active.length} active / ${items.length} total — ` +
      `prompt ${counts.prompt}, memory ${counts.memory}, skill ${counts.skill}, subagent ${counts.subagent}.` +
      (key ? ` ${mine} active for [${key}] across ${models.length} model(s).` : "") +
      ` ${crossModelStatus}. Durable: ${fileState}.`,
    "info",
  );
}