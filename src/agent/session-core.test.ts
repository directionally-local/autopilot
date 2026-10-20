import { describe, it } from "node:test";
import assert from "node:assert";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { assembleTurn, describeSubagentGuidance, lastUserText, resolveTurnPolicy } from "./session-core.js";
import type { ToolSpec } from "../tools/registry.js";

const tool = (name: string): ToolSpec => ({ name, description: name, parameters: { type: "object" }, needsPermission: false, run: async () => "" });
const TOOLS = [tool("read"), tool("subagent")];
const deepseek = { provider: "deepseek" as const, providers: { deepseek: { apiKey: "k" } }, model: "deepseek-v4-pro" };

describe("resolveTurnPolicy", () => {
  it("offers the subagent tool only when guidance allows dispatch", async () => {
    const off = await resolveTurnPolicy({ cfg: { ...deepseek, subagentPolicy: "off" }, prompt: "audit the whole codebase in parallel", tools: TOOLS });
    assert.ok(!off.tools.some((t) => t.name === "subagent"), "policy off: no subagent tool");
    const asked = await resolveTurnPolicy({ cfg: { ...deepseek, subagentPolicy: "suggest" }, prompt: "use 3 subagents to research auth, billing and search", tools: TOOLS });
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
  });

  it("classifies the request", async () => {
    const p = await resolveTurnPolicy({ cfg: deepseek, prompt: "hi", tools: TOOLS });
    assert.strictEqual(p.classification.tier, "light");
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
    assert.deepStrictEqual(opts.coauthor, { name: "Bot", email: "kimiflare@proton.me" });
    assert.strictEqual(opts.preferPullRequests, true);
    assert.strictEqual(opts.maxTotalToolIterations, 5, "host override wins");
    assert.strictEqual(opts.model, "deepseek-flash");
    assert.strictEqual(opts.intentClassification, policy.classification);
    assert.deepStrictEqual(opts.tools.map((t) => t.name), ["read"]);
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
