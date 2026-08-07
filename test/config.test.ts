import { describe, it, expect, beforeEach } from "vitest";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  loadConfig,
  projectSlug,
  resetConfigCache,
  resolveDurablePath,
} from "../src/config.js";
import { DEFAULT_DURABLE_PATH } from "../src/store.js";

function tempFile(): string {
  return join(tmpdir(), `harness-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
}

async function withTempDir<T>(fn: (file: string) => Promise<T>): Promise<T> {
  const dir = join(tmpdir(), `harness-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(dir, { recursive: true });
  const file = join(dir, "harness.json");
  try {
    return await fn(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("config", () => {
  beforeEach(resetConfigCache);

  describe("loadConfig", () => {
    it("returns defaults when the file is missing", async () => {
      const cfg = await loadConfig(tempFile());
      expect(cfg).toEqual(DEFAULT_CONFIG);
    });

    it("merges a partial file over defaults (project scope, reminder on)", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, JSON.stringify({ durableScope: "project", remindRefine: { enabled: true } }), "utf8");
        const cfg = await loadConfig(file);
        expect(cfg.durableScope).toBe("project");
        expect(cfg.remindRefine?.enabled).toBe(true);
        expect(cfg.remindRefine?.everyTurns).toBe(50); // default retained
      });
    });

    it("falls back to defaults on malformed JSON", async () => {
      await withTempDir(async (file) => {
        await writeFile(file, "{not valid json", "utf8");
        const cfg = await loadConfig(file);
        expect(cfg).toEqual(DEFAULT_CONFIG);
      });
    });

    it("ignores unknown keys and bad durableScope values", async () => {
      await withTempDir(async (file) => {
        await writeFile(
          file,
          JSON.stringify({ durableScope: "bogus", unknownKey: 1, remindRefine: { everyTurns: 10 } }),
          "utf8",
        );
        const cfg = await loadConfig(file);
        expect(cfg.durableScope).toBe("global"); // unknown durableScope → default
        expect(cfg.remindRefine?.everyTurns).toBe(10);
        expect(cfg.remindRefine?.enabled).toBe(false);
      });
    });
  });

  describe("projectSlug", () => {
    it("sanitizes a Windows absolute path", () => {
      const s = projectSlug("C:\\Users\\Alessandro\\source\\pi\\packages\\pi-continual-harness");
      expect(s).toMatch(/^[a-z0-9-]+$/);
      expect(s).toContain("pi-continual-harness");
      expect(s).not.toContain(":");
    });

    it("sanitizes a POSIX path", () => {
      expect(projectSlug("/home/me/proj")).toBe("home-me-proj");
    });

    it("falls back to 'default' for empty / whitespace / undefined", () => {
      expect(projectSlug("")).toBe("default");
      expect(projectSlug("   ")).toBe("default");
      expect(projectSlug(undefined)).toBe("default");
      expect(projectSlug("/")).toBe("default");
    });
  });

  describe("resolveDurablePath", () => {
    it("global scope returns the shared DEFAULT_DURABLE_PATH", () => {
      expect(resolveDurablePath({ durableScope: "global" }, "/anywhere")).toBe(DEFAULT_DURABLE_PATH);
    });

    it("undefined scope defaults to global", () => {
      expect(resolveDurablePath({}, "/anywhere")).toBe(DEFAULT_DURABLE_PATH);
    });

    it("project scope returns a per-project file under .pi/agent/harness-state/", () => {
      const p = resolveDurablePath({ durableScope: "project" }, "/home/me/proj");
      expect(p).toBe(join(homedir(), ".pi", "agent", "harness-state", "home-me-proj.md"));
    });
  });
});
