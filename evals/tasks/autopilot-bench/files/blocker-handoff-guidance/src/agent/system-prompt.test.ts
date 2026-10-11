import { describe, it } from "node:test";
import assert from "node:assert";
import { buildStaticPrefix, buildSessionPrefix, buildSystemMessages, buildSystemPrompt } from "./system-prompt.js";
import type { ToolSpec } from "../tools/registry.js";

const DUMMY_TOOLS: ToolSpec[] = [
  {
    name: "read",
    description: "Read a file.",
    parameters: { type: "object", properties: {}, required: [] },
    needsPermission: false,
    run: async () => "",
  },
];

describe("buildStaticPrefix", () => {
  it("is byte-for-byte identical across different dates", () => {
    const a = buildStaticPrefix({ model: "@cf/moonshotai/kimi-k2.6" });
    const b = buildStaticPrefix({ model: "@cf/moonshotai/kimi-k2.6" });
    assert.strictEqual(a, b);
  });

  it("does not contain volatile metadata", () => {
    const p = buildStaticPrefix({ model: "@cf/moonshotai/kimi-k2.6" });
    assert.ok(!p.includes("Today:"), "should not include date");
    assert.ok(!p.includes("Working directory:"), "should not include cwd");
    assert.ok(!p.includes("Platform:"), "should not include platform");
    assert.ok(!p.includes("Shell:"), "should not include shell");
    assert.ok(!p.includes("Home:"), "should not include home");
    assert.ok(!p.includes("`read`"), "should not include formatted tool names");
  });

  it("directs the agent to recover from blockers or give a concrete next action", () => {
    const p = buildStaticPrefix();
    assert.match(p, /Treat blockers as problems to work through/);
    assert.match(p, /try a safe, materially different recovery/);
    assert.match(p, /the single most useful next action/);
    assert.match(p, /never imply unverified work succeeded/);
  });

  it("does NOT contain the model name (it lives in the session prefix so /model takes effect mid-session)", () => {
    const p = buildStaticPrefix({ model: "@cf/moonshotai/kimi-k2.6" });
    assert.ok(!p.includes("kimi-k2.6"), "static prefix must not name a specific model");
    assert.ok(!p.includes("powered by"), "static prefix must not claim a powering model");
  });
});

describe("buildSessionPrefix", () => {
  it("changes when mode changes", () => {
    const edit = buildSessionPrefix({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m", mode: "edit" });
    const plan = buildSessionPrefix({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m", mode: "plan" });
    assert.notStrictEqual(edit, plan);
  });

  it("contains environment and tools", () => {
    const p = buildSessionPrefix({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m" });
    assert.ok(p.includes("Working directory:"));
    assert.ok(p.includes("read"));
  });

  it("includes LSP guidance when LSP tools are present", () => {
    const lspTools: ToolSpec[] = [
      ...DUMMY_TOOLS,
      { name: "lsp_definition", description: "Go to definition.", parameters: { type: "object", properties: {}, required: [] }, needsPermission: false, run: async () => "" },
    ];
    const p = buildSessionPrefix({ cwd: "/tmp", tools: lspTools, model: "m" });
    assert.ok(p.includes("LSP tools are available"));
    assert.ok(p.includes("lsp_definition"));
  });

  it("excludes LSP guidance when no LSP tools are present", () => {
    const p = buildSessionPrefix({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m" });
    assert.ok(!p.includes("LSP tools are available"));
  });

  it("names the current model so /model switches take effect mid-session", () => {
    const p = buildSessionPrefix({
      cwd: "/tmp",
      tools: DUMMY_TOOLS,
      model: "anthropic/claude-opus-4-7",
    });
    assert.ok(
      p.includes("anthropic/claude-opus-4-7"),
      "session prefix must include the current model id verbatim",
    );
    assert.ok(
      p.includes("If the user asks what model you are"),
      "session prefix must include the override instruction so recalled memory loses the tug-of-war",
    );
  });
});

describe("buildSystemMessages", () => {
  it("produces two system messages when cacheStable is used", () => {
    const msgs = buildSystemMessages({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m", mode: "edit" });
    assert.strictEqual(msgs.length, 2);
    assert.strictEqual(msgs[0]!.role, "system");
    assert.strictEqual(msgs[1]!.role, "system");
    assert.ok(typeof msgs[0]!.content === "string");
    assert.ok(typeof msgs[1]!.content === "string");
  });

  it("static message is identical across different modes", () => {
    const editMsgs = buildSystemMessages({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m", mode: "edit" });
    const planMsgs = buildSystemMessages({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m", mode: "plan" });
    assert.strictEqual(editMsgs[0]!.content, planMsgs[0]!.content);
  });
});

describe("buildSystemPrompt", () => {
  it("concatenates static and session prefixes", () => {
    const full = buildSystemPrompt({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m", mode: "edit" });
    const staticP = buildStaticPrefix({ model: "m" });
    const sessionP = buildSessionPrefix({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m", mode: "edit" });
    assert.strictEqual(full, staticP + "\n\n" + sessionP);
  });

  it("adds a per-turn delegation directive only when provided", () => {
    const ordinary = buildSystemPrompt({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m" });
    const advised = buildSystemPrompt({
      cwd: "/tmp",
      tools: DUMMY_TOOLS,
      model: "m",
      delegationDirective: "Do not call spawn_worker this turn.",
    });
    assert.doesNotMatch(ordinary, /Subagent policy for this turn/);
    assert.match(advised, /Subagent policy for this turn/);
    assert.match(advised, /Do not call spawn_worker this turn/);
  });
});
