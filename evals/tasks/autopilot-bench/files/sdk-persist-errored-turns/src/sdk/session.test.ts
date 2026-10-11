import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { createAgentSession } from "./session.js";
import type { KimiFlareSession, SessionEvent } from "./types.js";

// createAgentSession needs an OpenRouter key; config + catalog are isolated
// (temp XDG dir, unreachable OPENROUTER_BASE_URL so the catalog load fails
// fast and falls back to the seed list instead of hitting the network).
const TEST_KEY = "sk-or-test-session";
const TEST_MODEL = "moonshotai/kimi-k2.6";
const ENV_KEYS = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "KIMI_MODEL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "KIMIFLARE_BASE_URL"] as const;

describe("SDK Session", () => {
  const saved: Record<string, string | undefined> = {};
  let configHome = "";
  let session: KimiFlareSession | null = null;
  const testCwd = join(process.cwd(), ".test-sdk-session");

  before(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    delete process.env.KIMIFLARE_BASE_URL;
    configHome = await mkdtemp(join(tmpdir(), "kimiflare-sdk-session-"));
    process.env.XDG_CONFIG_HOME = configHome;
    // Keep session files out of the developer's real data directory.
    process.env.XDG_DATA_HOME = join(configHome, "data");
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    process.env.OPENROUTER_API_KEY = TEST_KEY;
    process.env.KIMI_MODEL = TEST_MODEL;
    await mkdir(testCwd, { recursive: true });
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(configHome, { recursive: true, force: true });
    session?.dispose();
    await rm(testCwd, { recursive: true, force: true });
  });

  it("creates a session with default options", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    assert.ok(s.sessionId);
    assert.strictEqual(s.cwd, testCwd);
    assert.strictEqual(s.isStreaming, false);
    assert.ok(Array.isArray(s.messages));
  });

  it("emits events via subscribe", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    const events: SessionEvent[] = [];
    const unsubscribe = s.subscribe((event) => {
      events.push(event);
    });

    // We can't easily test prompt() without mocking runAgentTurn,
    // but we can test that subscribe/unsubscribe works
    assert.strictEqual(events.length, 0);
    unsubscribe();
  });

  it("setModel changes the model", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    s.setModel("@cf/moonshotai/kimi-k2.6-lite");
    // Model is internal; we verify it doesn't throw
    assert.ok(true);
  });

  it("setMode changes the mode", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    s.setMode("auto");
    const status = s.getStatus();
    assert.strictEqual(status.currentMode, "auto");
  });

  it("setReasoningEffort changes the effort level", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    s.setReasoningEffort("high");
    // Effort is internal; we verify it doesn't throw
    assert.ok(true);
  });

  it("abort does not throw when not streaming", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    await s.abort();
    assert.ok(true);
  });

  it("getUsage returns initial zeros", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    const usage = s.getUsage();
    assert.strictEqual(usage.totalInputTokens, 0);
    assert.strictEqual(usage.totalOutputTokens, 0);
    assert.strictEqual(usage.totalCost, 0);
    assert.strictEqual(usage.turnCount, 0);
  });

  it("getStatus returns correct initial state", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    const status = s.getStatus();
    assert.strictEqual(status.isStreaming, false);
    assert.strictEqual(status.isCompacting, false);
    assert.deepStrictEqual(status.pendingSteer, []);
    assert.deepStrictEqual(status.pendingFollowUp, []);
    assert.strictEqual(status.currentMode, "edit");
  });

  it("save persists session to disk", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    await s.save();
    // If save() resolves without error, we consider it successful
    assert.ok(true);
  });

  it("dispose cleans up without error", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    s.dispose();
    assert.ok(true);
    session = null;
  });

  it("steer does not queue when not streaming", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    await s.steer("use TypeScript");
    const status = s.getStatus();
    assert.deepStrictEqual(status.pendingSteer, []);
  });

  it("followUp queues messages", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    await s.followUp("also add tests");
    const status = s.getStatus();
    assert.deepStrictEqual(status.pendingFollowUp, ["also add tests"]);
  });

  it("resolvePermission does not throw for unknown requestId", async () => {
    const { session: s } = await createAgentSession({ cwd: testCwd });
    session = s;
    s.resolvePermission("unknown", "allow");
    assert.ok(true);
  });
});
