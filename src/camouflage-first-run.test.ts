import { after, before, describe, it } from "node:test";
import { EventEmitter } from "node:events";
import assert from "node:assert";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachLifecycle } from "./camouflage-lifecycle.test-support.js";
import type { AppActions } from "./ui/app-bridge.js";
import { configPath } from "./config.js";
import { DL_WAITING_LINE, dlWaitingText, envKeyLine, envKeyProvider, FIRST_RUN_QUESTION, firstRunChoices, OWN_KEY_BILLING_LINE } from "./providers/connect.js";
import { HIDDEN_WITHOUT_GATEWAY } from "./providers/connect-state.js";
import { DL_DISCLOSURE, DL_FREE_MODEL, dlDenialLine, DlError, type DlDenial, type DlMe } from "./providers/directionally-local.js";
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
    assert.strictEqual(prompts[0]?.payload.default, undefined, "nothing is marked current before anything was chosen");
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
    assert.strictEqual(prompts[2]?.payload.default, undefined);
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

  const code = { deviceCode: "d", userCode: "WLZH-2682", verificationUri: "u", verificationUriComplete: "https://free.example/device?user_code=WLZH-2682", intervalSec: 5, expiresInSec: 600 };

  it("keeps the code and link on screen while it waits, even when the renderer draws late", async () => {
    const savedNoBrowser = process.env.AUTOPILOT_NO_BROWSER;
    process.env.AUTOPILOT_NO_BROWSER = "1";
    try {
      for (let attempt = 0; attempt < 10; attempt++) {
        await fresh();
        const { view, sent } = await fakeView(["free"]);
        // A renderer that draws what it is sent only after 200 ms, and clears its
        // live area (anything not drawn yet) when it lends the terminal.
        const drawn: string[] = [];
        let suspended = false;
        const flush = (upTo: number) => setTimeout(() => {
          if (!suspended) for (const s of sent.slice(0, upTo)) if (s.type === "RuntimeError") drawn.push(String(s.payload.message));
        }, 200);
        const sdk = (view as unknown as { sdk: Record<string, unknown> }).sdk;
        sdk.suspendTerminal = async () => ((suspended = true), { supported: true });
        sdk.resumeTerminal = () => void (suspended = false);
        const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode(v: boolean) { this.isRaw = v; return this; }, resume() { return this; }, pause() { return this; } });
        const written: string[] = [];
        view.terminalIo = { stdin: stdin as never, stdout: { isTTY: true, columns: 60, write: (s: string) => (written.push(s), true) } as never };
        let onScreen = "";
        view.providerCalls = {
          dlSignIn: async (onCode) => {
            onCode(code);
            flush(sent.length);
            // However long the browser takes: look once the waiting text is up.
            for (let i = 0; i < 50 && written.length === 0; i++) await new Promise((r) => setImmediate(r));
            assert.ok(suspended, "the terminal is lent while waiting");
            onScreen = [...drawn, written.join("")].join("\n");
            return { key: "at-1" };
          },
          verify: async (id: ProviderId, key: string | undefined, source) => ({ ok: true, connection: { id, ...(key ? { key } : {}), source } }),
          dlMe: async () => me,
        };
        assert.strictEqual(await view.firstRunSetup({ upgrading: false }), true);
        assert.match(onScreen, /Your code is WLZH-2682/, `attempt ${attempt}: the code is on screen`);
        assert.ok(onScreen.includes("https://free.example/device?user_code=WLZH-2682"), "and where to enter it");
        assert.ok(onScreen.includes(DL_WAITING_LINE));
        // Drawn wrapped at word boundaries to fit 60 columns; every row it took is erased.
        const rows = written[0]!.split("\r\n");
        assert.ok(rows.every((r) => r.replace("\r\x1b[2K", "").length < 60), JSON.stringify(rows));
        assert.ok(written.at(-1)!.includes(`\x1b[${rows.length - 1}A\x1b[J`), JSON.stringify(written.at(-1)));
        view.dispose();
      }
    } finally {
      if (savedNoBrowser === undefined) delete process.env.AUTOPILOT_NO_BROWSER;
      else process.env.AUTOPILOT_NO_BROWSER = savedNoBrowser;
    }
  });

  it("shows the whole sign-in paragraph on a retry too, not only the waiting line", async () => {
    await fresh();
    const savedNoBrowser = process.env.AUTOPILOT_NO_BROWSER;
    process.env.AUTOPILOT_NO_BROWSER = "1";
    try {
      const { view, said } = await fakeView(["free", "free"]);
      const sdk = (view as unknown as { sdk: Record<string, unknown> }).sdk;
      sdk.suspendTerminal = async () => ({ supported: true });
      sdk.resumeTerminal = () => {};
      const stdin = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode(v: boolean) { this.isRaw = v; return this; }, resume() { return this; }, pause() { return this; } });
      let written = "";
      view.terminalIo = { stdin: stdin as never, stdout: { isTTY: true, columns: 120, write: (s: string) => ((written += s), true) } as never };
      const codes = [code, { ...code, userCode: "VZKH-0699", verificationUriComplete: "https://free.example/device?user_code=VZKH-0699" }];
      const paragraph = (c: typeof code) =>
        `Your code is ${c.userCode}. Open ${c.verificationUriComplete} in a browser on any device, sign in with GitHub and approve it (enter an invite code there if asked).`;
      const drawn: string[] = [];
      let attempt = 0;
      view.providerCalls = {
        dlSignIn: async (onCode) => {
          const c = codes[attempt++]!;
          written = "";
          onCode(c);
          for (let i = 0; i < 50 && written === ""; i++) await new Promise((r) => setImmediate(r));
          drawn.push(written.replace(/\r\n/g, " ").replace(/\r\x1b\[2K/, ""));
          if (attempt === 1) throw new DlError("expired_token", "The sign-in code expired before it was approved. Choose Free again for a new code.");
          return { key: "at-1" };
        },
        verify: async (id: ProviderId, key: string | undefined, source) => ({ ok: true, connection: { id, ...(key ? { key } : {}), source } }),
        dlMe: async () => me,
      };
      assert.strictEqual(await view.firstRunSetup({ upgrading: false }), true);
      assert.strictEqual(drawn.length, 2);
      for (const [i, d] of drawn.entries()) {
        assert.ok(d.includes(paragraph(codes[i]!)), `attempt ${i + 1} shows the whole paragraph while it waits: ${d}`);
        assert.ok(d.endsWith(DL_WAITING_LINE));
      }
      // Once each wait ends the paragraph is said, so it stays in the scrollback (before the expiry line).
      const text = said();
      const first = text.indexOf(paragraph(codes[0]!));
      const expired = text.findIndex((l) => /expired before it was approved/.test(l));
      assert.ok(first >= 0 && expired > first, JSON.stringify(text));
      assert.ok(text.indexOf(paragraph(codes[1]!)) > expired);
      view.dispose();
    } finally {
      if (savedNoBrowser === undefined) delete process.env.AUTOPILOT_NO_BROWSER;
      else process.env.AUTOPILOT_NO_BROWSER = savedNoBrowser;
    }
  });

  it("shows the disclosure once, says where to approve without claiming a browser opened, and ignores typing while it waits", async () => {
    await fresh();
    const savedNoBrowser = process.env.AUTOPILOT_NO_BROWSER;
    process.env.AUTOPILOT_NO_BROWSER = "1";
    try {
      const { view, said } = await fakeView(["free"]);
      view.providerCalls = {
        dlSignIn: async (onCode) => {
          onCode(code);
          assert.strictEqual(view.signInWaiting, dlWaitingText(code), "typed input is answered with the waiting text meanwhile");
          return { key: "at-1" };
        },
        verify: async (id: ProviderId, key: string | undefined, source) => ({ ok: true, connection: { id, ...(key ? { key } : {}), source } }),
        dlMe: async () => me,
      };
      assert.strictEqual(await view.firstRunSetup({ upgrading: false }), true);
      const text = said().join("\n");
      assert.strictEqual(text.split(DL_DISCLOSURE).length - 1, 1, "the disclosure is said once");
      assert.match(text, /Your code is WLZH-2682\. Open https:\/\/free\.example\/device\?user_code=WLZH-2682 in a browser on any device, sign in with GitHub and approve it \(enter an invite code there if asked\)\./);
      assert.doesNotMatch(text, /browser is open|Opened your browser/);
      assert.ok(said().includes(dlWaitingText(code)), "without a terminal to lend, the waiting text is said");
      assert.strictEqual(view.signInWaiting, null);
      view.dispose();
    } finally {
      if (savedNoBrowser === undefined) delete process.env.AUTOPILOT_NO_BROWSER;
      else process.env.AUTOPILOT_NO_BROWSER = savedNoBrowser;
    }
  });

  for (const denial of ["account_too_new", "not_invited", "cohort_full", "too_many_signups", "paused"] as DlDenial[]) {
    it(`a ${denial} denial says why and asks the question again`, async () => {
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
      assert.strictEqual(prompts[1]?.payload.default, undefined);
      view.dispose();
    });
  }

  it("a cancelled sign-in asks again, with nothing marked current", async () => {
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
    assert.strictEqual(prompts[1]?.payload.prompt, FIRST_RUN_QUESTION);
    assert.strictEqual(prompts[1]?.payload.default, undefined);
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
