import { it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { configPath, loadConfig, saveConfig } from "../config.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { providerDestinationLabel, resolveActiveProvider } from "../providers/resolve.js";
import { statusSegments } from "../camouflage-view.js";
import { buildTour } from "./project-tour.js";
import { tourAskModel } from "./project-tour-model.js";
import { runStartupTasks } from "./run-startup-tasks.js";
import type { ChatEvent } from "./view-types.js";

it("DL starts with a saved public-http config: status and tour render; first request refuses", async () => {
  const root = await mkdtemp(join(tmpdir(), "ap-public-http-startup-"));
  const cwd = process.cwd();
  const savedEnv = { ...process.env };
  const refusal = "base URL must use https (got http://example.com) — use https or an ssh tunnel to 127.0.0.1";
  try {
    // All state is disposable, including the persisted config and startup indexes.
    for (const key of Object.keys(process.env)) {
      if (/^(AUTOPILOT_|KIMIFLARE_|KIMI_|OPENROUTER_API_KEY$|REQUESTY_API_KEY$)/.test(key)) delete process.env[key];
    }
    process.env.XDG_CONFIG_HOME = join(root, "config");
    process.env.XDG_STATE_HOME = join(root, "state");
    process.env.XDG_DATA_HOME = join(root, "data");
    process.env.AUTOPILOT_IMPORT_SETUP = "0";
    const project = join(root, "project");
    await mkdir(project);
    execFileSync("git", ["init", "-q", project]);
    process.chdir(project);
    await writeFile(join(project, "README.md"), "Startup regression fixture\n");
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), JSON.stringify({ provider: "custom", baseUrl: "http://example.com/v1", apiKey: "test-only", model: "test-model" }));

    const cfg = await loadConfig();
    assert.ok(cfg, "saved config loads instead of crashing or triggering onboarding");
    await saveConfig(cfg);
    const active = resolveActiveProvider(cfg);
    assert.equal(active.baseUrlRefusal, refusal);
    const providerHost = providerDestinationLabel(active);
    assert.equal(providerHost, "example.com");
    const status = statusSegments({ model: cfg.model, providerHost } as Parameters<typeof statusSegments>[0]);
    assert.equal(status.provider, "example.com");

    // This is the same factory called eagerly by App while building the tour.
    const ask = tourAskModel(cfg);
    assert.ok(ask, "constructing the tour's model callback does not request auth");
    const tour = await buildTour({ cwd: project, enabled: true, ask, providerHost });
    assert.equal(tour.kind, "shown");
    if (tour.kind === "shown") {
      assert.match(tour.text, /provider: example\.com/);
      assert.equal(tour.source, "local", "a refused optional model call falls back to local suggestions");
    }

    // Startup bookkeeping must not synchronously throw either (memory is on by default).
    let events: ChatEvent[] = [];
    let commandsLoaded!: () => void;
    const loaded = new Promise<void>((resolve) => { commandsLoaded = resolve; });
    const memoryManagerRef = { current: null };
    assert.doesNotThrow(() => runStartupTasks({
      cfg, setCfg: () => {},
      setEvents: (next) => { events = typeof next === "function" ? next(events) : next; },
      mkKey: () => "startup", memoryManagerRef, sessionStartRecallRef: { current: null },
      setKimiMdStale: () => {}, customCommandsRef: { current: [] },
      setCustomCommandsVersion: () => commandsLoaded(),
    }));
    await loaded;
    assert.equal(memoryManagerRef.current, null, "blocked model work is not initialized");
    assert.ok(events.some((event) => event.kind === "info" && event.text === refusal && event.tone === "warn"));
    assert.throws(() => llmAuthFromConfig(cfg), { message: refusal }, "the first user request still refuses before credentials are returned");
  } finally {
    process.chdir(cwd);
    for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
    Object.assign(process.env, savedEnv);
    await rm(root, { recursive: true, force: true });
  }
});
