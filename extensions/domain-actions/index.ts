// Domain-specific primitive actions for pi-continual-harness
//
// This extension provides a set of domain-specific tools that replace the generic
// read/write/edit/bash with actions tailored to the target domain (e.g., web research,
// code analysis, file operations, API calls).
//
// The key idea from the proposal (B1): pi-continual-harness only manages self-knowledge
// (p/K/M/G). The actual "action surface" for the domain is built separately as a
// pi extension with primitive actions matching the domain's needs.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { fetch_content, web_search, source_check, get_search_content } from "@pi-tools/research"; // hypothetical research tools

// ---- Web Research Actions ----

const webSearchTool = {
  name: "web_search",
  label: "Web Search",
  description: "Search the web for information using multiple providers. Returns synthesized answer with citations.",
  parameters: Type.Object({
    query: Type.String({ description: "Search query" }),
    numResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 5 })),
    recencyFilter: Type.Optional(Type.Union([Type.Literal("day"), Type.Literal("week"), Type.Literal("month"), Type.Literal("year")])),
    domainFilter: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(_toolCallId: string, params: { query: string; numResults?: number; recencyFilter?: string; domainFilter?: string[] }, ctx: ExtensionContext) {
    const result = await web_search({
      query: params.query,
      numResults: params.numResults,
      recencyFilter: params.recencyFilter as any,
      domainFilter: params.domainFilter,
    });
    return {
      content: [{ type: "text", text: result.answer }],
      details: { sources: result.sources },
    };
  },
};

const fetchContentTool = {
  name: "fetch_content",
  label: "Fetch Content",
  description: "Fetch full content from URLs (web pages, GitHub repos, PDFs, videos).",
  parameters: Type.Object({
    url: Type.String({ description: "URL to fetch" }),
    mode: Type.Optional(Type.Union([Type.Literal("readable"), Type.Literal("raw"), Type.Literal("answer")])),
    prompt: Type.Optional(Type.String({ description: "Question to answer using fetched content (mode=answer)" })),
  }),
  async execute(_toolCallId: string, params: { url: string; mode?: string; prompt?: string }, ctx: ExtensionContext) {
    const result = await fetch_content({
      url: params.url,
      mode: (params.mode as any) ?? "readable",
      prompt: params.prompt,
    });
    return {
      content: [{ type: "text", text: result.content }],
      details: { url: params.url },
    };
  },
};

const sourceCheckTool = {
  name: "source_check",
  label: "Source Check",
  description: "Verify a claim against web sources with passage-level citations.",
  parameters: Type.Object({
    claim: Type.String({ description: "Claim to verify" }),
    numResults: Type.Optional(Type.Number({ minimum: 1, maximum: 20, default: 5 })),
  }),
  async execute(_toolCallId: string, params: { claim: string; numResults?: number }, ctx: ExtensionContext) {
    const result = await source_check({
      claim: params.claim,
      numResults: params.numResults,
    });
    return {
      content: [{ type: "text", text: result.answer }],
      details: { verdict: result.verdict, citations: result.citations },
    };
  },
};

const getSearchContentTool = {
  name: "get_search_content",
  label: "Get Search Content",
  description: "Retrieve full content from a previous web_search/source_check/fetch_content call.",
  parameters: Type.Object({
    responseId: Type.String({ description: "Response ID from previous search" }),
    query: Type.Optional(Type.String()),
    url: Type.Optional(Type.String()),
    findText: Type.Optional(Type.Union([Type.String(), Type.Array(Type.String())])),
  }),
  async execute(_toolCallId: string, params: { responseId: string; query?: string; url?: string; findText?: string | string[] }, ctx: ExtensionContext) {
    const result = await get_search_content({
      responseId: params.responseId,
      query: params.query,
      url: params.url,
      findText: params.findText,
    });
    return {
      content: [{ type: "text", text: result.content }],
      details: {},
    };
  },
};

// ---- Code Analysis Actions ----

const analyzeCodeTool = {
  name: "analyze_code",
  label: "Analyze Code",
  description: "Analyze code structure, complexity, and patterns. Returns structured metrics.",
  parameters: Type.Object({
    path: Type.String({ description: "File or directory path to analyze" }),
    metrics: Type.Optional(Type.Array(Type.Union([Type.Literal("complexity"), Type.Literal("dependencies"), Type.Literal("test-coverage"), Type.Literal("duplication")]))),
  }),
  async execute(_toolCallId: string, params: { path: string; metrics?: string[] }, ctx: ExtensionContext) {
    // This would integrate with actual code analysis tools (ESLint, TypeScript compiler API, etc.)
    // For now, return a placeholder structure
    return {
      content: [{ type: "text", text: `Code analysis for ${params.path} (metrics: ${params.metrics?.join(", ") ?? "all"})` }],
      details: { path: params.path, metrics: params.metrics },
    };
  },
};

const refactorCodeTool = {
  name: "refactor_code",
  label: "Refactor Code",
  description: "Apply automated refactoring (extract function, rename, inline, etc.)",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
    refactorType: Type.Union([Type.Literal("extract-function"), Type.Literal("rename"), Type.Literal("inline"), Type.Literal("extract-variable")]),
    selection: Type.Optional(Type.Object({ startLine: Type.Number(), endLine: Type.Number() })),
    newName: Type.Optional(Type.String()),
  }),
  async execute(_toolCallId: string, params: { path: string; refactorType: string; selection?: { startLine: number; endLine: number }; newName?: string }, ctx: ExtensionContext) {
    // This would use TypeScript Language Service or similar
    return {
      content: [{ type: "text", text: `Refactored ${params.path}: ${params.refactorType}` }],
      details: { path: params.path, refactorType: params.refactorType },
    };
  },
};

// ---- File Operations (domain-specific) ----

const readFileTool = {
  name: "read_file",
  label: "Read File",
  description: "Read a file with optional line range. Returns structured content.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to cwd)" }),
    offset: Type.Optional(Type.Number({ minimum: 0 })),
    limit: Type.Optional(Type.Number({ minimum: 1 })),
  }),
  async execute(_toolCallId: string, params: { path: string; offset?: number; limit?: number }, ctx: ExtensionContext) {
    const { readFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const fullPath = resolve(ctx.cwd, params.path);
    const content = await readFile(fullPath, "utf8");
    const lines = content.split("\n");
    const start = params.offset ?? 0;
    const end = params.limit ? start + params.limit : lines.length;
    const selected = lines.slice(start, end).join("\n");
    return {
      content: [{ type: "text", text: selected }],
      details: { path: params.path, lines: lines.length, range: `${start}-${end}` },
    };
  },
};

const writeFileTool = {
  name: "write_file",
  label: "Write File",
  description: "Create or overwrite a file. Returns confirmation.",
  parameters: Type.Object({
    path: Type.String({ description: "File path (relative to cwd)" }),
    content: Type.String({ description: "File content" }),
    createDirs: Type.Optional(Type.Boolean({ default: true })),
  }),
  async execute(_toolCallId: string, params: { path: string; content: string; createDirs?: boolean }, ctx: ExtensionContext) {
    const { writeFile, mkdir } = await import("node:fs/promises");
    const { dirname, resolve } = await import("node:path");
    const fullPath = resolve(ctx.cwd, params.path);
    if (params.createDirs) await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, params.content, "utf8");
    return {
      content: [{ type: "text", text: `Written ${params.path}` }],
      details: { path: params.path },
    };
  },
};

const editFileTool = {
  name: "edit_file",
  label: "Edit File",
  description: "Make precise edits to a file using exact text replacement.",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
    edits: Type.Array(Type.Object({
      oldText: Type.String({ description: "Exact text to replace" }),
      newText: Type.String({ description: "Replacement text" }),
    }), { minItems: 1 }),
  }),
  async execute(_toolCallId: string, params: { path: string; edits: { oldText: string; newText: string }[] }, ctx: ExtensionContext) {
    const { readFile, writeFile } = await import("node:fs/promises");
    const { resolve } = await import("node:path");
    const fullPath = resolve(ctx.cwd, params.path);
    let content = await readFile(fullPath, "utf8");
    for (const edit of params.edits) {
      if (!content.includes(edit.oldText)) {
        throw new Error(`Edit not found: ${edit.oldText.slice(0, 50)}...`);
      }
      content = content.replace(edit.oldText, edit.newText);
    }
    await writeFile(fullPath, content, "utf8");
    return {
      content: [{ type: "text", text: `Edited ${params.path} (${params.edits.length} change(s))` }],
      details: { path: params.path, edits: params.edits.length },
    };
  },
};

// ---- Task Management Actions ----

const createTaskTool = {
  name: "create_task",
  label: "Create Task",
  description: "Create a structured task with acceptance criteria for tracking.",
  parameters: Type.Object({
    title: Type.String({ description: "Task title" }),
    description: Type.String({ description: "Task description" }),
    acceptanceCriteria: Type.Optional(Type.Array(Type.String())),
    priority: Type.Optional(Type.Union([Type.Literal("low"), Type.Literal("medium"), Type.Literal("high"), Type.Literal("critical")])),
    tags: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(_toolCallId: string, params: { title: string; description: string; acceptanceCriteria?: string[]; priority?: string; tags?: string[] }, ctx: ExtensionContext) {
    // In a real implementation, this would persist to a task store
    const taskId = `task_${Date.now().toString(36)}`;
    return {
      content: [{ type: "text", text: `Created task ${taskId}: ${params.title}` }],
      details: { taskId, ...params },
    };
  },
};

const updateTaskTool = {
  name: "update_task",
  label: "Update Task",
  description: "Update task status, progress, or details.",
  parameters: Type.Object({
    taskId: Type.String({ description: "Task ID" }),
    status: Type.Optional(Type.Union([Type.Literal("pending"), Type.Literal("in-progress"), Type.Literal("done"), Type.Literal("blocked")])),
    progress: Type.Optional(Type.Number({ minimum: 0, maximum: 100 })),
    notes: Type.Optional(Type.String()),
  }),
  async execute(_toolCallId: string, params: { taskId: string; status?: string; progress?: number; notes?: string }, ctx: ExtensionContext) {
    return {
      content: [{ type: "text", text: `Updated task ${params.taskId}` }],
      details: params,
    };
  },
};

// ---- Export all tools ----

export const DOMAIN_ACTIONS = [
  // Web research
  webSearchTool,
  fetchContentTool,
  sourceCheckTool,
  getSearchContentTool,
  // Code analysis
  analyzeCodeTool,
  refactorCodeTool,
  // File operations
  readFileTool,
  writeFileTool,
  editFileTool,
  // Task management
  createTaskTool,
  updateTaskTool,
] as const;

export default function domainActions(pi: ExtensionAPI): void {
  for (const tool of DOMAIN_ACTIONS) {
    pi.registerTool(tool as any);
  }
}