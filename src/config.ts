// User configuration for continual-harness: ~/.pi/agent/harness.json
//
// Phase 2 introduces this file (optional; missing → defaults) to configure:
//  - durableScope: where the durable markdown lives. "global" (default,
//    ~/.pi/agent/harness-state.md — backward compatible) or "project"
//    (~/.pi/agent/harness-state/<slug>.md, slug derived from cwd) so different
//    projects keep separate harness state for pi-reflect.
//  - remindRefine: opt-in turn_end nudge to run /refine (Phase 2 = reminder
//    only; Phase 3 adds opt-in auto-refine).
//
// Robust by design: missing or malformed file → DEFAULT_CONFIG, never throws.

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_DURABLE_PATH } from "./store.js";

export const DEFAULT_EVERY_TURNS = 50;
export const DEFAULT_AUTO_EVERY_TURNS = 100;

export interface HarnessConfig {
  durableScope?: "global" | "project";
  remindRefine?: {
    enabled?: boolean;
    everyTurns?: number;
  };
  autoRefine?: {
    enabled?: boolean;
    everyTurns?: number;
    commit?: boolean;
  };
}

export const DEFAULT_CONFIG: HarnessConfig = {
  durableScope: "global",
  remindRefine: { enabled: false, everyTurns: DEFAULT_EVERY_TURNS },
  autoRefine: { enabled: false, everyTurns: DEFAULT_AUTO_EVERY_TURNS, commit: false },
};

export const CONFIG_PATH = join(homedir(), ".pi", "agent", "harness.json");

let cached: HarnessConfig | undefined;

/** Merge a (possibly partial) parsed file over the defaults. */
function mergeConfig(over: Partial<HarnessConfig>): HarnessConfig {
  return {
    durableScope: over.durableScope === "project" ? "project" : "global",
    remindRefine: {
      enabled: over.remindRefine?.enabled ?? false,
      everyTurns: over.remindRefine?.everyTurns ?? DEFAULT_EVERY_TURNS,
    },
    autoRefine: {
      enabled: over.autoRefine?.enabled ?? false,
      everyTurns: over.autoRefine?.everyTurns ?? DEFAULT_AUTO_EVERY_TURNS,
      commit: over.autoRefine?.commit ?? false,
    },
  };
}

/** Load the config, merged over defaults. Tolerant: missing/malformed → defaults.
 *  Cached for the process lifetime (config is read once per session). */
export async function loadConfig(path: string = CONFIG_PATH): Promise<HarnessConfig> {
  if (cached) return cached;
  try {
    const raw = await readFile(path, "utf8");
    cached = mergeConfig(JSON.parse(raw) as Partial<HarnessConfig>);
  } catch {
    cached = { ...DEFAULT_CONFIG };
  }
  return cached;
}

/** Test hook: drop the in-process cache. */
export function resetConfigCache(): void {
  cached = undefined;
}

/**
 * Resolve the durable markdown path for the configured scope.
 *  - global  → ~/.pi/agent/harness-state.md (the default, unchanged)
 *  - project → ~/.pi/agent/harness-state/<slug>.md (slug derived from cwd)
 */
export function resolveDurablePath(config: HarnessConfig, cwd?: string): string {
  if (config.durableScope !== "project") return DEFAULT_DURABLE_PATH;
  return join(homedir(), ".pi", "agent", "harness-state", `${projectSlug(cwd)}.md`);
}

/** Stable, filesystem-safe slug from a directory path. Falls back to "default". */
export function projectSlug(cwd?: string): string {
  const base = (cwd ?? "").trim();
  if (!base) return "default";
  const slug = base
    .replace(/[\\/]+/g, "-")
    .replace(/[^a-z0-9-]+/gi, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase()
    .slice(-80);
  return slug || "default";
}
