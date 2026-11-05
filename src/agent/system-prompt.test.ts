import { describe, it } from "node:test";
import assert from "node:assert";
import { buildStaticPrefix, buildSessionPrefix, buildSystemMessages, buildSystemPrompt } from "./system-prompt.js";
import type { ToolSpec } from "../tools/registry.js";
import { noteActiveProvider } from "../providers/resolve.js";

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
  it("introduces itself as Autopilot and credits Autopilot in commits; under dl, as dl", () => {
    const prev = process.env.AUTOPILOT_LAUNCHED_BY;
    try {
      delete process.env.AUTOPILOT_LAUNCHED_BY;
      const p = buildStaticPrefix({ model: "m" });
      assert.ok(p.startsWith("You are Autopilot, an interactive coding assistant"));
      assert.ok(p.includes("`Co-authored-by: Autopilot <autopilot@directionallylocal.com>`"));
      assert.doesNotMatch(p, /kimiflare/i);
      process.env.AUTOPILOT_LAUNCHED_BY = "dl";
      const dl = buildStaticPrefix({ model: "m" });
      assert.ok(dl.startsWith("You are dl, an interactive coding assistant"));
      assert.ok(dl.includes("`Co-authored-by: dl <dl@directionallylocal.com>` in the commit message so dl is credited"));
      assert.doesNotMatch(dl, /kimiflare|autopilot/i);
    } finally {
      if (prev === undefined) delete process.env.AUTOPILOT_LAUNCHED_BY;
      else process.env.AUTOPILOT_LAUNCHED_BY = prev;
    }
  });

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

  it("prioritizes the newest request over old conversation history", () => {
    const p = buildStaticPrefix();
    assert.match(p, /Always respond to the newest user message/);
    assert.match(p, /Use prior messages to interpret follow-ups and maintain context/);
    assert.match(p, /do not answer an earlier message instead of addressing the latest one/);
  });

  it("proactively asks for a visible checklist for multi-step requests", () => {
    const p = buildStaticPrefix();
    assert.match(p, /two or more distinct steps, proactively create a visible checklist/);
    assert.match(p, /before doing work/);
    assert.match(p, /skip it only for a genuinely quick single-action request/i);
    assert.match(p, /never spend a model response on `tasks_set` alone/);
    assert.match(p, /same response as the next substantive tool call/);
    assert.match(p, /final all-completed update with the final substantive tool call/);
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

  it("advertises the memory tools by default (TUI memory is on, #1077)", () => {
    const p = buildStaticPrefix({ model: "m" });
    assert.match(p, /cross-session memory tools/);
    assert.match(p, /memory_remember/);
  });

  it("omits the memory bullet when memory is disabled, without leaving a gap (#1077)", () => {
    const p = buildStaticPrefix({ model: "m", memoryEnabled: false });
    assert.ok(!p.includes("cross-session memory tools"), "must not advertise disabled tools");
    assert.ok(!p.includes("memory_remember"));
    // The bullet list stays contiguous: no blank line where the bullet was.
    assert.ok(!p.includes("failing CI.\n\n- Use `search_web`"), "no gap after the PR bullets");
    assert.match(p, /failing CI\.\n- Use `search_web`/);
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

  it("includes artifact-selection guidance only when the artifact tool is available", () => {
    const artifactTool: ToolSpec = {
      name: "create_artifact",
      description: "Create and open a temporary HTML artifact.",
      parameters: { type: "object", properties: {}, required: [] },
      needsPermission: true,
      run: async () => "",
    };
    const withArtifact = buildSessionPrefix({ cwd: "/tmp", tools: [...DUMMY_TOOLS, artifactTool], model: "m" });
    const withoutArtifact = buildSessionPrefix({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "m" });
    assert.match(withArtifact, /Choosing when to create an artifact/);
    assert.match(withArtifact, /Prefer a normal terminal response for brief answers/);
    assert.match(withArtifact, /first use `write` to save the complete HTML document/);
    assert.match(withArtifact, /workspace-relative `sourcePath`/);
    assert.match(withArtifact, /Never put the full HTML document in `create_artifact` arguments/);
    assert.ok(!withoutArtifact.includes("Choosing when to create an artifact"));
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

  it("adds the DeepSeek profile guidance only for DeepSeek V4 models", () => {
    const deepseek = buildSessionPrefix({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "deepseek/deepseek-v4.1-flash" });
    assert.match(deepseek, /Model-specific tool guidance/);
    assert.match(deepseek, /Use the `read` tool to view files/);
    assert.match(deepseek, /always include both `old_string` and `new_string`/);

    const other = buildSessionPrefix({ cwd: "/tmp", tools: DUMMY_TOOLS, model: "openai/gpt-6-luna" });
    assert.doesNotMatch(other, /Model-specific tool guidance/);
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

});

describe("model identity names the provider", () => {
  it("names the provider passed in, or the one the loaded config uses", () => {
    const base = { cwd: process.cwd(), tools: [], model: "deepseek-v4-pro" };
    assert.match(buildSessionPrefix({ ...base, provider: "DeepSeek" }), /powered by the deepseek-v4-pro model, served through DeepSeek\./);
    noteActiveProvider("ollama");
    assert.match(buildSessionPrefix(base), /served through Ollama\./);
    assert.doesNotMatch(buildSessionPrefix(base), /served through OpenRouter/);
  });
});
