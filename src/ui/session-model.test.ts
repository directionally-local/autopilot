import { describe, it } from "node:test";
import assert from "node:assert";
import {
  readPersistedConfig,
  saveConfig,
  setSessionModelFallback,
  type AutopilotConfig,
} from "../config.js";
import { dispatchSlashCommand, type SlashContext } from "./slash-commands.js";
import { resumeSessionModel } from "./use-session-manager.js";

const DEFAULT = "anthropic/claude-sonnet-4-6";
const OTHER = "openai/gpt-6.1";

/** A slash context whose setCfg/setEvents behave like App's state. */
async function setup(): Promise<{
  ctx: SlashContext;
  cfg: () => AutopilotConfig;
  events: string[];
  defaultModelRef: { current: string };
}> {
  setSessionModelFallback(null);
  await saveConfig({ openrouterApiKey: "sk-or-test", model: DEFAULT } as AutopilotConfig);
  let cfg: AutopilotConfig = { openrouterApiKey: "sk-or-test", model: DEFAULT };
  const events: string[] = [];
  const defaultModelRef = { current: DEFAULT };
  let ctx: SlashContext;
  ctx = {
    cfg,
    busy: false,
    mkKey: () => "k",
    defaultModelRef,
    setEvents: (update: (items: Array<{ text: string }>) => Array<{ text: string }>) => {
      for (const event of update([])) events.push(event.text);
    },
    setCfg: (update: AutopilotConfig | ((prev: AutopilotConfig | null) => AutopilotConfig | null)) => {
      cfg = typeof update === "function" ? update(cfg)! : update;
      // App rebuilds the slash context each command, so it sees the new cfg.
      (ctx as { cfg: AutopilotConfig }).cfg = cfg;
    },
  } as unknown as SlashContext;
  return { ctx, cfg: () => cfg, events, defaultModelRef };
}

/** saveConfig() is fire-and-forget from /model; wait for the disk write it starts. */
async function persistedModel(expected: string): Promise<void> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    if ((await readPersistedConfig())?.model === expected) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  assert.equal((await readPersistedConfig())?.model, expected);
}

describe("per-session /model", () => {
  it("switches this session only, leaving the saved default and other sessions alone", async () => {
    const { ctx, cfg, events, defaultModelRef } = await setup();

    await dispatchSlashCommand(ctx, `/model ${OTHER}`);

    assert.equal(cfg().model, OTHER, "the session runs on the picked model");
    assert.equal(defaultModelRef.current, DEFAULT, "the in-process default did not move");
    assert.equal((await readPersistedConfig())?.model, DEFAULT, "nothing was written to the global config");
    assert.match(events[0] ?? "", /this session only — default stays anthropic\/claude-sonnet-4-6/);

    // A later save for an unrelated setting (e.g. /settings) must not leak
    // the session model into the global default either.
    await saveConfig({ ...cfg(), shell: "zsh" });
    assert.equal((await readPersistedConfig())?.model, DEFAULT);
  });

  it("--default is the explicit way to change the saved default", async () => {
    const { ctx, cfg, events, defaultModelRef } = await setup();

    await dispatchSlashCommand(ctx, `/model --default ${OTHER}`);

    assert.equal(cfg().model, OTHER);
    assert.equal(defaultModelRef.current, OTHER);
    await persistedModel(OTHER);
    assert.match(events[0] ?? "", /now the default for new sessions/);
  });

  it("a bare --default promotes the session's current model", async () => {
    const { ctx, cfg } = await setup();
    await dispatchSlashCommand(ctx, `/model ${OTHER}`);

    await dispatchSlashCommand(ctx, "/model --default");

    assert.equal(cfg().model, OTHER);
    await persistedModel(OTHER);
  });

  it("restores a resumed session's model on the same provider without changing the default", async () => {
    const { cfg } = await setup();
    const resumed = resumeSessionModel(cfg(), { model: OTHER, provider: "openrouter" }, DEFAULT);

    assert.equal(resumed.cfg.model, OTHER, "the session resumes on its own model");
    assert.equal(resumed.notice, undefined);
    await saveConfig({ ...resumed.cfg, shell: "zsh" });
    assert.equal((await readPersistedConfig())?.model, DEFAULT, "the global default is untouched");
    setSessionModelFallback(null);
  });

  it("keeps the current model when a resumed session ran on another provider", async () => {
    const { cfg } = await setup();
    const resumed = resumeSessionModel(
      cfg(),
      { model: "gpt-6.1-sol", provider: "directionally-local" },
      DEFAULT,
    );

    assert.equal(resumed.cfg.model, DEFAULT, "an incompatible model is not restored");
    assert.match(resumed.notice ?? "", /ran on directionally-local.*keeping anthropic\/claude-sonnet-4-6/);
    assert.match(resumed.notice ?? "", /Switch providers with \/provider/);
  });

  it("says nothing when the saved model is already the current model", async () => {
    const { cfg } = await setup();
    const resumed = resumeSessionModel(cfg(), { model: DEFAULT, provider: "directionally-local" }, DEFAULT);

    assert.equal(resumed.cfg.model, DEFAULT);
    assert.equal(resumed.notice, undefined);
  });

  it("keeps the current model silently for sessions without a recorded provider", async () => {
    const { cfg } = await setup();
    const resumed = resumeSessionModel(cfg(), { model: OTHER }, DEFAULT);

    assert.equal(resumed.cfg.model, DEFAULT);
    assert.equal(resumed.notice, undefined);
  });
});
