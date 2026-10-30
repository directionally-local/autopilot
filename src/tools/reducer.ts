import { ToolArtifactStore } from "./artifact-store.js";

export interface ReducerConfig {
  enabled: boolean;
  grep: {
    maxTotalLines: number;
    maxMatchesPerFile: number;
    maxLineLength: number;
    maxOutputChars: number;
  };
  read: {
    maxOutlineLines: number;
    maxSliceLines: number;
    maxPreviewLines: number;
    maxOutputChars: number;
  };
  bash: {
    maxTotalLines: number;
    maxErrorBlockLines: number;
    maxTrailingLines: number;
    maxOutputChars: number;
    dedupeConsecutiveLines: boolean;
  };
  glob: {
    maxFiles: number;
    maxOutputChars: number;
  };
  webFetch: {
    maxChars: number;
    maxHeadingChars: number;
  };
  searchWeb: {
    maxChars: number;
    maxResults: number;
  };
  github: {
    maxChars: number;
  };
  browser: {
    maxChars: number;
  };
  lsp: {
    maxLines: number;
    maxOutputChars: number;
  };
  /** Fallback cap for any tool without a dedicated reducer. */
  defaultMaxChars: number;
}

const MIN_CONTEXT_OUTPUT_CHARS = 4_000;
const MAX_CONTEXT_OUTPUT_CHARS = 120_000;

/** Convert a model context window (tokens) into a conservative tool-output cap. */
export function toolOutputCapForContextWindow(contextWindow: number): number {
  if (!Number.isFinite(contextWindow) || contextWindow <= 0) return DEFAULT_REDUCER_CONFIG.defaultMaxChars;
  return Math.min(MAX_CONTEXT_OUTPUT_CHARS, Math.max(MIN_CONTEXT_OUTPUT_CHARS, Math.floor(contextWindow * 0.06)));
}

export function reducerConfigForContextWindow(contextWindow: number): ReducerConfig {
  const maxOutputChars = toolOutputCapForContextWindow(contextWindow);
  return {
    ...DEFAULT_REDUCER_CONFIG,
    read: {
      ...DEFAULT_REDUCER_CONFIG.read,
      maxOutputChars,
      maxSliceLines: Math.max(DEFAULT_REDUCER_CONFIG.read.maxSliceLines, Math.floor(maxOutputChars / 80)),
    },
  };
}

export const DEFAULT_REDUCER_CONFIG: ReducerConfig = {
  enabled: true,
  grep: {
    maxTotalLines: 50,
    maxMatchesPerFile: 3,
    maxLineLength: 200,
    maxOutputChars: 3000,
  },
  read: {
    maxOutlineLines: 60,
    maxSliceLines: 200,
    maxPreviewLines: 30,
    maxOutputChars: 4000,
  },
  bash: {
    maxTotalLines: 40,
    maxErrorBlockLines: 20,
    maxTrailingLines: 20,
    maxOutputChars: 4000,
    dedupeConsecutiveLines: true,
  },
  glob: {
    maxFiles: 1000,
    maxOutputChars: 20_000,
  },
  webFetch: {
    maxChars: 2000,
    maxHeadingChars: 500,
  },
  searchWeb: {
    maxChars: 3000,
    maxResults: 10,
  },
  github: {
    maxChars: 4000,
  },
  browser: {
    maxChars: 4000,
  },
  lsp: {
    maxLines: 50,
    maxOutputChars: 3000,
  },
  defaultMaxChars: 10_000,
};

export interface ReducedOutput {
  content: string;
  rawBytes: number;
  reducedBytes: number;
  artifactId: string;
}

/** Main entry: reduce raw tool output, store raw artifact, return reduced form. */
export function reduceToolOutput(
  toolName: string,
  raw: string,
  args: Record<string, unknown>,
  store: ToolArtifactStore,
  config: ReducerConfig = DEFAULT_REDUCER_CONFIG,
): ReducedOutput {
  const rawBytes = Buffer.byteLength(raw, "utf8");
  const artifactId = store.store(raw);

  if (!config.enabled) {
    return { content: raw, rawBytes, reducedBytes: rawBytes, artifactId };
  }

  let reduced: string;
  let wasReduced = false;
  let hint: string | undefined;

  switch (toolName) {
    case "grep": {
      const r = reduceGrep(raw, args, config.grep);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    case "read": {
      const r = reduceRead(raw, args, config.read);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    case "bash": {
      const r = reduceBash(raw, args, config.bash);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    case "glob": {
      const r = reduceGlob(raw, config.glob);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    case "web_fetch": {
      const r = reduceWebFetch(raw, args, config.webFetch);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    case "search_web": {
      const r = reduceSearchWeb(raw, args, config.searchWeb);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    case "github_read_pr":
    case "github_read_issue":
    case "github_read_code": {
      const r = reduceGithub(raw, config.github);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    case "browser_fetch": {
      const r = reduceBrowser(raw, config.browser);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    case "lsp_hover":
    case "lsp_definition":
    case "lsp_references":
    case "lsp_documentSymbols":
    case "lsp_workspaceSymbol":
    case "lsp_diagnostics":
    case "lsp_codeAction":
    case "lsp_implementation":
    case "lsp_typeDefinition": {
      const r = reduceLsp(raw, config.lsp);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
    default: {
      const r = reduceDefault(raw, config.defaultMaxChars);
      reduced = r.body;
      wasReduced = r.wasReduced;
      hint = r.hint;
      break;
    }
  }

  if (!wasReduced) {
    return { content: reduced, rawBytes, reducedBytes: rawBytes, artifactId };
  }

  const footer = `[output reduced — full raw stored as artifact ${artifactId}]`;
  const content = hint ? `${reduced}\n${footer}\n${hint}` : `${reduced}\n${footer}`;
  const reducedBytes = Buffer.byteLength(content, "utf8");
  return { content, rawBytes, reducedBytes, artifactId };
}

// ─── Grep ────────────────────────────────────────────────────────────────────

interface GrepMatch {
  file: string;
  line: number;
  text: string;
}

function parseGrepLines(raw: string, maxLineLength: number): GrepMatch[] {
  const matches: GrepMatch[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // ripgrep format: file:line:text  or  file:text (if no line numbers)
    const m = trimmed.match(/^(.+?):(\d+)?:(.*)$/);
    if (m) {
      matches.push({ file: m[1]!, line: m[2] ? parseInt(m[2], 10) : 0, text: m[3]! });
    } else {
      // files-only mode or plain path
      matches.push({ file: trimmed.slice(0, maxLineLength), line: 0, text: "" });
    }
  }
  return matches;
}

interface ReduceResult {
  body: string;
  wasReduced: boolean;
  hint?: string;
}

function reduceGrep(raw: string, args: Record<string, unknown>, cfg: ReducerConfig["grep"]): ReduceResult {
  const isFilesMode = args.output_mode === "files";
  const matches = parseGrepLines(raw, cfg.maxLineLength);

  if (matches.length === 0) {
    return { body: raw, wasReduced: false };
  }

  // Files-only mode: reformat as count + list (always considered reduced)
  if (isFilesMode) {
    const files = [...new Set(matches.map((m) => m.file))];
    const lines = [`${files.length} file(s) matched:`, ...files];
    return {
      body: lines.join("\n"),
      wasReduced: true,
      hint: "Re-run with output_mode=\"content\" for match details.",
    };
  }

  // Group by file
  const byFile = new Map<string, GrepMatch[]>();
  for (const m of matches) {
    const list = byFile.get(m.file) ?? [];
    list.push(m);
    byFile.set(m.file, list);
  }

  const lines: string[] = [];
  let totalShown = 0;
  const totalHits = matches.length;
  const fileCount = byFile.size;

  lines.push(`Matched ${fileCount} file(s) (${totalHits} total hits):`);

  for (const [file, hits] of byFile) {
    if (totalShown >= cfg.maxTotalLines) break;
    lines.push(`  ${file}: ${hits.length} hit(s)`);
    const toShow = Math.min(hits.length, cfg.maxMatchesPerFile);
    for (let i = 0; i < toShow; i++) {
      const h = hits[i]!;
      const text = h.text.length > cfg.maxLineLength ? h.text.slice(0, cfg.maxLineLength) + "…" : h.text;
      const prefix = h.line > 0 ? `    ${h.line}:` : "    ";
      lines.push(`${prefix}${text}`);
      totalShown++;
      if (totalShown >= cfg.maxTotalLines) break;
    }
  }

  if (totalShown < totalHits) {
    lines.push(`  … (${totalHits - totalShown} more hits omitted)`);
  }

  return {
    body: lines.join("\n"),
    wasReduced: totalHits > totalShown || fileCount > 1,
    hint: "Use expand_artifact for full matches, or re-run with output_mode=\"files\" for paths only.",
  };
}

// ─── Read ────────────────────────────────────────────────────────────────────

/**
 * Top-level declarations in the languages the JS/TS patterns below miss.
 *
 * The outline is the only thing a model sees for a large file. A Rust or
 * Python file used to produce just "N lines total" plus a preview, so a model
 * that needed a symbol re-read the same file until the loop guardrail stopped
 * the turn. Indentation is allowed because methods live inside `impl` blocks.
 */
const DECLARATION_LINE =
  /^\s*(?:(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+\w+|(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait|union|impl|mod|type)\b|(?:async\s+)?def\s+\w+|func\s+(?:\([^)]*\)\s*)?\w+|(?:public|private|protected|internal|abstract|final|sealed|data|open|static)\s+(?:class|interface|enum|object|fun|void|struct)\b|(?:class|interface|enum|namespace|template|module)\s+\w+|(?:function\s+)?\w+\s*\(\)\s*\{)/;

function reduceRead(raw: string, args: Record<string, unknown>, cfg: ReducerConfig["read"]): ReduceResult {
  // If user explicitly requested a slice, respect it (but still cap)
  const hasSlice = typeof args.offset === "number" || typeof args.limit === "number";
  if (hasSlice) {
    const lines = raw.split("\n");
    if (lines.length > cfg.maxSliceLines) {
      const kept = lines.slice(0, cfg.maxSliceLines).join("\n");
      return {
        body: kept,
        wasReduced: true,
        hint: `… (${lines.length - cfg.maxSliceLines} more lines omitted)`,
      };
    }
    return { body: raw, wasReduced: false };
  }

  // Small full-file reads are more useful verbatim than as an outline.
  if (raw.length <= cfg.maxOutputChars) return { body: raw, wasReduced: false };

  // Large full files: produce a structure outline.
  const allLines = raw.split("\n");
  const totalLines = allLines.length;

  // Strip line numbers for parsing (format: "  1\tcontent" or "1\tcontent")
  const cleanLines = allLines.map((l) => l.replace(/^\s*\d+\t/, ""));

  const imports: string[] = [];
  const exports: string[] = [];
  const functions: string[] = [];
  const classes: string[] = [];
  const declarations: string[] = [];

  for (let i = 0; i < cleanLines.length; i++) {
    const line = cleanLines[i]!;
    const lineNum = i + 1;
    if (/^(?:import\s+|use\s+|from\s+\S+\s+import\s+|#include\b)/.test(line)) {
      imports.push(`${lineNum}: ${line.trim()}`);
    } else if (/^(?:export\s+)?class\s+\w+/.test(line)) {
      classes.push(`${lineNum}: ${line.trim()}`);
    } else if (/^export\s+/.test(line)) {
      exports.push(`${lineNum}: ${line.trim()}`);
    } else if (/^(?:async\s+)?function\s+\w+/.test(line)) {
      functions.push(`${lineNum}: ${line.trim()}`);
    } else if (DECLARATION_LINE.test(line)) {
      declarations.push(`${lineNum}: ${line.trim()}`);
    }
  }

  const parts: string[] = [];
  parts.push(`File: ${totalLines} lines total`);

  if (imports.length > 0) {
    parts.push(`\nImports (${imports.length}):`);
    parts.push(...imports.slice(0, Math.floor(cfg.maxOutlineLines / 4)));
  }
  if (exports.length > 0) {
    parts.push(`\nExports (${exports.length}):`);
    parts.push(...exports.slice(0, Math.floor(cfg.maxOutlineLines / 4)));
  }
  if (functions.length > 0) {
    parts.push(`\nFunctions (${functions.length}):`);
    parts.push(...functions.slice(0, Math.floor(cfg.maxOutlineLines / 4)));
  }
  if (classes.length > 0) {
    parts.push(`\nClasses (${classes.length}):`);
    parts.push(...classes.slice(0, Math.floor(cfg.maxOutlineLines / 4)));
  }
  if (declarations.length > 0) {
    parts.push(`\nDeclarations (${declarations.length}):`);
    parts.push(...declarations.slice(0, Math.floor(cfg.maxOutlineLines / 4)));
  }

  // Preview first N lines
  const previewCount = Math.min(cfg.maxPreviewLines, totalLines);
  parts.push(`\nPreview (lines 1–${previewCount}):`);
  parts.push(...allLines.slice(0, previewCount));

  return {
    body: parts.join("\n"),
    wasReduced: true,
    hint: `Read the next section with offset=${previewCount + 1}, limit=${Math.min(cfg.maxSliceLines, Math.max(1, totalLines - previewCount))}; use expand_artifact for the complete file.`,
  };
}

// ─── Bash ────────────────────────────────────────────────────────────────────

function reduceBash(raw: string, _args: Record<string, unknown>, cfg: ReducerConfig["bash"]): ReduceResult {
  const lines = raw.split("\n");
  if (lines.length <= cfg.maxTotalLines) {
    return { body: raw, wasReduced: false };
  }

  // Parse header (first line usually contains exit=... or timeout)
  let header = "";
  let bodyStart = 0;
  if (lines[0]?.startsWith("exit=") || lines[0]?.startsWith("(timed out")) {
    header = lines[0]!;
    bodyStart = 1;
  }

  const body = lines.slice(bodyStart);

  // Determine if this looks like a failure
  const isFailure = header.includes("exit=1") ||
    raw.includes("Error:") ||
    raw.includes("error:") ||
    raw.includes("FAIL") ||
    raw.includes("failed");

  const out: string[] = [header];

  if (isFailure) {
    // Extract error block: lines near errors or stack traces
    const errorIndices: number[] = [];
    for (let i = 0; i < body.length; i++) {
      const line = body[i]!;
      if (
        /\bError\b/i.test(line) ||
        /\berror\b/i.test(line) ||
        /\bFAIL\b/i.test(line) ||
        /\bfailed\b/i.test(line) ||
        /^\s+at\s+/.test(line) ||
        /\s+Error:\s+/.test(line)
      ) {
        // Grab a window around the error
        for (let j = Math.max(0, i - 2); j <= Math.min(body.length - 1, i + 2); j++) {
          if (!errorIndices.includes(j)) errorIndices.push(j);
        }
      }
    }

    // Sort and cap error block
    errorIndices.sort((a, b) => a - b);
    const cappedError = errorIndices.slice(0, cfg.maxErrorBlockLines);
    if (cappedError.length > 0) {
      out.push("--- error block ---");
      for (const idx of cappedError) {
        out.push(body[idx]!);
      }
    }

    // Extract failing test names
    const testNames: string[] = [];
    for (const line of body) {
      const m = line.match(/(?:✗|✕|×|FAIL)\s+(.+)/) ||
        line.match(/failing\s*\d*\s*:?\s*(.+)/i) ||
        line.match(/Test\s+\w+\s+failed/i);
      if (m && m[1]) {
        const name = m[1].trim().slice(0, 120);
        if (!testNames.includes(name)) testNames.push(name);
      }
    }
    if (testNames.length > 0) {
      out.push("--- failing tests ---");
      out.push(...testNames.slice(0, 10));
    }
  }

  // Last N relevant lines
  const trailing = body.slice(-cfg.maxTrailingLines);
  out.push("--- last lines ---");
  out.push(...trailing);

  // Deduplicate consecutive repeated lines if enabled
  let result = out.join("\n");
  if (cfg.dedupeConsecutiveLines) {
    result = dedupeConsecutive(result);
  }

  return {
    body: result,
    wasReduced: true,
    hint: "Use expand_artifact for full output.",
  };
}

function dedupeConsecutive(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let repeatCount = 1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (next !== undefined && next === line) {
      repeatCount++;
      continue;
    }
    if (repeatCount > 2) {
      out.push(line);
      out.push(`… (${repeatCount - 1} identical lines omitted)`);
    } else {
      for (let j = 0; j < repeatCount; j++) {
        out.push(line);
      }
    }
    repeatCount = 1;
  }
  return out.join("\n");
}

// ─── Web Fetch ───────────────────────────────────────────────────────────────

function reduceWebFetch(raw: string, args: Record<string, unknown>, cfg: ReducerConfig["webFetch"]): ReduceResult {
  const url = typeof args.url === "string" ? args.url : "(unknown URL)";

  // Extract title from first heading
  const titleMatch = raw.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1]!.trim() : "(no title)";

  const parts: string[] = [];
  parts.push(`Title: ${title}`);
  parts.push(`URL: ${url}`);

  // Extract headings for a mini TOC
  const headings = raw.match(/^#{1,3}\s+.+$/gm) ?? [];
  if (headings.length > 0) {
    parts.push("\nSections:");
    for (const h of headings.slice(0, 10)) {
      parts.push(`  ${h}`);
    }
  }

  // First N chars of body
  const bodyStart = raw.indexOf("\n\n");
  const body = bodyStart > 0 ? raw.slice(bodyStart + 2) : raw;
  const excerpt = body.slice(0, cfg.maxChars).trim();
  if (excerpt) {
    parts.push(`\nExcerpt (${excerpt.length} chars):`);
    parts.push(excerpt);
  }

  if (body.length > cfg.maxChars) {
    parts.push(`\n… (${body.length - cfg.maxChars} more chars omitted)`);
  }

  return {
    body: parts.join("\n"),
    wasReduced: true,
    hint: "Use expand_artifact for full page content.",
  };
}

// ─── LSP ─────────────────────────────────────────────────────────────────────

function reduceLsp(raw: string, cfg: ReducerConfig["lsp"]): ReduceResult {
  const lines = raw.split("\n");
  if (lines.length <= cfg.maxLines && raw.length <= cfg.maxOutputChars) {
    return { body: raw, wasReduced: false };
  }

  let result = raw;
  if (lines.length > cfg.maxLines) {
    result = lines.slice(0, cfg.maxLines).join("\n");
  }
  if (result.length > cfg.maxOutputChars) {
    result = result.slice(0, cfg.maxOutputChars);
  }

  return {
    body: result,
    wasReduced: true,
    hint: "LSP output truncated. Use a narrower query, specific file path, or smaller scope to reduce results.",
  };
}

// ─── Search Web ──────────────────────────────────────────────────────────────

function reduceSearchWeb(raw: string, _args: Record<string, unknown>, cfg: ReducerConfig["searchWeb"]): ReduceResult {
  if (raw.length <= cfg.maxChars) {
    return { body: raw, wasReduced: false };
  }
  return {
    body: raw.slice(0, cfg.maxChars),
    wasReduced: true,
    hint: "Search results truncated. Use a more specific query to narrow results.",
  };
}

// ─── GitHub ──────────────────────────────────────────────────────────────────

function reduceGithub(raw: string, cfg: ReducerConfig["github"]): ReduceResult {
  if (raw.length <= cfg.maxChars) {
    return { body: raw, wasReduced: false };
  }
  return {
    body: raw.slice(0, cfg.maxChars),
    wasReduced: true,
    hint: "GitHub response truncated. Use a more specific path or smaller file to reduce size.",
  };
}

// ─── Browser ─────────────────────────────────────────────────────────────────

function reduceBrowser(raw: string, cfg: ReducerConfig["browser"]): ReduceResult {
  if (raw.length <= cfg.maxChars) {
    return { body: raw, wasReduced: false };
  }
  return {
    body: raw.slice(0, cfg.maxChars),
    wasReduced: true,
    hint: "Browser page content truncated. Use a more specific selector or narrower URL scope.",
  };
}

// ─── Glob ────────────────────────────────────────────────────────────────────

function reduceGlob(raw: string, cfg: ReducerConfig["glob"]): ReduceResult {
  const lines = raw.split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= cfg.maxFiles && raw.length <= cfg.maxOutputChars) {
    return { body: raw, wasReduced: false };
  }

  let result = raw;
  if (lines.length > cfg.maxFiles) {
    result = lines.slice(0, cfg.maxFiles).join("\n");
  }
  if (result.length > cfg.maxOutputChars) {
    result = result.slice(0, cfg.maxOutputChars);
  }

  return {
    body: result,
    wasReduced: true,
    hint: `Glob output truncated (${lines.length} files total). Use a more specific pattern (e.g., "src/**/*.ts") to narrow results.`,
  };
}

// ─── Default fallback ────────────────────────────────────────────────────────

function reduceDefault(raw: string, maxChars: number): ReduceResult {
  if (raw.length <= maxChars) {
    return { body: raw, wasReduced: false };
  }
  return {
    body: raw.slice(0, maxChars),
    wasReduced: true,
    hint: "Output truncated. Use a more specific query or call expand_artifact if you need the full content.",
  };
}
