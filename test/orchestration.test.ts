import { describe, it, expect, beforeEach, vi } from "vitest";
import type { HarnessItem } from "../src/types.js";
import {
  parseSubagentSpec,
  parseYaml,
  maybeExecuteSkill,
  registerOrchestrator,
  getOrchestrator,
  listOrchestrators,
  type SubagentSpec,
  type SubagentOrchestrator,
  type SkillExecutionResult,
} from "../src/orchestration.js";

function item(over: Partial<HarnessItem> & Pick<HarnessItem, "id" | "kind" | "content">): HarnessItem {
  const now = 10_000;
  return { evidence: "e", importance: 0.5, active: true, ownerModel: "", createdAt: now, updatedAt: now, ...over };
}

describe("parseYaml", () => {
  it("parses simple key-value pairs", () => {
    const result = parseYaml("key1: value1\nkey2: value2");
    expect(result).toEqual({ key1: "value1", key2: "value2" });
  });

  it("strips quotes", () => {
    const result = parseYaml('key1: "value1"\nkey2: \'value2\'');
    expect(result).toEqual({ key1: "value1", key2: "value2" });
  });

  it("parses numbers and booleans", () => {
    const result = parseYaml("num: 42\nbool: true\nbool2: false");
    expect(result).toEqual({ num: 42, bool: true, bool2: false });
  });

  it("ignores invalid lines", () => {
    const result = parseYaml("key: value\ninvalid line\nkey2: value2");
    expect(result).toEqual({ key: "value", key2: "value2" });
  });

  it("parses nested objects", () => {
    const result = parseYaml("limits:\n  maxTurns: 10\n  maxTokens: 5000");
    expect(result).toEqual({ limits: { maxTurns: 10, maxTokens: 5000 } });
  });
});

describe("parseSubagentSpec", () => {
  it("parses YAML front-matter format", () => {
    const specItem = item({
      id: "h_1",
      kind: "subagent",
      content: `---\nagent: coder\ntask: implement feature X\nasync: true\n---\nAdditional context here`,
    });
    const result = parseSubagentSpec(specItem);
    expect(result).toEqual({
      agent: "coder",
      task: "Additional context here",
      async: true,
    });
  });

  it("parses JSON format", () => {
    const specItem = item({
      id: "h_2",
      kind: "subagent",
      content: JSON.stringify({ agent: "researcher", task: "find info", workflowScript: "runs.all([...])" }),
    });
    const result = parseSubagentSpec(specItem);
    expect(result).toEqual({
      agent: "researcher",
      task: "find info",
      workflowScript: "runs.all([...])",
    });
  });

  it("parses plain text with agent on first line", () => {
    const specItem = item({
      id: "h_3",
      kind: "subagent",
      content: "coder\nimplement the feature",
    });
    const result = parseSubagentSpec(specItem);
    expect(result).toEqual({ agent: "coder", task: "implement the feature" });
  });

  it("falls back to default agent for plain text", () => {
    const specItem = item({
      id: "h_4",
      kind: "subagent",
      content: "just a task description",
    });
    const result = parseSubagentSpec(specItem);
    expect(result).toEqual({ agent: "default", task: "just a task description" });
  });

  it("returns null for empty content", () => {
    const specItem = item({ id: "h_5", kind: "subagent", content: "" });
    const result = parseSubagentSpec(specItem);
    expect(result).toBeNull();
  });

  it("merges front-matter task with body", () => {
    const specItem = item({
      id: "h_6",
      kind: "subagent",
      content: `---\nagent: coder\ntask: from front matter\n---\nfrom body`,
    });
    const result = parseSubagentSpec(specItem);
    expect(result).toEqual({
      agent: "coder",
      task: "from body",
    });
  });

  it("handles limits in front-matter", () => {
    const specItem = item({
      id: "h_7",
      kind: "subagent",
      content: `---\nagent: coder\ntask: do work\nlimits:\n  maxTurns: 10\n  maxTokens: 5000\n---\n`, // body is empty
    });
    const result = parseSubagentSpec(specItem);
    expect(result).toEqual({
      agent: "coder",
      task: "do work", // body is empty, so front-matter task is used
      limits: { maxTurns: 10, maxTokens: 5000 },
    });
  });
});

describe("orchestrator registry", () => {
  beforeEach(() => {
    // Clear registry by re-importing would be ideal, but we can't easily do that.
    // Instead, we test the functions work.
  });

  it("registerOrchestrator and getOrchestrator work", () => {
    const customOrchestrator: SubagentOrchestrator = {
      name: "test",
      isAvailable: () => true,
      async execute() {
        return { runId: "test", agent: "test", async: false, status: "completed", output: undefined, error: undefined, startedAt: Date.now(), finishedAt: undefined };
      },
    };
    registerOrchestrator(customOrchestrator);
    expect(getOrchestrator("test")).toBe(customOrchestrator);
    expect(listOrchestrators()).toContain("test");
  });

  it("getOrchestrator returns first registered as default", () => {
    const first = getOrchestrator();
    expect(first).toBeDefined();
  });
});

describe("maybeExecuteSkill", () => {
  it("returns null for non-executable skill (no front-matter)", async () => {
    const skillItem = item({
      id: "h_skill1",
      kind: "skill",
      content: "This is just a description of a skill",
    });
    const ctx = {} as any; // ExtensionContext mock
    const result = await maybeExecuteSkill(ctx, skillItem);
    expect(result).toBeNull();
  });

  it("returns null for skill without language", async () => {
    const skillItem = item({
      id: "h_skill2",
      kind: "skill",
      content: `---\nentryPoint: main\n---\ncode here`,
    });
    const ctx = {} as any;
    const result = await maybeExecuteSkill(ctx, skillItem);
    expect(result).toBeNull();
  });

  it("returns null for skill without code", async () => {
    const skillItem = item({
      id: "h_skill3",
      kind: "skill",
      content: `---\nlanguage: typescript\nentryPoint: main\n---\n`,
    });
    const ctx = {} as any;
    const result = await maybeExecuteSkill(ctx, skillItem);
    expect(result).toBeNull();
  });

  // Note: Full execution tests would require spawning processes, which is slow/flaky in unit tests.
  // Integration tests would be better suited for that.
});

describe("SkillExecutionResult type", () => {
  it("accepts error as string | undefined", () => {
    const result: SkillExecutionResult = { output: "ok", error: undefined, exitCode: 0 };
    expect(result.error).toBeUndefined();
    const result2: SkillExecutionResult = { output: "ok", error: "failed", exitCode: 1 };
    expect(result2.error).toBe("failed");
  });
});