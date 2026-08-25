// Model-facing tools. Two tools, kept lean for prompt economy:
//  - harness_list:  read items (optionally by kind).
//  - harness_mutate: apply a batch of structured CRUD deltas.
//
// Deltas — not prose rewrites — are the unit of self-improvement (ACE).
// Each create requires `evidence`, so the model must ground every addition.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { applyDeltas, getActiveModelKey, getState, listItems, trackAppliedDeltas, recordOutcome } from "./store.js";
import { evaluateRegressionGuard } from "./regression-guard.js";
import { markSteeringActed } from "./refine.js";
import { executeSubagentSpec, maybeExecuteSkill, parseSubagentSpec, registerDefaultOrchestrator } from "./orchestration.js";
import { trackSubagentRun } from "./subagent-tracking.js";
import { loadConfig } from "./config.js";
import type { AppliedDelta, ComponentKind, Delta } from "./types.js";

const KIND_VALUES = ["prompt", "memory", "skill", "subagent"] as const;

const CreateShape = Type.Object({
  op: Type.Literal("create"),
  kind: StringEnum(KIND_VALUES),
  content: Type.String({ description: "The note/fact/description/spec text." }),
  evidence: Type.String({
    description: "Why this belongs in the harness state, grounded in trajectory evidence.",
  }),
  importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  // ownerModel is intentionally NOT exposed to the model: it is stamped
  // server-side from the active model so items bind to the model driving the
  // turn without the agent having to (or being able to) name it.
});

const UpdateShape = Type.Object({
  op: Type.Literal("update"),
  id: Type.String({ description: "Existing item id, e.g. h_..." }),
  content: Type.Optional(Type.String()),
  evidence: Type.Optional(Type.String()),
  importance: Type.Optional(Type.Number({ minimum: 0, maximum: 1 })),
  active: Type.Optional(Type.Boolean()),
});

const DeleteShape = Type.Object({
  op: Type.Literal("delete"),
  id: Type.String(),
  reason: Type.String({ description: "Why this item is being removed." }),
});

const DeltaShape = Type.Union([CreateShape, UpdateShape, DeleteShape]);

export function registerTools(pi: ExtensionAPI): void {
  // Register default orchestrator (pi-subagents) on load
  registerDefaultOrchestrator(pi);
  pi.registerTool({
    name: "harness_list",
    label: "List harness state",
    description:
      "List items in the Continual Harness state (self-improved prompt notes, memory, skill descriptions, sub-agent specs). Optionally filter by kind.",
    promptSnippet: "Read Continual Harness self-improvement state",
    promptGuidelines: [
      "Call harness_list before proposing changes so you operate on current state.",
    ],
    parameters: Type.Object({
      kind: Type.Optional(StringEnum(KIND_VALUES)),
      model: Type.Optional(
        Type.String({
          description:
            "Filter by owner model as provider/id. Omit = the active model items; use * for all models.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const kind = params.kind as ComponentKind | undefined;
      const modelFilter = params.model as string | undefined;
      // Default scope = the active model's items (what gets injected this turn).
      // "*" = every model; an explicit id = that model. When no active model is
      // known (no turn started) and no filter is given, return all so the agent
      // is never silently shown an empty store during setup.
      const ownerKey =
        modelFilter === "*"
          ? undefined
          : modelFilter ?? getActiveModelKey();
      let items = listItems(kind);
      if (ownerKey !== undefined) items = items.filter((i) => i.ownerModel === ownerKey);
      return {
        content: [
          {
            type: "text",
            text:
              items.length === 0
                ? "Harness state is empty."
                : items
                    .map(
                      (i) =>
                        `[${i.id}] (${i.kind}, importance ${i.importance.toFixed(2)}, ${i.active ? "active" : "inactive"}, model ${i.ownerModel || "(orphan)"}) ${i.content}\n  evidence: ${i.evidence}`,
                    )
                    .join("\n"),
          },
        ],
        details: { count: items.length, items },
      };
    },
  });

  pi.registerTool({
    name: "harness_mutate",
    label: "Mutate harness state",
    description:
      "Apply a batch of structured CRUD deltas to the Continual Harness state. Each create requires evidence grounded in trajectory. Prefer many small surgical deltas over wholesale rewrites.",
    promptSnippet: "Propose evidence-backed CRUD deltas to self-improvement state",
    promptGuidelines: [
      "Use harness_mutate during /refine or when you notice a durable, reusable correction. Ground every create in evidence. Prefer small surgical deltas.",
    ],
    parameters: Type.Object({
      deltas: Type.Array(DeltaShape, { minItems: 1, maxItems: 20 }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const incoming = params.deltas as Delta[];
      // Regression guard (HCL): model-authored batches may not delete proven
      // items or mass-delete — that is how harness-level forgetting happens.
      const guard = evaluateRegressionGuard(incoming, getState().items);
      if (!guard.ok) {
        return {
          content: [{ type: "text", text: `Batch rejected by regression guard:\n${guard.violations.map((v) => `- ${v}`).join("\n")}` }],
          details: { applied: [], itemCount: getState().items.length, orchestration: [], rejectedByGuard: true },
        };
      }
      const applied: AppliedDelta[] = applyDeltas(
        incoming,
        (snapshot, ver) => {
          pi.appendEntry("harness-state", { state: snapshot, version: ver });
        },
        getActiveModelKey(),
      );
      // The agent acted on a refinement — clear the pending-steering nudge.
      markSteeringActed();

      // Track applied delta IDs for automatic outcome evaluation (B3)
      const appliedDeltaIds = applied
        .filter((a) => a.op === "create" || a.op === "update")
        .map((a) => (a.op === "create" ? a.item : a.after)?.deltaId)
        .filter((id): id is string => Boolean(id));
      if (appliedDeltaIds.length > 0) {
        trackAppliedDeltas(appliedDeltaIds);
      }

      // Orchestration mode: "confirm" (default) vs "yolo".
      //  - confirm: items are STORED but never executed here. Execution happens
      //    only via the explicit user-invoked /harness run-skill|run-subagent
      //    commands — the user command IS the confirmation. No fake hashing,
      //    no silent auto-approval.
      //  - yolo: newly active subagent/skill items execute immediately.
      const config = await loadConfig();
      const orchestrationEnabled = config.orchestration?.enabled ?? true;
      const orchestrationMode = config.orchestration?.mode ?? "confirm";

      const orchestrationResults: Array<{ itemId: string; kind: ComponentKind; result: unknown }> = [];
      let pendingCount = 0;
      for (const delta of applied) {
        if (delta.op !== "create" && delta.op !== "update") continue;
        const item = delta.op === "create" ? delta.item : delta.after;
        if (!item || !item.active) continue;
        if (!orchestrationEnabled) continue;

        if (item.kind !== "subagent" && item.kind !== "skill") continue;
        if (orchestrationMode !== "yolo") {
          pendingCount += 1;
          continue;
        }
        try {
          if (item.kind === "subagent") {
            const spec = parseSubagentSpec(item);
            if (spec) {
              const result = await executeSubagentSpec(ctx, spec);
              // Track for outcome correlation at turn_end (subagent-tracking).
              trackSubagentRun(result.runId, item.id, item.deltaId);
              orchestrationResults.push({ itemId: item.id, kind: "subagent", result });
            }
          } else {
            const result = await maybeExecuteSkill(ctx, item);
            if (result) {
              orchestrationResults.push({ itemId: item.id, kind: "skill", result });
              // Close the execution→outcome loop (Continual Harness §4.6):
              // a skill that raised exceptions is recorded as a failure against
              // the item's delta so the B3 fitness loop can demote/flag it for
              // repair — exactly how the paper repairs skills that errored.
              const ok = result.exitCode === 0 && !result.error;
              if (item.deltaId) {
                recordOutcome(
                  { deltaId: item.deltaId, success: ok, turnIndex: -1, ...(result.error ? { error: result.error } : {}) },
                  (snapshot, ver) => {
                    pi.appendEntry("harness-state", { state: snapshot, version: ver });
                  },
                );
              }
              if (!ok) {
                orchestrationResults.push({
                  itemId: item.id,
                  kind: "skill",
                  result: { error: `skill failed (exit ${result.exitCode}) — consider harness_mutate update to repair it` },
                });
              }
            }
          }
        } catch (err) {
          orchestrationResults.push({ itemId: item.id, kind: item.kind, result: { error: (err as Error).message } });
        }
      }

      let text = summarize(applied);
      if (pendingCount > 0) {
        text +=
          `\n${pendingCount} executable subagent/skill item(s) stored but NOT run (orchestration mode: confirm). ` +
          `The user can review and execute explicitly with /harness run-subagent <id> or /harness run-skill <id>.`;
      }
      return {
        content: [{ type: "text", text }],
        details: {
          applied,
          itemCount: getState().items.length,
          orchestration: orchestrationResults,
          ...(pendingCount > 0 ? { pendingExecution: pendingCount } : {}),
        },
      };
    },
  });
}

function summarize(applied: AppliedDelta[]): string {
  const created = applied.filter((a) => a.op === "create").length;
  const updated = applied.filter((a) => a.op === "update").length;
  const deleted = applied.filter((a) => a.op === "delete").length;
  return `Applied ${applied.length} delta(s): ${created} created, ${updated} updated, ${deleted} deleted.`;
}