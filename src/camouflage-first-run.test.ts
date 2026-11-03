import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachLifecycle } from "./camouflage-lifecycle.test-support.js";
import type { AppActions } from "./ui/app-bridge.js";
import { configPath } from "./config.js";
import { envKeyLine, envKeyProvider, FIRST_RUN_QUESTION, firstRunChoices, OWN_KEY_BILLING_LINE } from "./providers/connect.js";
import { HIDDEN_WITHOUT_GATEWAY } from "./providers/connect-state.js";
import { DL_FREE_MODEL, dlDenialLine, DlError, type DlDenial, type DlMe } from "./providers/directionally-local.js";
import type { ProviderId } from "./providers/presets.js";

type Sent = { type: string; payload: Record<string, unknown> };
type Option = { value: string; label: string; description?: string };

/** A View on a fake renderer: records what it sends and answers select prompts from a queue. */
async function fakeView(select: (string | null)[]) {
  process.env.AUTOPILOT_JOBS_DB = join(await mkdtemp(join(tmpdir(), "cam-first-run-")), "jobs.db");
  const { View } = await import("./camouflage-view.js");
  const sent: Sent[] = [];
  const prompts: Sent[] = [];
  const cam = attachLifecycle(
    { send: (type: string, payload: Record<string, unknown> = {}) => (sent.push({ type, payload }), true), on() { return this; }, close: async () => 0 },
    { permission: async () => ({ choice: "deny" as const }) },
  );
  const sdk = {
    mount: async () => cam,
    selectList: async (_c: unknown, spec: Record<string, unknown>) => {
      prompts.push({ type: "select", payload: spec });
      const value = select.shift();
      return value === null || value === undefined ? { id: "", cancelled: true } : { id: "", value, cancelled: false };
    },
    confirm: async () => ({ id: "", cancelled: true }),
    form: async (_c: unknown, spec: Record<string, unknown>) => (prompts.push({ type: "form", payload: spec }), { id: "", cancelled: true }),
  };
  const view = new View(cam as never, sdk as never);
  view.connect(new Proxy({}, { get: () => () => undefined }) as AppActions);
  const said = () => sent.filter((s) => s.type === "RuntimeError").map((s) => String(s.payload.message));
  const options = (i: number) => (prompts[i]?.payload.options as Option[]).map((o) => o.value);
  return { view, sent, prompts, said, options };
}

const me: DlMe = { login: "octo", allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 0, remaining: 50_000_000, resetsAt: "2026-11-09T00:00:00.000Z" } };

describe("first run: one question", () => {
  // Every test gets its own empty config home under this temp dir; no config file is ever removed.
  let root: string;
  const ENV = ["XDG_CONFIG_HOME", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "AUTOPILOT_PROVIDER", "AUTOPILOT_BASE_URL", "KIMIFLARE_BASE_URL"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  before(async () => {
    root = await mkdtemp(join(tmpdir(), "first-run-home-"));
  });
  const fresh = async () => {
    for (const k of ENV) delete process.env[k];
    process.env.XDG_CONFIG_HOME = await mkdtemp(join(root, "h-"));
  };
  after(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (root?.startsWith(tmpdir())) await rm(root, { recursive: true, force: true });
  });

  it("asks how it should think: Free or your own key, Free highlighted, nothing about billing", async () => {
    await fresh();
    const { view, prompts, options } = await fakeView([null]);
    assert.strictEqual(await view.firstRunSetup({ upgrading: false }), false, "Esc quits");
    assert.strictEqual(prompts[0]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.strictEqual(FIRST_RUN_QUESTION, "How should it think?");
    assert.deepStrictEqual(options(0), ["free", "own-key"]);
    assert.strictEqual(prompts[0]?.payload.default, "free");
    assert.deepStrictEqual(
      firstRunChoices().map((c) => `${c.label} · ${c.description}`),
      ["Free — sign in with GitHub · 50M tokens a week, no card", "Use my own API key · OpenRouter, Anthropic, OpenAI and more"],
    );
    assert.doesNotMatch(JSON.stringify(prompts[0]), /billed/);
    view.dispose();
  });

  it("own key opens the provider picker without the free tier, with the billing line; Esc goes back to the question", async () => {
    await fresh();
    const { view, prompts, options } = await fakeView(["own-key", null, null]);
    assert.strictEqual(await view.firstRunSetup({ upgrading: false }), false);
    assert.ok(!options(1).includes("directionally-local"), "no free-tier row on the own-key picker");
    assert.ok(options(1).includes("openrouter") && options(1).includes("anthropic"));
    assert.match(String(prompts[1]?.payload.subtitle), new RegExp(`^${OWN_KEY_BILLING_LINE.replace(/\./g, "\\.")}`));
    assert.strictEqual(prompts[2]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.strictEqual(prompts[2]?.payload.default, "own-key");
    view.dispose();
  });

  it("Free goes straight into the sign-in, then saves the free model and says who signed in", async () => {
    await fresh();
    const { view, prompts, said } = await fakeView(["free"]);
    let signIns = 0;
    view.providerCalls = {
      dlSignIn: async () => (signIns++, { key: "at-1" }),
      verify: async (id: ProviderId, key: string | undefined, source) => ({ ok: true, connection: { id, ...(key ? { key } : {}), source } }),
      dlMe: async () => me,
    };
    assert.strictEqual(await view.firstRunSetup({ upgrading: false }), true);
    assert.strictEqual(signIns, 1);
    assert.strictEqual(prompts.length, 1, "no provider list, no model picker");
    const lines = said();
    assert.ok(lines.some((l) => l.includes("Free tokens come with usage counts")), "the disclosure is on the sign-in screen");
    assert.ok(lines.some((l) => /^✓ Signed in as @octo · 50M free tokens this week · back every \w+day$/.test(l)));
    assert.ok(!lines.some((l) => /billed/.test(l)));
    const cfg = JSON.parse(await readFile(configPath(), "utf8"));
    assert.deepStrictEqual([cfg.provider, cfg.model, cfg.providers["directionally-local"].apiKey], ["directionally-local", DL_FREE_MODEL, "at-1"]);
    view.dispose();
  });

  for (const denial of ["account_too_new", "not_invited", "cohort_full", "paused"] as DlDenial[]) {
    it(`a ${denial} denial says why and asks again with "own key" highlighted`, async () => {
      await fresh();
      const { view, prompts, said } = await fakeView(["free", null]);
      const message = dlDenialLine(denial, { where: "signin" });
      view.providerCalls = {
        ...view.providerCalls,
        dlSignIn: async () => {
          throw new DlError(denial === "paused" ? "service_paused" : "access_denied", message, 400, { reason: denial });
        },
      };
      assert.strictEqual(await view.firstRunSetup({ upgrading: false }), false);
      assert.ok(said().includes(message));
      assert.ok(!said().some((l) => /choose it again/i.test(l)));
      assert.strictEqual(prompts[1]?.payload.prompt, FIRST_RUN_QUESTION);
      assert.strictEqual(prompts[1]?.payload.default, "own-key");
      view.dispose();
    });
  }

  it("a cancelled sign-in asks again with Free still highlighted", async () => {
    await fresh();
    const { view, prompts } = await fakeView(["free", null]);
    view.providerCalls = {
      ...view.providerCalls,
      dlSignIn: async (_onCode, signal) => {
        view.signIn?.abort();
        throw Object.assign(new Error("aborted"), { name: "AbortError", signal });
      },
    };
    assert.strictEqual(await view.firstRunSetup({ upgrading: false }), false);
    assert.strictEqual(prompts[1]?.payload.default, "free");
    view.dispose();
  });

  it("uses a known provider's key from the environment without asking", async () => {
    await fresh();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
    const env = { ANTHROPIC_API_KEY: "sk-ant-test-key" };
    const envKey = envKeyProvider(env)!;
    assert.deepStrictEqual(envKey, { id: "anthropic", envVar: "ANTHROPIC_API_KEY" });
    assert.strictEqual(envKeyLine(envKey), "Using Anthropic with ANTHROPIC_API_KEY from your environment.");
    const { view, prompts } = await fakeView(["claude-test-model"]);
    let verified: unknown;
    view.providerCalls = {
      ...view.providerCalls,
      verify: async (id: ProviderId, key: string | undefined, source) => ((verified = [id, key, source]), { ok: true, connection: { id, ...(key ? { key } : {}), source } }),
    };
    assert.strictEqual(await view.firstRunSetup({ upgrading: false, envKey }), true);
    assert.deepStrictEqual(verified, ["anthropic", "sk-ant-test-key", "env"]);
    assert.ok(!prompts.some((p) => p.payload.prompt === FIRST_RUN_QUESTION), "the question isn't forced");
    assert.match(String(prompts[0]?.payload.prompt), /Anthropic model/);
    const cfg = JSON.parse(await readFile(configPath(), "utf8"));
    assert.deepStrictEqual([cfg.provider, cfg.model], ["anthropic", "claude-test-model"]);
    assert.strictEqual(cfg.providers?.anthropic?.apiKey, undefined, "a key from the environment is never written to disk");
    view.dispose();
  });

  it("detects no env key when none is set, and OpenRouter first when several are", () => {
    assert.strictEqual(envKeyProvider({}), undefined);
    assert.strictEqual(envKeyProvider({ ANTHROPIC_API_KEY: "a", OPENROUTER_API_KEY: "sk-or-x" })?.id, "openrouter");
    assert.strictEqual(envKeyProvider({ AUTOPILOT_DL_FREE_TOKEN: "t" }), undefined, "the free tier's token doesn't skip the question");
  });

  it("`autopilot connect --state-file` shows the provider list without the free tier, never the question", async () => {
    await fresh();
    const { view, prompts, options } = await fakeView([null]);
    assert.strictEqual(await view.connectSetup({ exclude: HIDDEN_WITHOUT_GATEWAY }), null);
    assert.strictEqual(prompts[0]?.payload.prompt, "Connect a model provider");
    assert.ok(!options(0).includes("directionally-local"));
    view.dispose();
  });

  it("`autopilot connect` without --state-file asks the same question", async () => {
    await fresh();
    const { view, prompts } = await fakeView([null]);
    assert.strictEqual(await view.connectSetup({}), null);
    assert.strictEqual(prompts[0]?.payload.prompt, FIRST_RUN_QUESTION);
    view.dispose();
  });
});
