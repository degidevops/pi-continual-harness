// before_agent_start: inject the active harness state as a structured block
// appended to the base system prompt. Never rewrites or replaces the base —
// only appends, matching Continual Harness's "immutable base + supplemental".

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getState } from "./store.js";
import type { ComponentKind } from "./types.js";

const ORDER: ComponentKind[] = ["prompt", "memory", "skill", "subagent"];

const TITLES: Record<ComponentKind, string> = {
  prompt: "Self-improved prompt notes",
  memory: "Remembered facts",
  skill: "Available skill notes",
  subagent: "Reusable sub-agent specs",
};

export function renderHarnessBlock(): string {
  const state = getState();
  if (state.items.length === 0) return "";

  const sections: string[] = [];
  for (const kind of ORDER) {
    const items = state.items.filter((i) => i.kind === kind && i.active);
    if (items.length === 0) continue;
    const bullets = items
      .map((i) => `- [${i.id}] ${i.content}`)
      .join("\n");
    sections.push(`### ${TITLES[kind]}\n${bullets}`);
  }
  if (sections.length === 0) return "";

  return [
    "",
    "## Continual Harness state",
    "Self-improved notes accumulated from past trajectories via /refine.",
    "Treat these as durable working context. Update them with the harness_mutate tool when they are wrong or stale.",
    "",
    sections.join("\n\n"),
  ].join("\n");
}

export function registerInjection(pi: ExtensionAPI): void {
  pi.on("before_agent_start", async (event) => {
    const block = renderHarnessBlock();
    if (!block) return;
    return { systemPrompt: event.systemPrompt + "\n" + block };
  });
}
