import type { MemoryManager } from "../memory/manager.js";
import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";

export interface MemoryToolContext extends ToolContext {
  memoryManager: MemoryManager | null;
  sessionId: string;
}

function isMemoryCtx(ctx: ToolContext): ctx is MemoryToolContext {
  return "memoryManager" in ctx;
}

export const memoryRememberTool: ToolSpec = {
  name: "memory_remember",
  description:
    "Store a persistent fact, instruction, or preference for future sessions. " +
    "Use when the user explicitly asks you to remember something, or when you learn a non-obvious project fact " +
    "that will be useful later (e.g., tech stack choices, style preferences, architectural decisions). " +
    "Do not use for ephemeral or obvious information. Keep content concise and self-contained.",
  parameters: {
    type: "object",
    properties: {
      content: {
        type: "string",
        description: "A concise, self-contained sentence describing the fact or preference (max 200 chars).",
      },
      category: {
        type: "string",
        enum: ["fact", "event", "instruction", "task", "preference"],
        description: "Category of the memory.",
      },
      importance: {
        type: "number",
        minimum: 1,
        maximum: 5,
        description: "Importance from 1 (trivial) to 5 (critical).",
      },
    },
    required: ["content", "category", "importance"],
  },
  needsPermission: false,
  render: (args: { content: string; category: string; importance: number }) => ({
    title: "memory_remember",
    body: `[${args.category ?? "unknown"}] ${args.content ?? ""} (importance: ${args.importance ?? 1})`,
  }),
  run: async (args: { content: string; category: string; importance: number }, ctx: ToolContext): Promise<ToolOutput> => {
    if (!isMemoryCtx(ctx) || !ctx.memoryManager) {
      return { content: "Memory is not enabled.", rawBytes: 0, reducedBytes: 0 };
    }
    const { content, category, importance } = args;
    const validCategories = ["fact", "event", "instruction", "task", "preference"] as const;
    if (!validCategories.includes(category as (typeof validCategories)[number])) {
      return { content: `Invalid category: ${category}`, rawBytes: 0, reducedBytes: 0 };
    }
    try {
      const result = await ctx.memoryManager.remember(
        content,
        category as (typeof validCategories)[number],
        importance,
        ctx.cwd,
        ctx.sessionId,
        ctx.signal
      );
      let msg = `Memory stored with id ${result.id}.`;
      if (result.superseded && result.superseded.length > 0) {
        msg += ` Superseded ${result.superseded.length} older memory(s).`;
      }
      const bytes = Buffer.byteLength(msg, "utf8");
      return { content: msg, rawBytes: bytes, reducedBytes: bytes };
    } catch (e) {
      const msg = `Failed to store memory: ${(e as Error).message}`;
      const bytes = Buffer.byteLength(msg, "utf8");
      return { content: msg, rawBytes: bytes, reducedBytes: bytes };
    }
  },
};

export const memoryRecallTool: ToolSpec = {
  name: "memory_recall",
  description:
    "Search your cross-session memory for relevant context. " +
    "Use when the user refers to previous decisions, preferences, or project history " +
    "(e.g., \"like we did last time\", \"what did we decide about auth?\"). " +
    "Pass the user's question directly — do not try to design a query.",
  parameters: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The user's question or reference to past context, verbatim.",
      },
      limit: {
        type: "number",
        minimum: 1,
        maximum: 10,
        description: "Maximum number of memories to return (default 5).",
      },
    },
    required: ["query"],
  },
  needsPermission: false,
  render: (args: { query: string; limit?: number }) => ({
    title: "memory_recall",
    body: `Query: "${args.query ?? ""}"`,
  }),
  run: async (args: { query: string; limit?: number }, ctx: ToolContext): Promise<ToolOutput> => {
    if (!isMemoryCtx(ctx) || !ctx.memoryManager) {
      return { content: "Memory is not enabled.", rawBytes: 0, reducedBytes: 0 };
    }
    try {
      const results = await ctx.memoryManager.recall({
        text: args.query,
        repoPath: ctx.cwd,
        limit: args.limit ?? 5,
      });
      if (results.length === 0) {
        return { content: "No relevant memories found.", rawBytes: 0, reducedBytes: 0 };
      }
      const lines = results.map((r) => {
        const files = r.memory.relatedFiles.length > 0 ? ` [${r.memory.relatedFiles.join(", ")}]` : "";
        return `- [${r.memory.category}] ${r.memory.content}${files} (id: ${r.memory.id}, importance: ${r.memory.importance})`;
      });
      const content = lines.join("\n");
      const bytes = Buffer.byteLength(content, "utf8");
      return { content, rawBytes: bytes, reducedBytes: bytes };
    } catch (e) {
      const msg = `Failed to recall memories: ${(e as Error).message}`;
      const bytes = Buffer.byteLength(msg, "utf8");
      return { content: msg, rawBytes: bytes, reducedBytes: bytes };
    }
  },
};

export const memoryForgetTool: ToolSpec = {
  name: "memory_forget",
  description:
    "Mark a memory as forgotten. Use when the user explicitly says something is no longer true " +
    "or asks you to forget a previous fact or preference. This does not delete the memory permanently — " +
    "it remains for audit but will not be returned in future recalls.",
  parameters: {
    type: "object",
    properties: {
      memory_id: {
        type: "string",
        description: "The ID of the memory to forget. You can obtain this from a previous memory_recall result.",
      },
    },
    required: ["memory_id"],
  },
  needsPermission: false,
  render: (args: { memory_id: string }) => ({
    title: "memory_forget",
    body: `Forgetting memory ${args.memory_id ?? ""}`,
  }),
  run: async (args: { memory_id: string }, ctx: ToolContext): Promise<ToolOutput> => {
    if (!isMemoryCtx(ctx) || !ctx.memoryManager) {
      return { content: "Memory is not enabled.", rawBytes: 0, reducedBytes: 0 };
    }
    const ok = await ctx.memoryManager.forget(args.memory_id);
    const msg = ok ? `Memory ${args.memory_id} marked as forgotten.` : `Memory ${args.memory_id} not found.`;
    const bytes = Buffer.byteLength(msg, "utf8");
    return { content: msg, rawBytes: bytes, reducedBytes: bytes };
  },
};
