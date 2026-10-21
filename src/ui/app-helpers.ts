/**
 * Pure helpers extracted from app.tsx.
 *
 * None of these touch React state directly — they read inputs and return
 * derived values, or perform side effects (spawn / execSync) that don't
 * depend on the App component's lifecycle. Keeping them out of app.tsx
 * keeps the component file focused on UI wiring.
 */
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";

import type { ResponseMeta } from "../agent/client.js";
import { activeOpenRouterKey } from "../agent/llm-auth.js";
import type { ChatMessage } from "../agent/messages.js";
import type { CostLookup } from "../usage-tracker.js";
import type { Mode } from "../mode.js";
import { buildSystemMessages, buildSystemPrompt } from "../agent/system-prompt.js";
import type { ToolSpec } from "../tools/registry.js";
import { isImagePath } from "../util/image.js";
import type { ChatEvent } from "./view-types.js";
import { createQueueBatch, type QueuedPrompt } from "../agent/queue-batch.js";
import type { Cfg } from "../app.js";

// ── Constants ────────────────────────────────────────────────────────────

export const CONTEXT_LIMIT = 262_000;
export const AUTO_COMPACT_THRESHOLD = 0.8;
export const MAX_EVENTS = 500;
export const DEFAULT_AUTO_FRESH_SUGGESTION_TURNS = 30;
export const MAX_IMAGES_PER_MESSAGE = 10;
export const FEEDBACK_WORKER_URL = "https://hello.kimiflare.com";

/** Replace a queued prompt without appending a second queue item. */
export function replaceQueuedPrompt(
  queue: QueuedPrompt[],
  key: string,
  full: string,
  display: string,
): QueuedPrompt[] | null {
  const index = queue.findIndex((item) => item.key === key);
  if (index >= 0) {
    const next = [...queue];
    next[index] = { ...next[index]!, full, display };
    return next;
  }

  const groupedIndex = queue.findIndex((item) => item.sourceKeys?.includes(key));
  if (groupedIndex < 0) return null;
  const grouped = queue[groupedIndex]!;
  if (!grouped.sourceKeys || !grouped.batchPrompts) return null;
  const promptIndex = grouped.sourceKeys.indexOf(key);
  const replacement = createQueueBatch(
    grouped.batchPrompts.map((prompt, index) => ({
      key: grouped.sourceKeys![index]!,
      full: index === promptIndex ? full : prompt,
      display: index === promptIndex ? display : prompt,
    })),
  );
  if (!replacement) return null;
  const next = [...queue];
  next[groupedIndex] = replacement;
  return next;
}

/** Update a submitted user event, optionally discarding that turn's old output. */
export function replaceUserPromptEvent(
  events: ChatEvent[],
  key: string,
  text: string,
  discardTurnOutput = false,
): ChatEvent[] {
  const index = events.findIndex((event) => event.kind === "user" && event.key === key);
  if (index < 0) return events;
  const event = events[index]!;
  if (event.kind !== "user") return events;
  const replacement: ChatEvent = { ...event, text, images: undefined };
  if (!discardTurnOutput) {
    return events.map((item, i) => (i === index ? replacement : item));
  }
  const queuedFollowUps = events.slice(index + 1).filter((item) => item.kind === "user" && item.queued);
  return [...events.slice(0, index), replacement, ...queuedFollowUps];
}

// ── Event key generator ──────────────────────────────────────────────────

let nextKey = 1;
export const mkKey = (): string => `evt_${nextKey++}`;

let nextAssistantId = 1;
export const mkAssistantId = (): number => nextAssistantId++;

// ── Cost confirmation ────────────────────────────────────────────────────

/** What recordUsage needs to confirm a turn's billed cost with OpenRouter.
 *  Undefined on a custom endpoint (the host's gateway meters) or without
 *  a generation id. */
export function costLookupFromConfig(cfg: Cfg, meta: ResponseMeta | null | undefined): CostLookup | undefined {
  const apiKey = activeOpenRouterKey(cfg);
  if (!apiKey || !meta?.generationId) return undefined;
  return { apiKey, meta };
}

// ── Process / OS helpers ─────────────────────────────────────────────────

/**
 * Open `url` in the user's browser. Returns false when opening is disabled
 * (KIMIFLARE_NO_BROWSER=1 or BROWSER=none — tests, headless boxes) so the
 * caller can fall back to printing the URL. Never throws: a missing opener
 * (no xdg-open on a server) must not crash the app.
 */
export { openBrowser } from "../util/open-browser.js";

export function detectGitHubRepo(cachedRepo?: string): { owner: string; name: string } | null {
  if (cachedRepo) {
    const parts = cachedRepo.split("/");
    if (parts.length === 2) return { owner: parts[0]!, name: parts[1]! };
  }
  try {
    const remoteUrl = execSync("git remote get-url origin", { cwd: process.cwd(), encoding: "utf8" }).trim().replace(/\/+$/,"");
    const httpsMatch = remoteUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (httpsMatch) return { owner: httpsMatch[1]!, name: httpsMatch[2]! };
    const sshMatch = remoteUrl.match(/github\.com:([^\/]+)\/([^\/]+?)(?:\.git)?$/);
    if (sshMatch) return { owner: sshMatch[1]!, name: sshMatch[2]! };
  } catch {
    // not a git repo or no origin remote
  }
  return null;
}

// ── Event cap / compact ──────────────────────────────────────────────────

export function capEvents(prev: ChatEvent[]): ChatEvent[] {
  if (prev.length <= MAX_EVENTS) return prev;
  return prev.slice(prev.length - MAX_EVENTS);
}

/** Visually compact events by collapsing old turns into a placeholder.
 *  Keeps the last `keepLastTurns` user messages and everything after them. */
export function compactEventsVisual(prev: ChatEvent[], keepLastTurns: number): ChatEvent[] {
  let seen = 0;
  let cutoff = -1;
  for (let i = prev.length - 1; i >= 0; i--) {
    if (prev[i]!.kind === "user") {
      seen++;
      if (seen === keepLastTurns + 1) {
        cutoff = i;
        break;
      }
    }
  }
  if (cutoff <= 0) return prev;
  const kept = prev.slice(cutoff);
  return [
    { kind: "info", key: mkKey(), text: `··· ${cutoff} earlier messages compacted ···` },
    ...kept,
  ];
}

// ── System-prompt prefix ─────────────────────────────────────────────────

export function makePrefixMessages(
  cacheStable: boolean,
  model: string,
  mode: Mode,
  tools: ToolSpec[],
  preferPullRequests?: boolean,
): ChatMessage[] {
  if (cacheStable) {
    return buildSystemMessages({ cwd: process.cwd(), tools, model, mode, preferPullRequests });
  }
  return [
    {
      role: "system",
      content: buildSystemPrompt({ cwd: process.cwd(), tools, model, mode, preferPullRequests }),
    },
  ];
}

/**
 * Rebuild the system prompt message(s) in `messages` to match `mode`.
 * Must be called synchronously before starting a new turn after a mode
 * change, because the React effect that updates the system prompt may
 * not have fired yet.
 */
export function rebuildSystemPromptForMode(
  messages: ChatMessage[],
  cacheStable: boolean,
  model: string,
  mode: Mode,
  tools: ToolSpec[],
  preferPullRequests?: boolean,
): void {
  if (cacheStable) {
    const rebuilt = buildSystemMessages({ cwd: process.cwd(), tools, model, mode, preferPullRequests });
    messages[0] = rebuilt[0]!;
    if (rebuilt[1]) {
      messages[1] = rebuilt[1];
    }
  } else {
    messages[0] = {
      role: "system",
      content: buildSystemPrompt({ cwd: process.cwd(), tools, model, mode, preferPullRequests }),
    };
  }
}

// ── Image-path extraction ────────────────────────────────────────────────

export function findImagePaths(text: string): string[] {
  const paths: string[] = [];

  // Extract quoted paths first (e.g. "/path/to/my image.png")
  const quotedRegex = /"([^"]+)"|'([^']+)'/g;
  let match;
  while ((match = quotedRegex.exec(text)) !== null) {
    const path = match[1] ?? match[2];
    if (path && isImagePath(path) && existsSync(path)) {
      paths.push(path);
    }
  }

  // Process remaining text, handling backslash-escaped spaces
  const remaining = text.replace(/"[^"]+"|'[^']+'/g, "");
  const ESCAPED_SPACE = "\u0000";
  const processed = remaining.replace(/\\ /g, ESCAPED_SPACE);

  for (const token of processed.split(/\s+/)) {
    const clean = token
      .replace(new RegExp(ESCAPED_SPACE, "g"), " ")
      .replace(/^["']|["',;:!?]$/g, "")
      .replace(/[.,;:!?]$/, "");
    if (clean && isImagePath(clean) && existsSync(clean) && !paths.includes(clean)) {
      paths.push(clean);
    }
  }

  return paths;
}
