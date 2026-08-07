// Integration tests with a stubbed ExtensionAPI.
//
// These validate the three runtime assumptions tsc could not:
//  (1) getBranch() entry shape — /refine evidence extraction reads
//      message.content[].text.
//  (2) the /refine command handler actually calls sendUserMessage (whether pi
//      then fires a turn is a pi-runtime concern, not ours).
//  (3) session_start reconstruction finds custom harness-state entries in
//      getBranch() and restores from the last snapshot.
//
// Plus the end-to-end behaviour: before_agent_start injection, and the
// harness_list / harness_mutate tools round-tripping through appendEntry.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import continualHarness from "../src/index.js";
import { getState, reconstruct, STATE_ENTRY } from "../src/store.js";

type Handler = (event?: unknown, ctx?: unknown) => unknown | Promise<unknown>;

interface FakeCtx {
  ui: {
    notify: (msg: string, level: string) => void;
    setStatus: (key: string, text: string | undefined) => void;
  };
  sessionManager: {
    getBranch: () => unknown[];
  };
  cwd: string;
}

function makeFakePi(branch: unknown[]) {
  const handlers = new Map<string, Handler>();
  const tools = new Map<string, Record<string, unknown>>();
  const commands = new Map<string, { description?: string; handler: Handler }>();
  const entries: Array<{ type: string; customType: string; data: unknown }> = [];
  const sentMessages: string[] = [];
  const notifications: Array<{ msg: string; level: string }> = [];
  const statuses: Array<{ key: string; text: string | undefined }> = [];

  const pi = {
    on: (ev: string, h: Handler) => {
      handlers.set(ev, h);
    },
    registerTool: (def: Record<string, unknown>) => {
      tools.set(def.name as string, def);
    },
    registerCommand: (name: string, opts: { description?: string; handler: Handler }) => {
      commands.set(name, opts);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ type: "custom", customType, data });
    },
    sendUserMessage: (msg: string) => {
      sentMessages.push(msg);
    },
  };

  const ctx = (): FakeCtx => ({
    ui: {
      notify: (msg, level) => notifications.push({ msg, level }),
      setStatus: (key, text) => statuses.push({ key, text }),
    },
    sessionManager: { getBranch: () => branch },
    cwd: "/tmp",
  });

  return { pi: pi as unknown as ExtensionAPI, handlers, tools, commands, entries, sentMessages, notifications, statuses, ctx };
}

function reset(): void {
  reconstruct([]);
}

describe("registration", () => {
  beforeEach(reset);

  it("registers session_start, before_agent_start, the two tools, and /refine", () => {
    const { pi, handlers, tools, commands } = makeFakePi([]);
    continualHarness(pi);
    expect(handlers.has("session_start")).toBe(true);
    expect(handlers.has("before_agent_start")).toBe(true);
    expect(tools.has("harness_list")).toBe(true);
    expect(tools.has("harness_mutate")).toBe(true);
    expect(commands.has("refine")).toBe(true);
  });
});

// Assumption (3): custom harness-state entries appear in getBranch() and
// session_start restores from the last snapshot.
describe("session_start reconstruction", () => {
  beforeEach(reset);

  it("restores items from the last harness-state snapshot on the branch", async () => {
    const branch = [
      {
        type: "custom",
        customType: STATE_ENTRY,
        data: {
          state: {
            items: [
              { id: "h_1", kind: "memory", content: "restored fact", evidence: "e", importance: 0.6, active: true, createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    ];
    const { pi, handlers, ctx, notifications } = makeFakePi(branch);
    continualHarness(pi);

    await handlers.get("session_start")!({ reason: "startup" }, ctx());

    expect(getState().items.map((i) => i.id)).toEqual(["h_1"]);
    expect(notifications.some((n) => /1 item\(s\) restored/.test(n.msg))).toBe(true);
  });

  it("stays empty and stays quiet when the branch has no harness-state entry", async () => {
    const { pi, handlers, ctx, notifications } = makeFakePi([
      { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
    ]);
    continualHarness(pi);
    await handlers.get("session_start")!({ reason: "startup" }, ctx());
    expect(getState().items).toHaveLength(0);
    expect(notifications).toHaveLength(0);
  });
});

describe("before_agent_start injection", () => {
  beforeEach(reset);

  it("appends a structured block to the base prompt and never replaces it", async () => {
    const branch = [
      {
        type: "custom",
        customType: STATE_ENTRY,
        data: {
          state: {
            items: [
              { id: "h_1", kind: "prompt", content: "Always cite evidence", evidence: "e", importance: 0.8, active: true, createdAt: 1, updatedAt: 1 },
            ],
          },
        },
      },
    ];
    const { pi, handlers, ctx } = makeFakePi(branch);
    continualHarness(pi);
    await handlers.get("session_start")!({ reason: "startup" }, ctx());

    const ret = (await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctx())) as {
      systemPrompt?: string;
    };
    expect(ret?.systemPrompt).toBeDefined();
    expect(ret!.systemPrompt!.startsWith("BASE")).toBe(true);
    expect(ret!.systemPrompt).toContain("Continual Harness state");
    expect(ret!.systemPrompt).toContain("Always cite evidence");
  });

  it("returns undefined (no prompt change) when there is no active state", async () => {
    const { pi, handlers, ctx } = makeFakePi([]);
    continualHarness(pi);
    const ret = await handlers.get("before_agent_start")!({ systemPrompt: "BASE" }, ctx());
    expect(ret).toBeUndefined();
  });
});

// Assumptions (1) + (2): /refine reads message.content[].text from the branch
// and calls sendUserMessage with a steering prompt containing that evidence.
describe("/refine command", () => {
  beforeEach(reset);

  it("gathers trajectory evidence and steers the agent via sendUserMessage", async () => {
    const branch = [
      { type: "message", message: { role: "user", content: [{ type: "text", text: "Fix the login bug in auth.ts" }] } },
      { type: "message", message: { role: "assistant", content: [{ type: "text", text: "Looking into auth.ts now" }] } },
    ];
    const { pi, commands, ctx, sentMessages, entries } = makeFakePi(branch);
    continualHarness(pi);

    await commands.get("refine")!.handler("25", ctx());

    // (1) evidence text survived into the steering prompt
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("Fix the login bug in auth.ts");
    expect(sentMessages[0]).toContain("harness_mutate");

    // audit entry recorded
    expect(entries.some((e) => e.customType === "harness-refinement")).toBe(true);
  });

  it("parses lookback N and --commit from args", async () => {
    // We don't assert the durable write here (covered in store.test.ts); we only
    // confirm argument parsing does not throw and still steers.
    const { pi, commands, ctx, sentMessages } = makeFakePi([]);
    continualHarness(pi);
    await commands.get("refine")!.handler("50 --commit", ctx());
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toContain("last 50 turns");
  });
});

describe("harness tools round-trip", () => {
  beforeEach(reset);

  it("harness_mutate applies deltas and snapshots via appendEntry; harness_list reads them back", async () => {
    const { pi, tools, ctx, entries } = makeFakePi([]);
    continualHarness(pi);

    const mutate = tools.get("harness_mutate")!;
    const res = (await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {
      deltas: [{ op: "create", kind: "memory", content: "fact A", evidence: "saw it" }],
    }, undefined, undefined, ctx())) as { content: Array<{ type: string; text: string }>; details: { applied: unknown[] } };

    expect(res.content[0]!.text).toMatch(/Applied 1 delta/);
    expect(res.details.applied).toHaveLength(1);
    // The persist callback inside tools.ts calls pi.appendEntry("harness-state", ...).
    expect(entries.some((e) => e.customType === STATE_ENTRY)).toBe(true);

    const list = tools.get("harness_list")!;
    const listed = (await (list.execute as (...a: unknown[]) => Promise<unknown>)(undefined, {}, undefined, undefined, ctx())) as {
      content: Array<{ type: string; text: string }>;
    };
    expect(listed.content[0]!.text).toContain("fact A");
  });
});

describe("/harness command", () => {
  beforeEach(reset);

  it("registers the harness command", () => {
    const { pi, commands } = makeFakePi([]);
    continualHarness(pi);
    expect(commands.has("harness")).toBe(true);
  });

  it("export then import round-trips active items through a durable file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ch-harness-"));
    const file = join(dir, "harness-state.md");
    try {
      const { pi, tools, commands, ctx, notifications } = makeFakePi([]);
      continualHarness(pi);

      // seed an item
      const mutate = tools.get("harness_mutate")!;
      await (mutate.execute as (...a: unknown[]) => Promise<unknown>)(
        undefined,
        { deltas: [{ op: "create", kind: "memory", content: "durable fact", evidence: "saw it" }] },
        undefined,
        undefined,
        ctx(),
      );

      // export to the temp file
      await commands.get("harness")!.handler(`export ${file}`, ctx());
      expect(notifications.some((n) => /Exported 1 active/.test(n.msg))).toBe(true);

      // wipe live state, then import it back
      reconstruct([]);
      expect(getState().items).toHaveLength(0);
      await commands.get("harness")!.handler(`import ${file}`, ctx());
      expect(getState().items.map((i) => i.content)).toContain("durable fact");
      expect(notifications.some((n) => /Imported 1 item/.test(n.msg))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
