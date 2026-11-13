import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { configPath, loadConfig } from "../config.js";
import { assembleTurn, describeSubagentGuidance, lastUserText, resolveTurnPolicy } from "./session-core.js";
import { resetPrivateHttpWarnings, setPrivateHttpWarningHandler } from "../providers/resolve.js";
import type { ToolSpec } from "../tools/registry.js";

const tool = (name: string): ToolSpec => ({ name, description: name, parameters: { type: "object" }, needsPermission: false, run: async () => "" });
const TOOLS = [tool("read"), tool("subagent")];
const deepseek = { provider: "deepseek" as const, providers: { deepseek: { apiKey: "k" } }, model: "deepseek-v4-pro" };
const hotcellReady = async () => ({ ready: true });

describe("resolveTurnPolicy", () => {
  it("offers the subagent tool only when guidance allows dispatch", async () => {
    const off = await resolveTurnPolicy({ cfg: { ...deepseek, subagentPolicy: "off" }, prompt: "audit the whole codebase in parallel", tools: TOOLS });
    assert.ok(!off.tools.some((t) => t.name === "subagent"), "policy off: no subagent tool");
    const asked = await resolveTurnPolicy({ cfg: { ...deepseek, subagentPolicy: "suggest" }, prompt: "use 3 subagents to research auth, billing and search", tools: TOOLS, hotcellReadiness: hotcellReady });
    assert.strictEqual(asked.guidance.kind, "explicit-delegate");
    assert.ok(asked.tools.some((t) => t.name === "subagent"));
    assert.match(String(asked.delegationDirective), /explicitly asked for subagents/);
    const no = await resolveTurnPolicy({ cfg: deepseek, prompt: "do not use subagents; fix the bug", tools: TOOLS });
    assert.strictEqual(no.guidance.kind, "explicit-sequential");
    assert.ok(!no.tools.some((t) => t.name === "subagent"));
  });

  it("adds the completion check only where Jev runs (OpenRouter), and never for research workers", async () => {
    const or = await resolveTurnPolicy({ cfg: { openrouterApiKey: "sk-or-x", model: "m/m" }, prompt: "fix it", tools: TOOLS });
    assert.strictEqual(typeof or.completionCheck, "function");
    const ds = await resolveTurnPolicy({ cfg: deepseek, prompt: "fix it", tools: TOOLS });
    assert.strictEqual(ds.completionCheck, undefined);
    const worker = await resolveTurnPolicy({ cfg: { openrouterApiKey: "sk-or-x" }, prompt: "use subagents", tools: TOOLS, workerProfile: "research" });
    assert.strictEqual(worker.completionCheck, undefined);
    assert.strictEqual(worker.delegationDirective, undefined);
    assert.ok(!worker.tools.some((t) => t.name === "subagent"));
    const build = await resolveTurnPolicy({ cfg: { openrouterApiKey: "sk-or-x" }, prompt: "use subagents", tools: TOOLS, workerProfile: "build" });
    assert.strictEqual(build.completionCheck, undefined);
    assert.strictEqual(build.delegationDirective, undefined);
    assert.ok(!build.tools.some((t) => t.name === "subagent"), "a build worker never delegates");
  });

  it("classifies the request", async () => {
    const p = await resolveTurnPolicy({ cfg: deepseek, prompt: "hi", tools: TOOLS });
    assert.strictEqual(p.classification.tier, "light");
  });

  it("suppresses delegation and explains why when Hotcell is not ready (#966)", async () => {
    const p = await resolveTurnPolicy({
      cfg: { ...deepseek, subagentPolicy: "suggest" },
      prompt: "use 3 subagents to research auth, billing and search",
      tools: TOOLS,
      hotcellReadiness: async () => ({
        ready: false,
        reason: "the Hotcell daemon isn't reachable at http://127.0.0.1:4750",
        fix: "Start it with `hotcell start --defaults` (Docker must be running).",
      }),
    });
    assert.strictEqual(p.guidance.kind, "none");
    assert.ok(!p.tools.some((t) => t.name === "subagent"), "no subagent tool when Hotcell is down");
    assert.strictEqual(p.delegationDirective, undefined);
    assert.match(String(p.readinessNotice), /Subagents are unavailable/);
    assert.match(String(p.readinessNotice), /hotcell start --defaults/);
  });

  it("does not probe Hotcell when guidance already says no delegation", async () => {
    let probed = false;
    const p = await resolveTurnPolicy({
      cfg: deepseek,
      prompt: "hi",
      tools: TOOLS,
      hotcellReadiness: async () => {
        probed = true;
        return { ready: false };
      },
    });
    assert.strictEqual(p.guidance.kind, "none");
    assert.strictEqual(probed, false);
    assert.strictEqual(p.readinessNotice, undefined);
  });
});

describe("assembleTurn", () => {
  it("layers config defaults, then the policy, then the host — host options win", async () => {
    const policy = await resolveTurnPolicy({ cfg: { ...deepseek, subagentPolicy: "off" }, prompt: "refactor the parser", tools: TOOLS });
    const opts = assembleTurn({
      cfg: { ...deepseek, coauthor: true, coauthorName: "Bot", preferPullRequests: true, maxTotalToolIterations: 77 },
      policy,
      host: { model: "deepseek-flash", messages: [], executor: {} as never, cwd: "/tmp", signal: new AbortController().signal, callbacks: { askPermission: async () => "allow" }, maxTotalToolIterations: 5 },
    });
    assert.strictEqual(opts.providerId, "deepseek");
    assert.deepStrictEqual(opts.coauthor, { name: "Bot", email: "autopilot@directionallylocal.com" });
    assert.strictEqual(opts.preferPullRequests, true);
    assert.strictEqual(opts.maxTotalToolIterations, 5, "host override wins");
    assert.strictEqual(opts.model, "deepseek-flash");
    assert.strictEqual(opts.intentClassification, policy.classification);
    assert.deepStrictEqual(opts.tools.map((t) => t.name), ["read"]);
  });

  for (const hostname of ["192.168.1.5", "gpu-box"]) {
    it(`delivers exactly one warning for saved keyed ${hostname}: loadConfig → resolveTurnPolicy → assembleTurn`, async () => {
      const root = await mkdtemp(join(tmpdir(), "ap-private-http-lifecycle-"));
      const savedEnv = { ...process.env };
      resetPrivateHttpWarnings();
      setPrivateHttpWarningHandler(undefined);
      const warnings: string[] = [];
      try {
        for (const key of Object.keys(process.env)) {
          if (/^(AUTOPILOT_|KIMIFLARE_|KIMI_|OPENROUTER_API_KEY$|REQUESTY_API_KEY$)/.test(key)) delete process.env[key];
        }
        process.env.XDG_CONFIG_HOME = join(root, "config");
        process.env.XDG_STATE_HOME = join(root, "state");
        process.env.XDG_DATA_HOME = join(root, "data");
        await mkdir(dirname(configPath()), { recursive: true });
        await writeFile(configPath(), JSON.stringify({ provider: "custom", baseUrl: `http://${hostname}/v1`, apiKey: "test-only", model: "m" }));

        const cfg = await loadConfig();
        assert.ok(cfg, "the saved keyed endpoint loads");
        const policy = await resolveTurnPolicy({ cfg, prompt: "hi", tools: TOOLS });
        assert.strictEqual(warnings.length, 0, "startup has not installed a visible channel yet");
        // No warning reset between production stages: startup must not consume delivery.
        const turn = {
          cfg, policy,
          host: { model: "m", messages: [], executor: {} as never, cwd: root, signal: new AbortController().signal, callbacks: { askPermission: async () => "allow" as const, onWarning: (m: string) => warnings.push(m) } },
        };
        assembleTurn(turn);
        assert.strictEqual(warnings.length, 1, "first turn delivers the pending warning");
        assert.ok(warnings[0]!.includes(hostname));
        assert.match(warnings[0]!, /API key over cleartext http/);
        const nextPolicy = await resolveTurnPolicy({ cfg, prompt: "hi again", tools: TOOLS });
        assembleTurn({ ...turn, policy: nextPolicy });
        assert.strictEqual(warnings.length, 1, "later policy and turn resolution do not repeat delivery");
      } finally {
        setPrivateHttpWarningHandler(undefined);
        resetPrivateHttpWarnings();
        for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
        Object.assign(process.env, savedEnv);
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("routes light turns to the configured fast model, but never past a host-picked model", async () => {
    const cfg = { ...deepseek, subagentPolicy: "off" as const, modelRouting: { light: "deepseek-flash" } };
    const policy = await resolveTurnPolicy({ cfg, prompt: "hi", tools: TOOLS });
    assert.strictEqual(policy.classification.tier, "light");
    assert.strictEqual(policy.routedModel, "deepseek-flash");

    // Session runs the default model → routing applies and is attributed.
    const routed = assembleTurn({
      cfg,
      policy,
      host: { model: "deepseek-v4-pro", messages: [], executor: {} as never, cwd: "/tmp", signal: new AbortController().signal, callbacks: { askPermission: async () => "allow" as const } },
    });
    assert.strictEqual(routed.model, "deepseek-flash");
    assert.strictEqual(routed.routedFromModel, "deepseek-v4-pro");

    // Session runs a model the user picked with /model → routing stays out.
    const pinned = assembleTurn({
      cfg,
      policy,
      host: { model: "moonshotai/kimi-k2.6", messages: [], executor: {} as never, cwd: "/tmp", signal: new AbortController().signal, callbacks: { askPermission: async () => "allow" as const } },
    });
    assert.strictEqual(pinned.model, "moonshotai/kimi-k2.6");
    assert.strictEqual(pinned.routedFromModel, undefined);
  });

  it("keeps the session model when routing is unconfigured", async () => {
    const policy = await resolveTurnPolicy({ cfg: { ...deepseek, subagentPolicy: "off" }, prompt: "hi", tools: TOOLS });
    assert.strictEqual(policy.routedModel, undefined);
  });

  it("describes guidance for hosts that show it", () => {
    assert.strictEqual(describeSubagentGuidance({ kind: "none", reason: "" }), null);
    assert.match(describeSubagentGuidance({ kind: "suggest", reason: "", probability: 0.7 })!, /Jev estimate: 70%/);
  });

  it("reads the latest user message for the policy", () => {
    assert.strictEqual(lastUserText([{ role: "user", content: "a" }, { role: "assistant", content: "b" }, { role: "user", content: [{ type: "text", text: "c" }] }]), "c");
  });
});

describe("hosts go through SessionCore", () => {
  it("every runAgentTurn call outside the loop is built by assembleTurn", async () => {
    const src = join(import.meta.dirname, "..");
    const files: string[] = [];
    const walk = async (d: string) => {
      for (const e of await readdir(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else if (/\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name)) files.push(p);
      }
    };
    await walk(src);
    const offenders: string[] = [];
    for (const f of files) {
      const rel = relative(src, f);
      if (["agent/loop.ts", "agent/supervisor.ts", "agent/session-core.ts"].includes(rel)) continue;
      const text = await readFile(f, "utf8");
      for (const m of text.matchAll(/(?:runAgentTurn|\.startTurn)\(\s*(\S+)/g)) {
        if (!m[1]!.startsWith("assembleTurn(") && !m[1]!.startsWith("active")) offenders.push(`${rel}: ${m[0].slice(0, 40)}`);
      }
    }
    assert.deepStrictEqual(offenders, [], "build turn options with assembleTurn()");
  });
});

describe("runStopForError", () => {
  it("pauses a run whose active turn outgrew the context, with the numbers and the choices", async () => {
    const { runStopForError } = await import("./session-core.js");
    const { ContextBudgetError } = await import("./context-budget.js");
    const stop = runStopForError(new ContextBudgetError(215_000, 120_000, 128_000), { model: "moonshotai/kimi-k2.6" });
    assert.strictEqual(stop.status, "needs_input");
    assert.match(stop.reason, /^context_budget_exceeded: the current turn needs ~215,000 tokens but moonshotai\/kimi-k2\.6 has 120,000 available \(context window 128,000\)/);
    assert.match(stop.reason, /larger-context model .*or cancel/);
  });

  it("pauses on the runtime budget and fails on anything else", async () => {
    const { runStopForError } = await import("./session-core.js");
    assert.deepStrictEqual(runStopForError(new Error("aborted"), { runtimeBudgetExceeded: true }), { status: "needs_input", reason: "max_runtime_exceeded" });
    assert.deepStrictEqual(runStopForError(new Error("HTTP 500")), { status: "failed", reason: "HTTP 500" });
  });
});

describe("describeSubagentGuidance: no per-turn noise", () => {
  it("says nothing for the default auto policy, but answers explicit requests", () => {
    assert.strictEqual(describeSubagentGuidance({ kind: "auto-delegate" } as never), null);
    assert.match(String(describeSubagentGuidance({ kind: "explicit-delegate" } as never)), /explicit request/);
  });
});
