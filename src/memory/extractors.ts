/**
 * Deterministic extractors that auto-populate memory from tool results.
 * Most are pure regex / JSON.parse. The edit_event extractor can optionally
 * use a lightweight LLM for high-signal synthesis when context is available.
 */

import { editPairs } from "../tools/edit.js";
import { pickLlmAuth, type LlmAuth } from "../agent/llm-auth.js";
import { isAbsolute, relative } from "node:path";
import { runKimi } from "../agent/client.js";
import type { ChatMessage } from "../agent/messages.js";
import type { MemoryCategory } from "./schema.js";

export interface ExtractorContext {
  /** Arguments passed to the tool (e.g. old_string, new_string, path). */
  toolArgs?: Record<string, unknown>;
  /** Working directory, used to normalize absolute paths to repo-relative ones. */
  cwd?: string;
  /** The assistant message that triggered this tool call. */
  assistantMessage?: string;
  /** LLM opts for synthesis (credentials + model). */
  llmOpts?: LlmAuth & {
    model: string;
    signal?: AbortSignal;
  };
}

export interface Extractor {
  /** Unique identifier for this extractor */
  id: string;
  /** Check if this extractor applies to a given tool call */
  match: (toolName: string, filePath: string | undefined) => boolean;
  /** Extract memory content from the tool result. Returns null if nothing to extract. */
  extract: (
    content: string,
    filePath: string | undefined,
    ctx?: ExtractorContext,
  ) => Promise<{
    content: string;
    category: MemoryCategory;
    importance: number;
    topicKey: string;
    relatedFiles?: string[];
  } | null> | {
    content: string;
    category: MemoryCategory;
    importance: number;
    topicKey: string;
    relatedFiles?: string[];
  } | null;
}

function safeJsonParse<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str;
  return str.slice(0, max) + "…";
}

/** Strip the read tool's "  12\t" line-number prefix so JSON files parse. */
export function stripLineNumbers(content: string): string {
  return content.replace(/^\s*\d+\t/gm, "");
}

/** Prefer a repo-relative path so the same file edited via absolute and
 *  relative paths maps to one topic key. */
function normalizeFile(file: string, cwd?: string): string {
  if (!cwd || !isAbsolute(file)) return file;
  const rel = relative(cwd, file);
  return rel.startsWith("..") ? file : rel;
}

const EDIT_SYNTHESIS_SYSTEM = `You summarize a SINGLE code edit. Write ONE concise sentence (max 20 words) describing exactly what changed.

Rules:
- Use ONLY the Before/After diff below.
- For new files: describe the file's content or purpose. Never say just "added a new file".
- For edits: describe the specific code change.

Examples:
- Created test-memory.md containing the text "Memory test".
- Fixed race condition in loop.ts by adding AbortSignal guard.
- Added vitest dependency and removed jest from package.json.

Respond with only the summary sentence. No quotes, no preamble.`;

const VERIFIER_SYSTEM = `You verify whether a summary accurately describes a code edit.
Answer exactly "yes" if the summary correctly captures what changed in the file.
Answer exactly "no" if the summary is vague, wrong, or misses the actual change.

Respond with only "yes" or "no".`;

async function callLlm(
  messages: ChatMessage[],
  llmOpts: ExtractorContext["llmOpts"],
  maxTokens = 64,
): Promise<string> {
  if (!llmOpts) return "";
  const events = runKimi({
    ...pickLlmAuth(llmOpts),
    model: llmOpts.model,
    messages,
    temperature: 0.1,
    maxCompletionTokens: maxTokens,
    signal: llmOpts.signal,
  });
  let text = "";
  for await (const ev of events) {
    if (ev.type === "text") text += ev.delta;
  }
  return text.trim().replace(/^["']|["']$/g, "").replace(/\s+/g, " ").toLowerCase();
}

async function synthesizeEditEvent(
  file: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  assistantMessage: string | undefined,
  llmOpts: ExtractorContext["llmOpts"],
): Promise<string | null> {
  if (!llmOpts) return null;

  const pairs = editPairs(toolArgs);
  const oldString = pairs.map((p) => p.old_string).join("\n…\n");
  const newString = pairs.map((p) => p.new_string).join("\n…\n");
  const fullContent = typeof toolArgs.content === "string" ? toolArgs.content : "";

  const isWrite = toolName === "write";
  const before = isWrite ? "(new file)" : truncate(oldString, 600);
  const after = isWrite ? truncate(fullContent, 600) : truncate(newString, 600);
  const intent = assistantMessage ? assistantMessage.slice(-300).trim() : "";

  const changeContext = `File: ${file}\nTool: ${toolName}\n\nBefore:\n${before}\n\nAfter:\n${after}${intent ? `\n\nContext: ${intent}` : ""}`;

  // --- Attempt 1 ---
  const summary1 = await callLlm(
    [
      { role: "system", content: EDIT_SYNTHESIS_SYSTEM },
      { role: "user", content: `${changeContext}\n\nSummary:` },
    ],
    llmOpts,
  );

  if (summary1.length >= 10 && summary1.length <= 200) {
    const verdict = await callLlm(
      [
        { role: "system", content: VERIFIER_SYSTEM },
        {
          role: "user",
          content: `${changeContext}\n\nProposed summary: "${summary1}"\n\nIs this accurate?`,
        },
      ],
      llmOpts,
      8,
    );
    if (verdict.startsWith("yes")) return summary1;
  }

  // --- Attempt 2 (stronger prompt) ---
  const retrySystem = `${EDIT_SYNTHESIS_SYSTEM}\n\nCRITICAL: The previous summary was rejected. Be specific. Include concrete details from the After section.`;
  const summary2 = await callLlm(
    [
      { role: "system", content: retrySystem },
      { role: "user", content: `${changeContext}\n\nSummary:` },
    ],
    llmOpts,
  );

  if (summary2.length >= 10 && summary2.length <= 200) {
    const verdict2 = await callLlm(
      [
        { role: "system", content: VERIFIER_SYSTEM },
        {
          role: "user",
          content: `${changeContext}\n\nProposed summary: "${summary2}"\n\nIs this accurate?`,
        },
      ],
      llmOpts,
      8,
    );
    if (verdict2.startsWith("yes")) return summary2;
  }

  return null;
}

export const EXTRACTORS: Extractor[] = [
  {
    id: "package_json",
    match: (tool, file) => tool === "read" && /package\.json$/.test(file || ""),
    extract: (content, file) => {
      const pkg = safeJsonParse<Record<string, unknown>>(stripLineNumbers(content));
      if (!pkg) return null;
      const deps = Object.keys((pkg.dependencies as Record<string, unknown>) || {}).slice(0, 10);
      const devDeps = Object.keys((pkg.devDependencies as Record<string, unknown>) || {}).slice(0, 5);
      const scripts = Object.keys((pkg.scripts as Record<string, unknown>) || {}).slice(0, 5);
      return {
        content: `Project dependencies: ${deps.join(", ") || "none"}. Dev dependencies: ${devDeps.join(", ") || "none"}. Scripts: ${scripts.join(", ") || "none"}. Type: ${(pkg.type as string) || "commonjs"}.`,
        category: "fact",
        importance: 4,
        topicKey: "project_dependencies",
        relatedFiles: file ? [file] : undefined,
      };
    },
  },
  {
    id: "tsconfig",
    match: (tool, file) => tool === "read" && /tsconfig.*\.json$/.test(file || ""),
    extract: (content, file) => {
      const ts = safeJsonParse<Record<string, unknown>>(stripLineNumbers(content));
      if (!ts) return null;
      const opts = (ts.compilerOptions as Record<string, unknown>) || {};
      return {
        content: `TypeScript config: target=${(opts.target as string) || "default"}, module=${(opts.module as string) || "default"}, strict=${opts.strict || false}, jsx=${(opts.jsx as string) || "none"}.`,
        category: "fact",
        importance: 4,
        topicKey: "project_tsconfig",
        relatedFiles: file ? [file] : undefined,
      };
    },
  },
  {
    id: "entry_point",
    match: (tool, file) => tool === "read" && /src\/(index|main)\.(ts|tsx|js|jsx)$/.test(file || ""),
    extract: (content, file, ctx) => {
      const exports = content.match(/export\s+(?:default\s+)?(?:function|class|const|interface|type)\s+(\w+)/g);
      const exportNames = exports
        ? exports.map((e) => e.split(/\s+/).pop()).filter((n): n is string => !!n).slice(0, 5)
        : [];
      const rel = file ? normalizeFile(file, ctx?.cwd) : file;
      const safeKey = (rel || "unknown").replace(/[^a-zA-Z0-9]/g, "_");
      return {
        content: `Entry point ${rel} exports: ${exportNames.join(", ") || "default export or side effects"}.`,
        category: "fact",
        importance: 3,
        // One key per entry point. A single shared key made every entry point
        // supersede the previous one (112 stored, 1 active in kimi-code).
        topicKey: `project_entry_point_${safeKey}`,
        relatedFiles: rel ? [rel] : undefined,
      };
    },
  },
  {
    id: "edit_event",
    match: (tool, file) => (tool === "edit" || tool === "write") && !!file,
    extract: async (_content, file, ctx) => {
      if (!file) return null;
      const rel = normalizeFile(file, ctx?.cwd);
      const safeKey = rel.replace(/[^a-zA-Z0-9]/g, "_");

      // Try LLM synthesis when we have context
      if (ctx?.llmOpts && (ctx.toolArgs || ctx.assistantMessage)) {
        const summary = await synthesizeEditEvent(
          rel,
          ctx.toolArgs?._toolName as string || "edit",
          ctx.toolArgs || {},
          ctx.assistantMessage,
          ctx.llmOpts,
        );
        if (summary) {
          return {
            content: summary,
            category: "event",
            importance: 3,
            topicKey: `event_edit_${safeKey}`,
            relatedFiles: [rel],
          };
        }
      }

      // Fallback to deterministic low-signal memory
      return {
        content: `File modified: ${rel}.`,
        category: "event",
        importance: 2,
        topicKey: `event_edit_${safeKey}`,
        relatedFiles: [rel],
      };
    },
  },
];
