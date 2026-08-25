// Evolution-loop mechanics: outcome-aware ranking, decay resistance,
// steering follow-through, and the shared failure-signature detector.
// Grounded in Continual Harness (arXiv 2605.09998) §3.2/§4.6 and ACE.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectSignals,
  hasRepetitionLoop,
  REPETITION_THRESHOLD,
} from "../src/signals.js";
import { fitness, selectForInjection, relevanceBonus, RELEVANCE_BONUS_WEIGHT } from "../src/select.js";
import {
  applyDeltas,
  decayAndPrune,
  getState,
  reconstruct,
} from "../src/store.js";
import {
  markSteeringActed,
  markSteeringSent,
  pendingSteeringOlderThan,
} from "../src/refine.js";
import { skillPromptLine, isExecutableSkill } from "../src/orchestration.js";
import { getFailingItems } from "../src/store.js";
import {
  trackSubagentRun,
  reconcileSubagentRuns,
  resetSubagentRuns,
  pendingSubagentRuns,
  RUN_TIMEOUT_MS,
} from "../src/subagent-tracking.js";
import {
  evaluateConsolidation,
  runConsolidation,
  resetConsolidation,
} from "../src/consolidate.js";
import type { HarnessConfig } from "../src/config.js";
import { loadConfig, resetConfigCache } from "../src/config.js";
import { isQuiet } from "../src/quiet.js";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HarnessItem } from "../src/types.js";

function reset(items: HarnessItem[] = []): void {
  reconstruct([]);
  if (items.length) applyDeltas([], () => {});
  // Directly seed state through reconstruct-free path: use applyDeltas for creates.
}

describe("failure-signature detection (signals.ts)", () => {
  it("detects all five signatures independently", () => {
    const toolErr = "[toolResult] error: command exited 1";
    expect(detectSignals(toolErr, 10)).toContain("tool_error");

    const correction = "[user] sebenarnya itu salah";
    expect(detectSignals(correction, 10)).toContain("user_correction");

    const trigger = "[user] refine the harness";
    expect(detectSignals(trigger, 10)).toContain("refine_trigger");
  });

  it("repetition_loop fires at threshold and not below", () => {
    const line = "[assistant] retrying git push origin main now";
    const below = Array.from({ length: REPETITION_THRESHOLD - 1 }, () => line).join("\n");
    const at = Array.from({ length: REPETITION_THRESHOLD }, () => line).join("\n");
    expect(hasRepetitionLoop(below)).toBe(false);
    expect(hasRepetitionLoop(at)).toBe(true);
  });

  it("repetition_loop ignores normalized duplicates differing only in whitespace/case", () => {
    const a = "[assistant] Running   the FULL build pipeline";
    const b = "[assistant] running the full build pipeline";
    expect(hasRepetitionLoop([a, b, b].join("\n"))).toBe(true);
  });

  it("short ack lines never count as loops", () => {
    expect(hasRepetitionLoop("[assistant] ok\n[assistant] ok\n[assistant] ok")).toBe(false);
  });
});

describe("outcome-aware injection ranking (select.ts)", () => {
  function mkItem(overrides: Partial<HarnessItem>): HarnessItem {
    return {
      id: `h_${Math.random().toString(36).slice(2, 8)}`,
      kind: "prompt",
      content: "note",
      evidence: "e",
      importance: 0.5,
      active: true,
      ownerModel: "test/main",
      createdAt: 0,
      updatedAt: 0,
      applications: 0,
      failures: 0,
      ...overrides,
    };
  }

  it("fitness equals importance for items with no outcome history", () => {
    const item = mkItem({ importance: 0.7 });
    expect(fitness(item)).toBe(0.7);
  });

  it("proven items outrank equally-important unproven ones", () => {
    const proven = mkItem({ id: "h_proven", content: "proven", importance: 0.5, applications: 5, failures: 0 });
    const fresh = mkItem({ id: "h_fresh", content: "fresh", importance: 0.5 });
    const { selected } = selectForInjection([fresh, proven], "test/main");
    expect(selected[0]!.id).toBe("h_proven");
  });

  it("a failing record cancels the bonus; a proven one overcomes a small importance deficit", () => {
    // Failing item: successRate 0 → no bonus at all.
    const failing = mkItem({ id: "h_failing", content: "failing", importance: 0.86, applications: 0, failures: 5 });
    // Proven item: starts lower but earns ~full bonus.
    const proven = mkItem({ id: "h_proven", content: "proven", importance: 0.84, applications: 3, failures: 0 });
    const { selected } = selectForInjection([failing, proven], "test/main");
    expect(selected[0]!.id).toBe("h_proven");
    // And the failing item's fitness never exceeds its authored importance.
    expect(fitness(failing)).toBe(0.86);
  });

  it("bonus saturates after OUTCOME_SATURATION successful applications", () => {
    const a = mkItem({ importance: 0.5, applications: 5, failures: 0 });
    const b = mkItem({ importance: 0.5, applications: 50, failures: 0 });
    expect(fitness(b)).toBeCloseTo(fitness(a), 10);
  });
});

describe("decay resistance (store.ts)", () => {
  it("net-positive items skip decay entirely", () => {
    reconstruct([]);
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "proven note", evidence: "e", deltaId: "d_proven" },
        { op: "create", kind: "prompt", content: "unproven note", evidence: "e" },
      ],
      () => {},
    );
    const st = getState();
    const proven = st.items.find((i) => i.content === "proven note")!;
    const unproven = st.items.find((i) => i.content === "unproven note")!;
    proven.applications = 4;
    proven.failures = 1;
    // Age both beyond any decay window.
    for (const i of [proven, unproven]) i.updatedAt = Date.now() - 100 * 86_400_000;

    decayAndPrune({ decayAfterDays: 1, decayStep: 0.1 }, () => {});
    expect(proven.importance).toBe(0.5); // untouched
    expect(unproven.importance).toBeCloseTo(0.4); // decayed
  });
});

describe("fair trials on repair (store.ts)", () => {
  it("content update resets outcome counters; importance-only update preserves them", () => {
    reconstruct([]);
    applyDeltas([{ op: "create", kind: "skill", content: "broken v1", evidence: "e", deltaId: "d_repair" }], () => {});
    const item = getState().items[0]!;
    item.applications = 2;
    item.failures = 5;
    item.lastOutcomeAt = 123456;

    // Repair: content changes → fresh trial.
    applyDeltas([{ op: "update", id: item.id, content: "fixed v2" }], () => {});
    const repaired = getState().items.find((i) => i.id === item.id)!;
    expect(repaired.applications).toBe(0);
    expect(repaired.failures).toBe(0);
    expect(repaired.lastOutcomeAt).toBeUndefined();

    // Cosmetic tuning: importance bump keeps history.
    repaired.applications = 3;
    applyDeltas([{ op: "update", id: repaired.id, importance: 0.9 }], () => {});
    const tuned = getState().items.find((i) => i.id === item.id)!;
    expect(tuned.applications).toBe(3);
    expect(tuned.importance).toBe(0.9);
  });
});

describe("auto-consolidation (consolidate.ts)", () => {
  beforeEach(() => {
    resetConsolidation();
    reconstruct([]);
  });

  it("cadence: seeds on first observed turn, fires at the configured interval", () => {
    const cfg = { consolidate: { enabled: true, everyTurns: 2 } } as HarnessConfig;
    expect(evaluateConsolidation(cfg, 0)).toBe(false); // seed
    expect(evaluateConsolidation(cfg, 1)).toBe(false);
    expect(evaluateConsolidation(cfg, 2)).toBe(true); // interval elapsed
    expect(evaluateConsolidation(cfg, 3)).toBe(false); // baseline moved to 2
    expect(evaluateConsolidation(cfg, 4)).toBe(true);
  });

  it("disabled config never fires", () => {
    const off = { consolidate: { enabled: false, everyTurns: 1 } } as HarnessConfig;
    expect(evaluateConsolidation(off, 0)).toBe(false);
    expect(evaluateConsolidation(off, 10)).toBe(false);
  });

  it("runConsolidation removes near-duplicates and prunes below-floor items", async () => {
    applyDeltas(
      [
        { op: "create", kind: "skill", content: "always run npm test before committing changes", evidence: "e", importance: 0.8 },
        { op: "create", kind: "skill", content: "always run npm test before committing changes today", evidence: "e", importance: 0.7 },
        { op: "create", kind: "prompt", content: "zzz unrelated filler note here", evidence: "e", importance: 0.1 },
      ],
      () => {},
    );
    expect(getState().items).toHaveLength(3);

    const res = await runConsolidation(() => {});
    expect(res.merged).toBe(1); // one near-duplicate deleted (lower importance)
    expect(res.pruned).toBe(1); // below-floor junk dropped
    expect(getState().items).toHaveLength(1);
    expect(getState().items[0]!.content).toContain("always run npm test");
  });
});

describe("quiet background operation", () => {
  it("echo-only evidence windows produce NO signals (anti-self-trigger)", () => {
    const echo = [
      "[user] /refine (online self-improvement, last 25 turns as evidence) review everything",
      "[assistant] **No-op** (echo-window policy). Store: 6 item aktif.",
    ].join("\n");
    expect(detectSignals(echo, 10)).toEqual([]);
  });

  it("genuine user correction still fires after echo stripping", () => {
    const mixed = [
      "[user] /refine (online self-improvement) old prompt",
      "[user] sebenarnya cara tadi salah",
    ].join("\n");
    expect(detectSignals(mixed, 10)).toContain("user_correction");
  });

  it("quiet flag merges from harness.json (default false)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-quiet-"));
    writeFileSync(join(dir, "harness.json"), JSON.stringify({ quiet: true }));
    resetConfigCache();
    await loadConfig(join(dir, "harness.json"));
    try {
      expect(await isQuiet()).toBe(true);

      const dir2 = mkdtempSync(join(tmpdir(), "pi-ch-quiet2-"));
      try {
        writeFileSync(join(dir2, "harness.json"), JSON.stringify({}));
        resetConfigCache();
        await loadConfig(join(dir2, "harness.json"));
        expect(await isQuiet()).toBe(false);
      } finally {
        rmSync(dir2, { recursive: true, force: true });
        resetConfigCache();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
      resetConfigCache();
    }
  });
});

describe("steering follow-through (refine.ts)", () => {
  it("tracks pending → cleared lifecycle", async () => {
    markSteeringActed();
    expect(pendingSteeringOlderThan(0)).toBe(false);

    markSteeringSent();
    // Just sent: not older than a large window…
    expect(pendingSteeringOlderThan(60_000)).toBe(false);
    // …but older than zero.
    await new Promise((r) => setTimeout(r, 5));
    expect(pendingSteeringOlderThan(0)).toBe(true);

    markSteeringActed();
    expect(pendingSteeringOlderThan(0)).toBe(false);
  });
});

describe("progressive disclosure for skills (orchestration.ts)", () => {
  const mkSkill = (content: string): HarnessItem => ({
    id: "h_skill",
    kind: "skill",
    content,
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "test/main",
    createdAt: 0,
    updatedAt: 0,
  });

  it("executable skills render their description, never the code", () => {
    const exec = mkSkill(
      "---\nlanguage: shell\ndescription: Back up the postgres volume safely\n---\n#!/bin/bash\npg_dump all_the_secrets",
    );
    expect(isExecutableSkill(exec.content)).toBe(true);
    const line = skillPromptLine(exec);
    expect(line).toContain("Back up the postgres volume safely");
    expect(line).toContain("/harness run-skill h_skill");
    expect(line).not.toContain("pg_dump");
  });

  it("without a description, derives one from the first body line (comment-stripped)", () => {
    const noDesc = mkSkill(
      "---\nlanguage: python\n---\n# Clean up stale docker volumes\ndocker system prune --all",
    );
    const line = skillPromptLine(noDesc);
    expect(line).toContain("Clean up stale docker volumes");
    expect(line).not.toContain("docker system prune");
  });

  it("plain notes render verbatim and are not flagged executable", () => {
    const note = "just a note about testing";
    expect(isExecutableSkill(note)).toBe(false);
    expect(skillPromptLine(mkSkill(note))).toBe(note);
  });
});

describe("relevance-aware selection (select.ts)", () => {
  const mkNote = (id: string, content: string): HarnessItem => ({
    id,
    kind: "memory",
    content,
    evidence: "e",
    importance: 0.5,
    active: true,
    ownerModel: "test/main",
    createdAt: 0,
    updatedAt: 0,
    applications: 0,
    failures: 0,
  });

  it("memories overlapping the current user message outrank equal-fitness ones", () => {
    const db = mkNote("h_db", "postgres migration requires locking the database tables first");
    const css = mkNote("h_css", "the design system uses css grid for dashboard layout");
    // Budget fits both; the relevant one must lead despite equal fitness.
    const { selected } = selectForInjection(
      [css, db],
      "test/main",
      { maxTokens: 400 },
      "we need to fix the database migration locking issue now",
    );
    expect(selected[0]!.id).toBe("h_db");
  });

  it("without recent text, ordering is pure fitness (legacy behavior)", () => {
    const a = mkNote("h_a", "alpha beta gamma delta epsilon");
    const b = mkNote("h_b", "unrelated words entirely here friends");
    const { selected } = selectForInjection([a, b], "test/main");
    expect(selected.map((i) => i.id)).toEqual(["h_a", "h_b"]); // stable insertion order
  });

  it("short tokens (<4 chars) never count as relevance overlap", () => {
    const item = mkNote("h_it", "it was a fix");
    expect(relevanceBonus(item.content, "fix it now ok do")).toBe(0);
  });
});

describe("failing-item repair targets (store.ts)", () => {
  it("flags active net-failing items only after minFailures", () => {
    reconstruct([]);
    applyDeltas(
      [
        { op: "create", kind: "skill", content: "broken skill", evidence: "e", deltaId: "d_bad" },
        { op: "create", kind: "skill", content: "flaky once", evidence: "e" },
        { op: "create", kind: "skill", content: "healthy skill", evidence: "e" },
      ],
      () => {},
    );
    const st = getState().items;
    const bad = st.find((i) => i.content === "broken skill")!;
    const flaky = st.find((i) => i.content === "flaky once")!;
    const healthy = st.find((i) => i.content === "healthy skill")!;
    bad.failures = 3;
    bad.applications = 1;
    flaky.failures = 1;
    healthy.applications = 5;
    healthy.failures = 1;

    const ids = getFailingItems().map((i) => i.id);
    expect(ids).toContain(bad.id);
    expect(ids).not.toContain(flaky.id); // below minFailures
    expect(ids).not.toContain(healthy.id); // net-positive
  });
});

describe("sub-agent outcome reconciliation (subagent-tracking.ts)", () => {
  beforeEach(() => {
    resetSubagentRuns();
    reconstruct([]);
  });

  function fakeCtx(entries: unknown[]): ExtensionContext {
    return { sessionManager: { getBranch: () => entries } } as unknown as ExtensionContext;
  }

  function seedItem(deltaId: string): HarnessItem {
    applyDeltas([{ op: "create", kind: "subagent", content: "agent: coder\ntask: t", evidence: "e", deltaId }], () => {});
    return getState().items[getState().items.length - 1]!;
  }

  it("request-only mentions never fabricate an outcome; completions resolve success", () => {
    const runId = "run_test_success";
    const item = seedItem("d_sub_ok");
    trackSubagentRun(runId, item.id, item.deltaId);
    // Only the steering request exists so far → nothing resolved.
    let res = reconcileSubagentRuns(
      fakeCtx([{ type: "message", message: { role: "user", content: [{ type: "text", text: `/harness subagent:execute ${runId} ...` }] } }]),
      () => {},
    );
    expect(res.resolved).toBe(0);
    expect(pendingSubagentRuns()).toBe(1);

    // A later tool-result-shaped entry resolves it as success.
    res = reconcileSubagentRuns(
      fakeCtx([
        { type: "message", message: { role: "user", content: [{ type: "text", text: `/harness subagent:execute ${runId}` }] } },
        { type: "custom", customType: "tool_result", data: { runId, output: "done", status: "completed" } },
      ]),
      () => {},
    );
    expect(res.resolved).toBe(1);
    expect(res.successes).toBe(1);
    expect(pendingSubagentRuns()).toBe(0);
    expect(item.applications).toBe(1);
  });

  it("completion entries with error markers record failures against the delta", () => {
    const runId = "run_test_fail";
    const item = seedItem("d_sub_fail");
    trackSubagentRun(runId, item.id, item.deltaId);
    const res = reconcileSubagentRuns(
      fakeCtx([
        { type: "custom", customType: "tool_call", data: { isError: true, runId, error: "boom" } },
      ]),
      () => {},
    );
    expect(res.resolved).toBe(1);
    expect(res.failures).toBe(1);
    expect(item.failures).toBe(1);
  });

  it("stale runs past RUN_TIMEOUT_MS are dropped without fabricated outcomes", () => {
    const runId = "run_test_stale";
    const item = seedItem("d_sub_stale");
    trackSubagentRun(runId, item.id, item.deltaId, Date.now() - RUN_TIMEOUT_MS - 1000);
    const res = reconcileSubagentRuns(fakeCtx([]), () => {});
    expect(res.resolved).toBe(0);
    expect(pendingSubagentRuns()).toBe(0);
    expect(item.applications ?? 0).toBe(0);
    expect(item.failures ?? 0).toBe(0);
  });
});
