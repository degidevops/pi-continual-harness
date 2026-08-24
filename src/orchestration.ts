// Sub-agent orchestration layer — bridges harness `subagent` items to actual execution.
//
// Design:
//  - `SubagentOrchestrator` interface: abstract backend (pi-subagents, pi-boss, custom...)
//  - Default implementation uses pi-subagents' `subagent` tool via steering message
//  - `registerOrchestrator()` extension point for custom backends
//  - `executeSubagentSpec()` reads a harness `subagent` item and spawns accordingly
//  - `maybeExecuteSkill()` checks if a `skill` item contains executable code and runs it
//
// The orchestrator is invoked via a hook in harness_mutate (see tools.ts) when
// subagent/skill items are created/updated. This closes the loop: spec in harness ->
// live execution -> outcome -> evidence back to harness.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { HarnessItem } from "./types.js";

/** Result of executing a sub-agent spec. */
export interface SubagentExecutionResult {
  /** Unique run ID for tracking/correlation. */
  runId: string;
  /** The agent that was spawned (or workflow identifier). */
  agent: string;
  /** Whether the execution was async (background) or sync. */
  async: boolean;
  /** Final status. */
  status: "started" | "completed" | "failed" | "cancelled";
  /** Output text (truncated for sync, full for async notification). */
  output: string | undefined;
  /** Error if failed. */
  error: string | undefined;
  /** Timestamp when started. */
  startedAt: number;
  /** Timestamp when finished (if completed). */
  finishedAt: number | undefined;
}

/** A parsed sub-agent specification from a harness item. */
export interface SubagentSpec {
  /** Agent name/ID to spawn (must be registered in pi-subagents). */
  agent: string;
  /** Task/prompt for the sub-agent. */
  task: string;
  /** Optional workflow script for complex orchestration. */
  workflowScript?: string;
  /** Run async (background) vs sync (foreground). Default: true. */
  async?: boolean;
  /** Additional context to pass. */
  context?: Record<string, unknown>;
  /** Resource limits. */
  limits?: {
    maxTurns?: number;
    maxTokens?: number;
    timeoutMs?: number;
  };
}

/** Parse a harness `subagent` item content into a SubagentSpec.
 *  Supports multiple formats:
 *  1. YAML front-matter + task body
 *  2. JSON
 *  3. Simple plain text (treated as task, agent defaults to "default") */
export function parseSubagentSpec(item: HarnessItem): SubagentSpec | null {
  const rawContent = item.content;
  if (!rawContent || !rawContent.trim()) return null;

  // Try YAML front-matter (allow optional trailing newline after closing ---)
  const yamlMatch = rawContent.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (yamlMatch) {
    try {
      const frontMatter = yamlMatch[1]!;
      const body = (yamlMatch[2] || "").trim();
      const parsed = parseYaml(frontMatter);
      // Body overrides front-matter task if present
      const task = body || (parsed.task as string) || "";
      return { ...parsed, task } as SubagentSpec;
    } catch {
      // fall through
    }
  }

  // Try JSON
  if (rawContent.startsWith("{") || rawContent.startsWith("[")) {
    try {
      const parsed = JSON.parse(rawContent);
      if (parsed.task || parsed.workflowScript) {
        return parsed as SubagentSpec;
      }
    } catch {
      // fall through
    }
  }

  // Plain text: treat as task, need agent name from somewhere
  // Convention: first line = agent name, rest = task
  const lines = rawContent.split("\n");
  if (lines.length >= 2) {
    const agent = lines[0]!.trim();
    const task = lines.slice(1).join("\n").trim();
    if (agent && task) {
      return { agent, task };
    }
  }

  // Fallback: just task, agent will be resolved at runtime
  return { agent: "default", task: rawContent.trim() };
}

export function parseYaml(text: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const match = line.match(/^(\w+):\s*(.*)$/);
    if (match) {
      const key = match[1]!;
      let value: unknown = match[2]!.trim();
      // Check for nested object (indented lines following)
      if (value === "" && i + 1 < lines.length) {
        const nextLine = lines[i + 1]!;
        if (nextLine.startsWith("  ") || nextLine.startsWith("\t")) {
          // Parse nested object
          const nested: Record<string, unknown> = {};
          i++;
          while (i < lines.length) {
            const nestedLine = lines[i]!;
            const nestedMatch = nestedLine.match(/^\s+(\w+):\s*(.*)$/);
            if (!nestedMatch) break;
            const nestedKey = nestedMatch[1]!;
            let nestedValue: unknown = nestedMatch[2]!.trim();
            if ((nestedValue as string).startsWith('"') && (nestedValue as string).endsWith('"')) {
              nestedValue = (nestedValue as string).slice(1, -1);
            } else if ((nestedValue as string).startsWith("'") && (nestedValue as string).endsWith("'")) {
              nestedValue = (nestedValue as string).slice(1, -1);
            }
            if (/^\d+$/.test(nestedValue as string)) nestedValue = Number(nestedValue);
            else if (nestedValue === "true") nestedValue = true;
            else if (nestedValue === "false") nestedValue = false;
            nested[nestedKey] = nestedValue;
            i++;
          }
          value = nested;
          result[key] = value;
          i++;
          continue;
        }
      }
      // Strip quotes
      if ((value as string).startsWith('"') && (value as string).endsWith('"')) {
        value = (value as string).slice(1, -1);
      } else if ((value as string).startsWith("'") && (value as string).endsWith("'")) {
        value = (value as string).slice(1, -1);
      }
      // Parse numbers/booleans
      if (/^\d+$/.test(value as string)) value = Number(value);
      else if (value === "true") value = true;
      else if (value === "false") value = false;
      result[key] = value;
    }
    i++;
  }
  return result;
}

/** Interface for sub-agent orchestration backends. */
export interface SubagentOrchestrator {
  readonly name: string;
  /** Check if this orchestrator is available (e.g., pi-subagents extension loaded). */
  isAvailable(ctx: ExtensionContext): boolean;
  /** Execute a sub-agent spec. Returns a run ID for tracking. */
  execute(ctx: ExtensionContext, spec: SubagentSpec): Promise<SubagentExecutionResult>;
  /** Cancel a running sub-agent by run ID. */
  cancel?(ctx: ExtensionContext, runId: string): Promise<boolean>;
  /** Get status of a running sub-agent. */
  getStatus?(ctx: ExtensionContext, runId: string): Promise<SubagentExecutionResult | null>;
}

/** Registry of orchestrators. */
const orchestratorRegistry = new Map<string, SubagentOrchestrator>();

/** Register an orchestrator. First registered becomes default. */
export function registerOrchestrator(orchestrator: SubagentOrchestrator): void {
  orchestratorRegistry.set(orchestrator.name, orchestrator);
}

/** Get an orchestrator by name, or the default (first registered). */
export function getOrchestrator(name?: string): SubagentOrchestrator | undefined {
  if (name) return orchestratorRegistry.get(name);
  return orchestratorRegistry.values().next().value;
}

/** List registered orchestrators. */
export function listOrchestrators(): string[] {
  return [...orchestratorRegistry.keys()];
}

/** Execute a sub-agent spec using the default/registered orchestrator. */
export async function executeSubagentSpec(
  ctx: ExtensionContext,
  spec: SubagentSpec,
  orchestratorName?: string,
): Promise<SubagentExecutionResult> {
  const orchestrator = getOrchestrator(orchestratorName);
  if (!orchestrator) {
    throw new Error(`No subagent orchestrator registered${orchestratorName ? ` (tried "${orchestratorName}")` : ""}. Install pi-subagents or register a custom orchestrator.`);
  }
  if (!orchestrator.isAvailable(ctx)) {
    throw new Error(`Orchestrator "${orchestrator.name}" is not available in this context.`);
  }
  return orchestrator.execute(ctx, spec);
}

/** Check if a skill item contains executable code and run it.
 *  Skill format for executable code:
 *  ---
 *  language: typescript | javascript | python | shell
 *  entryPoint: functionName | main
 *  ---
 *  // code here
 *
 *  Returns execution result or null if not executable. */
export interface SkillExecutionResult {
  output: string;
  error: string | undefined;
  exitCode: number;
}

export async function maybeExecuteSkill(
  ctx: ExtensionContext,
  item: HarnessItem,
  args: Record<string, unknown> = {},
): Promise<SkillExecutionResult | null> {
  const content = item.content.trim();
  if (!content) return null;

  // Check for executable skill format (YAML front-matter with language)
  const yamlMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!yamlMatch) return null;

  try {
    const frontMatter = parseYaml(yamlMatch[1]!);
    const code = yamlMatch[2]!.trim();
    const language = frontMatter.language as string | undefined;
    const entryPoint = (frontMatter.entryPoint as string) ?? "main";

    if (!language || !code) return null;

    // entryPoint is interpolated into generated JS/TS wrappers, so it MUST be a
    // plain identifier — anything else would let item content inject code into
    // the wrapper itself.
    if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(entryPoint)) return null;

    // Execute based on language
    switch (language.toLowerCase()) {
      case "typescript":
      case "ts":
        return await executeTypeScript(code, entryPoint, args, ctx);
      case "javascript":
      case "js":
        return await executeJavaScript(code, entryPoint, args, ctx);
      case "python":
      case "py":
        return await executePython(code, entryPoint, args, ctx);
      case "shell":
      case "bash":
      case "sh":
        return await executeShell(code, args, ctx);
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ---- Language executors (spawn + timeout, no isolation) ----

async function executeTypeScript(
  code: string,
  entryPoint: string,
  args: Record<string, unknown>,
  _ctx: ExtensionContext,
): Promise<SkillExecutionResult> {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");

  const dir = await mkdtemp(join(tmpdir(), "pi-skill-"));
  const file = join(dir, "skill.ts");

  // Wrap code with entry point call. Args cross the boundary as a JSON string
  // literal (JSON.stringify of the JSON string), never by raw interpolation,
  // so argument content cannot break out of the wrapper.
  const wrappedCode = `${code}\n\n// Auto-invocation\nconst args = JSON.parse(${JSON.stringify(JSON.stringify(args))});\nconst result = await ${entryPoint}(args);\nconsole.log(JSON.stringify(result));`;

  await writeFile(file, wrappedCode, "utf8");

  return new Promise((resolve) => {
    const child = spawn("npx", ["tsx", file], { cwd: dir, timeout: 30000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({ output: stdout.trim(), error: stderr.trim() || undefined, exitCode: code ?? 1 });
    });
    child.on("error", (err) => {
      resolve({ output: "", error: err.message, exitCode: 1 });
    });
  });
}

async function executeJavaScript(
  code: string,
  entryPoint: string,
  args: Record<string, unknown>,
  _ctx: ExtensionContext,
): Promise<SkillExecutionResult> {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");

  const dir = await mkdtemp(join(tmpdir(), "pi-skill-"));
  const file = join(dir, "skill.mjs");

  const wrappedCode = `${code}\n\nconst args = JSON.parse(${JSON.stringify(JSON.stringify(args))});\nconst result = await ${entryPoint}(args);\nconsole.log(JSON.stringify(result));`;

  await writeFile(file, wrappedCode, "utf8");

  return new Promise((resolve) => {
    const child = spawn("node", [file], { cwd: dir, timeout: 30000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({ output: stdout.trim(), error: stderr.trim() || undefined, exitCode: code ?? 1 });
    });
    child.on("error", (err) => {
      resolve({ output: "", error: err.message, exitCode: 1 });
    });
  });
}

async function executePython(
  code: string,
  entryPoint: string,
  args: Record<string, unknown>,
  _ctx: ExtensionContext,
): Promise<SkillExecutionResult> {
  const { writeFile, mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { spawn } = await import("node:child_process");

  const dir = await mkdtemp(join(tmpdir(), "pi-skill-"));
  // Args are passed via a side-car JSON file, never interpolated into the
  // wrapper source (string interpolation there would be an injection vector).
  await writeFile(join(dir, "args.json"), JSON.stringify(args), "utf8");
  const wrappedFile = join(dir, "run.py");
  await writeFile(wrappedFile, `${code}\n\nimport json\nwith open("args.json") as _f:\n    args = json.load(_f)\nresult = ${entryPoint}(args)\nprint(json.dumps(result))\n`, "utf8");

  return new Promise((resolve) => {
    const child = spawn("python3", [wrappedFile], { cwd: dir, timeout: 30000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({ output: stdout.trim(), error: stderr.trim() || undefined, exitCode: code ?? 1 });
    });
    child.on("error", (err) => {
      resolve({ output: "", error: err.message, exitCode: 1 });
    });
  });
}

async function executeShell(
  code: string,
  args: Record<string, unknown>,
  _ctx: ExtensionContext,
): Promise<SkillExecutionResult> {
  const { spawn } = await import("node:child_process");
  // Pass args as environment variables
  const env = { ...process.env, ...Object.fromEntries(Object.entries(args).map(([k, v]) => [k.toUpperCase(), String(v)])) };

  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", code], { env, timeout: 30000 });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (d) => (stdout += d.toString()));
    child.stderr?.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      resolve({ output: stdout.trim(), error: stderr.trim() || undefined, exitCode: code ?? 1 });
    });
    child.on("error", (err) => {
      resolve({ output: "", error: err.message, exitCode: 1 });
    });
  });
}

/** Default orchestrator using pi-subagents' `subagent` tool via steering message. */
export function createPiSubagentsOrchestrator(pi: ExtensionAPI): SubagentOrchestrator {
  return {
    name: "pi-subagents",
    isAvailable(ctx: ExtensionContext) {
      // Check if the subagent tool is registered
      const tools = pi.getActiveTools();
      return tools.includes("subagent");
    },
    async execute(ctx: ExtensionContext, spec: SubagentSpec): Promise<SubagentExecutionResult> {
      const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const startedAt = Date.now();

      // Build a steering message that instructs the agent to call the subagent tool
      const params: Record<string, unknown> = {
        agent: spec.agent,
        task: spec.task,
      };
      if (spec.workflowScript) params.workflowScript = spec.workflowScript;
      if (spec.async !== undefined) params.async = spec.async;
      if (spec.context) params.context = spec.context;
      if (spec.limits?.maxTurns) params.maxTurns = spec.limits.maxTurns;
      if (spec.limits?.maxTokens) params.maxOutputTokens = spec.limits.maxTokens;
      if (spec.limits?.timeoutMs) params.timeoutMs = spec.limits.timeoutMs;

      const steeringMessage = [
        `/harness subagent:execute ${runId}`,
        "",
        `Execute sub-agent spec via the \`subagent\` tool:`,
        "",
        `\`\`\`json\n${JSON.stringify(params, null, 2)}\n\`\`\``,
        "",
        `This is an automated orchestration request. The agent should call the \`subagent\` tool with the above parameters.`,
      ].join("\n");

      // Send as a steering message (deliverAs: "steer" queues it for the current turn)
      pi.sendUserMessage(steeringMessage, { deliverAs: "steer" });

      // Return immediately with "started" status - actual completion is async via tool result
      return {
        runId,
        agent: spec.agent,
        async: spec.async ?? true,
        status: "started",
        output: undefined,
        error: undefined,
        startedAt,
        finishedAt: undefined,
      };
    },
  };
}

/** Auto-register pi-subagents orchestrator when the extension loads. */
export function registerDefaultOrchestrator(pi: ExtensionAPI): void {
  // Defer registration until pi-subagents might be loaded
  // We try to register on first use via getOrchestrator lazy init
  // But also provide this helper for explicit registration
  registerOrchestrator(createPiSubagentsOrchestrator(pi));
}