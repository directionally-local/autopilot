import { describe, it } from "node:test";
import assert from "node:assert";
import {
  stripTypescript,
  runInSandbox,
  buildFallbackWarning,
  resetFallbackWarningFlag,
  secureSandboxUnavailableReason,
  setSecureSandboxProbeForTesting,
  takeSandboxUnavailableWarning,
} from "./sandbox.js";
import type { ToolSpec } from "../tools/registry.js";
import type { PermissionAsker } from "../tools/executor.js";
import type { ToolContext } from "../tools/registry.js";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor } from "../tools/executor.js";
import { editTool } from "../tools/edit.js";

const mockTools: ToolSpec[] = [];

const mockExecutor = {
  list: () => [],
  run: async () => ({ content: "ok", ok: true }),
} as unknown as ToolExecutor;

const mockAskPermission: PermissionAsker = async () => "allow";

const mockCtx: ToolContext = {
  cwd: process.cwd(),
  signal: undefined,
  onTasks: undefined,
  coauthor: undefined,
  memoryManager: undefined,
  sessionId: "test",
};

// Running scripts needs the isolated-vm sandbox (there is no node:vm
// fallback any more). It is an optional dependency, so those tests skip
// without it. Resolved before any describe() so every suite registers.
const NO_SANDBOX = !(await isolatedVmAvailable()) && "isolated-vm is not installed";

describe("stripTypescript", () => {
  it("strips basic type annotations", () => {
    const ts = `const x: string = "hello";`;
    const js = stripTypescript(ts);
    assert.ok(!js.includes(": string"));
    assert.ok(js.includes("const x"));
    assert.ok(js.includes('"hello"'));
  });

  it("strips function parameter types", () => {
    const ts = `function greet(name: string): void { console.log(name); }`;
    const js = stripTypescript(ts);
    assert.ok(!js.includes(": string"));
    assert.ok(!js.includes(": void"));
    assert.ok(js.includes("function greet(name)"));
  });

  it("fails on nested parenthesis types (documented limitation)", () => {
    const ts = `function foo(x: (string | number)) { return x; }`;
    const js = stripTypescript(ts);
    // The regex-based stripper produces invalid JS for nested parens
    assert.ok(js.includes("function foo(x))"));
  });
});

describe("runInSandbox", { skip: NO_SANDBOX }, () => {
  it("executes plain JS without types", async () => {
    const result = await runInSandbox({
      code: `console.log("hello");`,
      tools: mockTools,
      executor: mockExecutor,
      askPermission: mockAskPermission,
      ctx: mockCtx,
    });
    assert.strictEqual(result.output, "hello");
    assert.strictEqual(result.error, undefined);
  });

  it("executes TS with nested types when typescript is available", async () => {
    const ts = `
      function foo(x: (string | number)): (string | number) {
        return x;
      }
      console.log(foo(42));
    `;
    const result = await runInSandbox({
      code: ts,
      tools: mockTools,
      executor: mockExecutor,
      askPermission: mockAskPermission,
      ctx: mockCtx,
    });

    // If typescript is installed in the project, this should work
    // If not, it falls back to stripTypescript and may emit a warning
    if (result.warnings && result.warnings.length > 0) {
      assert.ok(result.warnings[0]!.includes("fallback parser"));
    } else {
      assert.strictEqual(result.output, "42");
      assert.strictEqual(result.error, undefined);
    }
  });

  it("finds typescript even with a non-existent cwd", async () => {
    // loadTypescript now uses import.meta.resolve first, so it should find
    // typescript relative to kimiflare itself regardless of cwd.
    const result = await runInSandbox({
      code: `console.log(1);`,
      tools: mockTools,
      executor: mockExecutor,
      askPermission: mockAskPermission,
      ctx: { ...mockCtx, cwd: "/nonexistent/path" },
    });

    // Should execute successfully with no fallback warning
    assert.strictEqual(result.output, "1");
    assert.strictEqual(result.error, undefined);
    assert.ok(!result.warnings || result.warnings.length === 0);
  });
});

describe("buildFallbackWarning", () => {
  it("suggests installing isolated-vm for missing module errors", () => {
    const msg = buildFallbackWarning("Cannot find module 'isolated-vm'");
    assert.ok(msg.includes("is not installed"));
    assert.ok(msg.includes("npm install isolated-vm"));
  });

  it("suggests rebuild for native binding errors", () => {
    const msg = buildFallbackWarning("bindings failed to load .node file");
    assert.ok(msg.includes("native bindings are incompatible"));
    assert.ok(msg.includes("npm rebuild isolated-vm"));
  });

  it("provides a generic message for unknown errors", () => {
    const msg = buildFallbackWarning("something completely unexpected");
    assert.ok(msg.includes("could not be loaded"));
    assert.ok(msg.includes("Ensure build tools are installed"));
  });
});

async function isolatedVmAvailable(): Promise<boolean> {
  try {
    const mod = (await import("isolated-vm")) as { Isolate?: unknown; default?: { Isolate?: unknown } };
    return typeof (mod.default?.Isolate ?? mod.Isolate) === "function";
  } catch {
    return false;
  }
}

describe("sandbox unavailable warning", () => {
  it("says Code Mode is off and never offers node:vm", () => {
    const msg = buildFallbackWarning("Cannot find module 'isolated-vm'");
    assert.ok(msg.startsWith("Code Mode is off"));
    assert.ok(msg.includes("Tools are called directly instead"));
  });

  it("is shown once per session, and again for a new session", () => {
    resetFallbackWarningFlag();
    assert.ok(takeSandboxUnavailableWarning("session-a", "x"));
    assert.strictEqual(takeSandboxUnavailableWarning("session-a", "x"), null);
    assert.ok(takeSandboxUnavailableWarning("session-b", "x"));
  });

  it("probes isolated-vm and reports whether it loads", async () => {
    setSecureSandboxProbeForTesting(undefined);
    const reason = await secureSandboxUnavailableReason();
    assert.strictEqual(reason === null, await isolatedVmAvailable());
    setSecureSandboxProbeForTesting("Cannot find module 'isolated-vm'");
    assert.match((await secureSandboxUnavailableReason()) ?? "", /isolated-vm/);
    setSecureSandboxProbeForTesting(undefined);
  });
});

describe("no node:vm fallback", () => {
  it("never exposes the host process to model code", async () => {
    // The removed node:vm backend handed host intrinsics to the script, so
    // this reached the host's process.env. In the isolate the constructor
    // chain stays inside the sandbox; without isolated-vm the code does not run.
    process.env.CODE_MODE_ESCAPE_CANARY = "host-secret";
    try {
      const result = await runInSandbox({
        code: `
          let leaked = "no-process";
          try { const p = Promise.constructor("return typeof process === 'undefined' ? null : process")(); if (p) leaked = p.env.CODE_MODE_ESCAPE_CANARY; } catch (e) { leaked = "threw"; }
          console.log(leaked);
        `,
        tools: mockTools,
        executor: mockExecutor,
        askPermission: mockAskPermission,
        ctx: { ...mockCtx, sessionId: "escape-check" },
      });
      assert.ok(!result.output.includes("host-secret"), result.output);
      if (!(await isolatedVmAvailable())) assert.match(result.error ?? "", /sandbox could not run/);
    } finally {
      delete process.env.CODE_MODE_ESCAPE_CANARY;
    }
  });
});

describe("sandbox backend", () => {
  it("uses isolated-vm when it is installed (no fallback warning)", async () => {
    if (!(await isolatedVmAvailable())) return; // optional dependency absent: nothing to assert
    resetFallbackWarningFlag();
    const result = await runInSandbox({
      code: `console.log(typeof setTimeout);`,
      tools: mockTools,
      executor: mockExecutor,
      askPermission: mockAskPermission,
      ctx: { ...mockCtx, sessionId: "backend-check" },
    });
    assert.strictEqual(result.error, undefined);
    assert.deepEqual(result.warnings ?? [], []);
    // The isolate has no host setTimeout.
    assert.strictEqual(result.output, "undefined");
  });
});

describe("concurrent tool calls from a script", { skip: NO_SANDBOX }, () => {
  const { mkdtemp, readFile, writeFile } = fsPromises;

  it("keeps both edits when Promise.all targets the same file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-edit-"));
    const file = join(dir, "t.rs");
    const executor = new ToolExecutor([editTool]);
    for (let i = 0; i < 10; i++) {
      await writeFile(file, "fn a() {\n    ALPHA\n}\nfn b() {\n    BETA\n}\n", "utf8");
      const result = await runInSandbox({
        code: `console.log(JSON.stringify(await Promise.all([
          api.edit({ path: ${JSON.stringify(file)}, old_string: "ALPHA", new_string: "let alpha = 1111111111;" }),
          api.edit({ path: ${JSON.stringify(file)}, old_string: "BETA", new_string: "let b = 2;" }),
        ])));`,
        tools: [editTool],
        executor,
        askPermission: mockAskPermission,
        ctx: { cwd: dir, sessionId: "concurrent-edits" },
        timeoutMs: 10000,
      });
      assert.strictEqual(result.error, undefined, `iteration ${i}: ${result.error}`);
      assert.strictEqual(await readFile(file, "utf8"), "fn a() {\n    let alpha = 1111111111;\n}\nfn b() {\n    let b = 2;\n}\n", `iteration ${i}`);
      assert.deepEqual(result.toolCalls.map((c) => c.ok), [true, true]);
    }
  });

  it("runs mutating tools one at a time in call order while read-only tools may overlap", async () => {
    const events: string[] = [];
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const mutating: ToolSpec = {
      name: "mut",
      description: "",
      parameters: { type: "object", properties: { id: { type: "string" } } },
      needsPermission: false,
      run: async (args: { id: string }) => {
        events.push(`${args.id}:start`);
        await sleep(args.id === "m1" ? 30 : 5);
        events.push(`${args.id}:end`);
        return args.id;
      },
    };
    const readOnly: ToolSpec = { ...mutating, name: "ro", isReadOnly: true };
    const executor = new ToolExecutor([mutating, readOnly]);
    const result = await runInSandbox({
      code: `await Promise.all([
        api.mut({ id: "m1" }), api.ro({ id: "r1" }), api.mut({ id: "m2" }), api.ro({ id: "r2" }),
      ]); console.log("done");`,
      tools: [mutating, readOnly],
      executor,
      askPermission: mockAskPermission,
      ctx: { ...mockCtx, sessionId: "ordering" },
      timeoutMs: 10000,
    });
    assert.strictEqual(result.error, undefined, result.error);
    const m = events.filter((e) => e.startsWith("m"));
    assert.deepEqual(m, ["m1:start", "m1:end", "m2:start", "m2:end"], "mutating calls must not interleave");
    assert.ok(result.toolCalls.every((c) => c.ok));
  });

  it("marks a failed inner call as not ok instead of reporting success", async () => {
    const dir = await mkdtemp(join(tmpdir(), "sandbox-edit-"));
    const executor = new ToolExecutor([editTool]);
    const result = await runInSandbox({
      code: `console.log(await api.edit({ path: "missing.txt", old_string: "a", new_string: "b" }));`,
      tools: [editTool],
      executor,
      askPermission: mockAskPermission,
      ctx: { cwd: dir, sessionId: "failed-call" },
    });
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0]!.ok, false);
  });
});
