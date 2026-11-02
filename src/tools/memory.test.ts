import { describe, it } from "node:test";
import assert from "node:assert";
import { ToolExecutor, ALL_TOOLS, MEMORY_TOOL_NAMES, toolsForSession } from "./executor.js";
import type { MemoryManager } from "../memory/manager.js";

const allowAll = async () => "allow" as const;

const CALLS: Array<{ name: string; arguments: string }> = [
  { name: "memory_remember", arguments: JSON.stringify({ content: "We use pnpm.", category: "fact", importance: 3 }) },
  { name: "memory_recall", arguments: JSON.stringify({ query: "which package manager?" }) },
  { name: "memory_forget", arguments: JSON.stringify({ memory_id: "123_abc" }) },
];

describe("memory tools while memory is disabled (#1077)", () => {
  const exec = new ToolExecutor(ALL_TOOLS);

  for (const call of CALLS) {
    it(`${call.name} returns ok:false, never a successful "not enabled"`, async () => {
      const result = await exec.run(
        { id: "t1", ...call },
        allowAll,
        { cwd: process.cwd(), memoryManager: null, sessionId: "s1" },
      );
      assert.strictEqual(result.ok, false);
      assert.strictEqual(result.errorCode, "policy_rejection");
      assert.match(result.content, /Memory is not enabled/);
      assert.ok(!result.content.startsWith("Memory stored"), "must not look like success");
    });
  }

  it("fails the same way when the context carries no memoryManager at all", async () => {
    const result = await exec.run({ id: "t2", ...CALLS[1]! }, allowAll, { cwd: process.cwd(), sessionId: "s1" });
    assert.strictEqual(result.ok, false);
    assert.strictEqual(result.errorCode, "policy_rejection");
  });
});

describe("memory tools with a manager present", () => {
  const stub = {
    remember: async () => ({ id: "m1" }),
    recall: async () => [],
    forget: async () => true,
  } as unknown as MemoryManager;
  const exec = new ToolExecutor(ALL_TOOLS);
  const ctx = { cwd: process.cwd(), memoryManager: stub, sessionId: "s1" };

  it("memory_remember reports the stored id", async () => {
    const result = await exec.run({ id: "t3", ...CALLS[0]! }, allowAll, ctx);
    assert.strictEqual(result.ok, true);
    assert.match(result.content, /Memory stored with id m1/);
  });

  it("memory_recall reports an empty result set as a normal outcome", async () => {
    const result = await exec.run({ id: "t4", ...CALLS[1]! }, allowAll, ctx);
    assert.strictEqual(result.ok, true);
    assert.match(result.content, /No relevant memories found/);
  });

  it("memory_forget confirms the forget", async () => {
    const result = await exec.run({ id: "t5", ...CALLS[2]! }, allowAll, ctx);
    assert.strictEqual(result.ok, true);
    assert.match(result.content, /marked as forgotten/);
  });
});

describe("toolsForSession (#1077)", () => {
  it("drops the memory tools when memoryEnabled is false", () => {
    const names = toolsForSession({ memoryEnabled: false }).map((t) => t.name);
    for (const name of MEMORY_TOOL_NAMES) {
      assert.ok(!names.includes(name), `${name} must not be advertised while memory is off`);
    }
    assert.ok(names.includes("read"), "non-memory tools stay");
  });

  it("keeps them when memoryEnabled is unset (the TUI default is on)", () => {
    const names = toolsForSession().map((t) => t.name);
    for (const name of MEMORY_TOOL_NAMES) {
      assert.ok(names.includes(name), `${name} should be advertised by default`);
    }
  });

  it("keeps them when memoryEnabled is true", () => {
    const names = toolsForSession({ memoryEnabled: true }).map((t) => t.name);
    for (const name of MEMORY_TOOL_NAMES) {
      assert.ok(names.includes(name));
    }
  });

  it("appends host-registered tools (MCP, LSP) after the base set", () => {
    const extra = {
      name: "mcp_thing",
      description: "An external tool.",
      parameters: { type: "object", properties: {}, required: [] },
      needsPermission: false,
      run: async () => "",
    };
    const names = toolsForSession({ memoryEnabled: false, extra: [extra] }).map((t) => t.name);
    assert.ok(names.includes("mcp_thing"));
    assert.ok(!names.includes("memory_remember"));
  });
});
