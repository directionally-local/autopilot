/**
 * Guard for the provider invariant: switching providers must switch every
 * LLM-related behaviour with it. Code outside the provider layer may not
 * call OpenRouter helpers or read the OpenRouter key straight from config —
 * it goes through llmAuthFromConfig() / activeOpenRouterKey(), which only
 * hand out OpenRouter credentials while OpenRouter is the active provider.
 *
 * Each allowlisted file says why it may touch OpenRouter directly. Shrink
 * the lists as provider-aware replacements land; never grow them without a
 * reason a reviewer would accept.
 */

import { describe, it } from "node:test";
import assert from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const SRC = join(import.meta.dirname, "..");

async function sourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(p)));
    else if (/\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name)) out.push(p);
  }
  return out;
}

/** Files that may call OpenRouter's HTTP helpers. */
const HELPER_ALLOW: Record<string, string> = {
  "models/openrouter.ts": "defines them",
  "models/openrouter-catalog.ts": "OpenRouter's public model catalog",
  "models/openrouter-oauth.ts": "OpenRouter sign-in",
  "agent/client.ts": "the OpenRouter request branch, taken only when OpenRouter is active",
  "agent/jev.ts": "OpenRouter's Decisions API; callers pass activeOpenRouterKey()",
  "memory/embeddings.ts": "the OpenRouter embeddings branch, taken only when OpenRouter is active",
  "usage-tracker.ts": "cost confirmation via /generation; only given a key by activeOpenRouterKey()",
  "cost-verify.ts": "`cost --verify` against /generation; gated on activeOpenRouterKey()",
  "cost-attribution/reconcile.ts": "all-time spend via /key; gated on activeOpenRouterKey()",
  "index.tsx": "`autopilot auth openrouter` key management",
  "ui/slash-commands.ts": "`/key` OpenRouter key management",
  "ui/onboarding.tsx": "OpenRouter sign-in during onboarding",
  "server/aster-memory.ts": "Aster server memory; runs only with an OpenRouter key (Hotcell gateway)",
};

/** Files that may read `<config>.openrouterApiKey` directly. */
const KEY_READ_ALLOW: Record<string, string> = {
  "config.ts": "loads and persists the key",
  "providers/resolve.ts": "provider resolution",
  "agent/llm-auth.ts": "turns config into credentials",
  "sdk/config.ts": "names the field in an error message",
  "ui/slash-commands.ts": "`/key` shows and replaces the OpenRouter key",
};

describe("OpenRouter is only reached through the provider layer", () => {
  it("only allowlisted files call OpenRouter HTTP helpers", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (HELPER_ALLOW[rel]) continue;
      const text = await readFile(file, "utf8");
      if (/\b(openRouterUrl|openRouterHeaders|openRouterAlphaUrl|checkOpenRouterKey)\s*\(/.test(text)) offenders.push(rel);
    }
    assert.deepStrictEqual(offenders, [], `use llmAuthFromConfig()/activeOpenRouterKey() instead in: ${offenders.join(", ")}`);
  });

  it("only allowlisted files read the OpenRouter key from config", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (KEY_READ_ALLOW[rel]) continue;
      const text = await readFile(file, "utf8");
      if (/\b(cfg|config|merged|persisted|loaded)\??\.openrouterApiKey\b/.test(text)) offenders.push(rel);
    }
    assert.deepStrictEqual(offenders, [], `read the key via llmAuthFromConfig()/activeOpenRouterKey() in: ${offenders.join(", ")}`);
  });

  it("no module falls back to OpenRouter's plumbing model id", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(SRC)) {
      const rel = relative(SRC, file);
      if (rel === "config.ts") continue;
      const text = await readFile(file, "utf8");
      if (/\?\?\s*DEFAULT_PLUMBING_MODEL\b/.test(text)) offenders.push(rel);
    }
    assert.deepStrictEqual(offenders, [], `use plumbingModelOf(cfg) in: ${offenders.join(", ")}`);
  });
});
