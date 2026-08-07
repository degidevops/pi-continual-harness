// Pure unit tests for the store: CRUD/delta semantics, rollback, reconstruction,
// decay/prune, durable export. No pi stub needed — applyDeltas takes a `persist`
// callback, which decouples it from the ExtensionAPI.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  applyDeltas,
  decayAndPrune,
  exportDurable,
  getState,
  IMPORTANCE_FLOOR,
  listItems,
  reconstruct,
} from "../src/store.js";
import type { Delta } from "../src/types.js";

function reset(): void {
  reconstruct([]);
}

describe("applyDeltas — create", () => {
  beforeEach(reset);

  it("creates an item, persists a snapshot, and assigns an id", () => {
    const persist = vi.fn();
    const deltas: Delta[] = [
      { op: "create", kind: "memory", content: "prefer tabs", evidence: "user said so" },
    ];
    const applied = applyDeltas(deltas, persist);

    expect(applied).toHaveLength(1);
    expect(applied[0]!.op).toBe("create");
    const item = applied[0]!.op === "create" ? applied[0]!.item : undefined;
    expect(item?.id).toMatch(/^h_/);
    expect(item?.content).toBe("prefer tabs");
    expect(item?.evidence).toBe("user said so");
    expect(item?.active).toBe(true);
    expect(getState().items).toHaveLength(1);
    expect(persist).toHaveBeenCalledTimes(1);
    // Snapshot passed to persist reflects the new item.
    const snapshot = persist.mock.calls[0]![0];
    expect(snapshot.items).toHaveLength(1);
  });

  it("clamps importance to [0,1]", () => {
    applyDeltas(
      [{ op: "create", kind: "prompt", content: "x", evidence: "y", importance: 5 }],
      vi.fn(),
    );
    applyDeltas(
      [{ op: "create", kind: "prompt", content: "x2", evidence: "y2", importance: -1 }],
      vi.fn(),
    );
    const imps = getState().items.map((i) => i.importance);
    expect(imps).toEqual([1, 0]);
  });
});

describe("applyDeltas — update / delete", () => {
  beforeEach(reset);

  it("updates fields and toggles active", () => {
    const [created] = applyDeltas(
      [{ op: "create", kind: "memory", content: "v1", evidence: "e" }],
      vi.fn(),
    );
    const id = created!.op === "create" ? created!.item.id : "";
    const [updated] = applyDeltas(
      [{ op: "update", id, content: "v2", active: false, importance: 0.9 }],
      vi.fn(),
    );
    const after = updated!.op === "update" ? updated!.after : undefined;
    expect(after?.content).toBe("v2");
    expect(after?.active).toBe(false);
    expect(after?.importance).toBe(0.9);
  });

  it("deletes by id", () => {
    const [created] = applyDeltas(
      [{ op: "create", kind: "skill", content: "s", evidence: "e" }],
      vi.fn(),
    );
    const id = created!.op === "create" ? created!.item.id : "";
    applyDeltas([{ op: "delete", id, reason: "stale" }], vi.fn());
    expect(getState().items).toHaveLength(0);
  });

  it("throws on update/delete of unknown id", () => {
    expect(() => applyDeltas([{ op: "update", id: "nope", content: "x" }], vi.fn())).toThrow();
    expect(() => applyDeltas([{ op: "delete", id: "nope", reason: "r" }], vi.fn())).toThrow();
  });
});

describe("applyDeltas — atomicity", () => {
  beforeEach(reset);

  it("rolls back the whole batch and skips persist if any delta fails", () => {
    const persist = vi.fn();
    const deltas: Delta[] = [
      { op: "create", kind: "memory", content: "survivor", evidence: "e" },
      { op: "update", id: "does-not-exist", content: "boom" }, // throws
    ];
    expect(() => applyDeltas(deltas, persist)).toThrow();
    // Survivor must NOT remain: in-memory state restored to pre-batch snapshot.
    expect(getState().items).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
  });
});

describe("reconstruct", () => {
  beforeEach(reset);

  it("restores from the last harness-state snapshot on the branch", () => {
    const entries = [
      {
        type: "custom",
        customType: "harness-state",
        data: {
          state: {
            items: [{ id: "h_a", kind: "memory", content: "old", evidence: "e", importance: 0.5, active: true, createdAt: 1, updatedAt: 1 }],
          },
        },
      },
      {
        type: "custom",
        customType: "harness-state",
        data: {
          state: {
            items: [{ id: "h_b", kind: "prompt", content: "new", evidence: "e", importance: 0.5, active: true, createdAt: 2, updatedAt: 2 }],
          },
        },
      },
    ];
    reconstruct(entries);
    expect(getState().items.map((i) => i.id)).toEqual(["h_b"]);
  });

  it("ignores unrelated custom and message entries", () => {
    const entries = [
      { type: "custom", customType: "harness-refinement", data: {} },
      { type: "message", message: { role: "user" } },
    ];
    reconstruct(entries);
    expect(getState().items).toHaveLength(0);
  });

  it("resets to empty when no snapshot is present", () => {
    applyDeltas([{ op: "create", kind: "memory", content: "x", evidence: "y" }], vi.fn());
    expect(getState().items).toHaveLength(1);
    reconstruct([]);
    expect(getState().items).toHaveLength(0);
  });
});

describe("listItems", () => {
  beforeEach(reset);

  it("filters by kind", () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "m", evidence: "e" },
        { op: "create", kind: "prompt", content: "p", evidence: "e" },
      ],
      vi.fn(),
    );
    expect(listItems("memory")).toHaveLength(1);
    expect(listItems("prompt")).toHaveLength(1);
    expect(listItems()).toHaveLength(2);
  });
});

describe("decayAndPrune", () => {
  beforeEach(reset);

  it("removes items below the importance floor", () => {
    applyDeltas(
      [
        { op: "create", kind: "memory", content: "keep", evidence: "e", importance: 0.8 },
        { op: "create", kind: "memory", content: "drop", evidence: "e", importance: IMPORTANCE_FLOOR - 0.05 },
      ],
      vi.fn(),
    );
    const persist = vi.fn();
    const { pruned } = decayAndPrune(persist);
    expect(pruned).toBe(1);
    expect(getState().items.map((i) => i.content)).toEqual(["keep"]);
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe("exportDurable", () => {
  beforeEach(reset);

  it("writes active items grouped by kind, excluding inactive ones", async () => {
    applyDeltas(
      [
        { op: "create", kind: "prompt", content: "be terse", evidence: "user feedback", importance: 0.8 },
        { op: "create", kind: "memory", content: "uses vitest", evidence: "saw config", importance: 0.7 },
        { op: "create", kind: "skill", content: "hidden one", evidence: "e", importance: 0.5 },
      ],
      vi.fn(),
    );
    // Deactivate the skill so it is excluded from the durable export.
    const skill = listItems("skill")[0]!;
    applyDeltas([{ op: "update", id: skill.id, active: false }], vi.fn());

    const dir = mkdtempSync(join(tmpdir(), "pi-ch-durable-"));
    const file = join(dir, "harness-state.md");
    try {
      const written = await exportDurable(file);
      expect(written).toBe(file);
      const body = readFileSync(file, "utf8");
      expect(body).toContain("Supplemental prompt notes");
      expect(body).toContain("be terse");
      expect(body).toContain("Memory facts");
      expect(body).toContain("uses vitest");
      // Inactive skill must not appear.
      expect(body).not.toContain("hidden one");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
