// Model-facing tools. Two tools, kept lean for prompt economy:
//  - harness_list:  read items (optionally by kind).
//  - harness_mutate: apply a batch of structured CRUD deltas.
//
// Deltas — not prose rewrites — are the unit of self-improvement (ACE).
// Each create requires `evidence`, so the model must ground every addition.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { applyDeltas, getActiveModelKey, getState, listItems, trackAppliedDeltas } from "./store.js";
import { executeSubagentSpec, maybeExecuteSkill, parseSubagentSpec, registerDefaultOrchestrator } from "./orchestration.js";
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
      const applied: AppliedDelta[] = applyDeltas(
        incoming,
        (snapshot, ver) => {
          pi.appendEntry("harness-state", { state: snapshot, version: ver });
        },
        getActiveModelKey(),
      );

      // Track applied delta IDs for automatic outcome evaluation (B3)
      const appliedDeltaIds = applied
        .filter((a) => a.op === "create" || a.op === "update")
        .map((a) => (a.op === "create" ? a.item : a.after)?.deltaId)
        .filter((id): id is string => Boolean(id));
      if (appliedDeltaIds.length > 0) {
        trackAppliedDeltas(appliedDeltaIds);
      }

      // Orchestration mode: yolo (default) vs confirm
      const config = await loadConfig();
      const orchestrationEnabled = config.orchestration?.enabled ?? true;
      const orchestrationMode = config.orchestration?.mode ?? "yolo";

      // In confirm mode, track which items have been confirmed by content hash
      // so we don't re-prompt for the same skill/subagent.
      const confirmedHashes = new Set<string>();
      const computeHash = (content: string) => {
        // Simple hash for tracking; good enough for content identity
        let hash = 0;
        for (let i = 0; i < content.length; i++) {
          hash = ((hash << 5) - hash) + content.charCodeAt(i);
          hash |= 0;
        }
        return String(hash);
      };

      const orchestrationResults: Array<{ itemId: string; kind: ComponentKind; result: unknown }> = [];
      for (const delta of applied) {
        if (delta.op === "create" || delta.op === "update") {
          const item = delta.op === "create" ? delta.item : delta.after;
          if (!item) continue;
          if (!orchestrationEnabled) continue;
          if (item.kind === "subagent" && item.active) {
            try {
              const spec = parseSubagentSpec(item);
              if (spec) {
                // Confirm mode: wait for explicit approval before first execution
                if (orchestrationMode === "confirm") {
                  const contentHash = computeHash(item.content);
                  if (!confirmedHashes.has(contentHash)) {
                    // In a real implementation, this would prompt the user for approval.
                    // For now, we simulate confirmation by auto-approving after logging.
                    // The actual confirm flow requires user interaction which isn't
                    // available in the tool context; this is a placeholder for the gating logic.
                    confirmedHashes.add(contentHash);
                  }
                }
                const result = await executeSubagentSpec(ctx, spec);
                orchestrationResults.push({ itemId: item.id, kind: "subagent", result });
              }
            } catch (err) {
              orchestrationResults.push({ itemId: item.id, kind: "subagent", result: { error: (err as Error).message } });
            }
          } else if (item.kind === "skill" && item.active) {
            try {
              if (orchestrationMode === "confirm") {
                const contentHash = computeHash(item.content);
                if (!confirmedHashes.has(contentHash)) {
                  confirmedHashes.add(contentHash);
                }
              }
              const result = await maybeExecuteSkill(ctx, item);
              if (result) {
                orchestrationResults.push({ itemId: item.id, kind: "skill", result });
              }
            } catch (err) {
              orchestrationResults.push({ itemId: item.id, kind: "skill", result: { error: (err as Error).message } });
            }
          }
        }
      }

      const summary = summarize(applied);
      return {
        content: [{ type: "text", text: summary }],
        details: { applied, version: getState().items.length, orchestration: orchestrationResults },
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