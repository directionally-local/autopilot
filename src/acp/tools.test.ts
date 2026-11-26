import { describe, it } from "node:test";
import assert from "node:assert";
import {
  toAcpToolCall,
  toAcpToolUpdate,
  permissionOptions,
  fromAcpPermissionOutcome,
  destructivePermissionOptions,
} from "./tools.js";
import type { ToolCall } from "../agent/messages.js";
import type { ToolResult } from "../tools/executor.js";

// ---------------------------------------------------------------------------
// toAcpToolCall
// ---------------------------------------------------------------------------

describe("toAcpToolCall", () => {
  it("maps a read tool call", () => {
    const tc: ToolCall = {
      id: "tc-1",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "/tmp/foo.ts", offset: 10, limit: 20 }),
      },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.toolCallId, "tc-1");
    assert.strictEqual(result.kind, "read");
    assert.strictEqual(result.status, "in_progress");
    assert.strictEqual(result.title, "Read /tmp/foo.ts (10-29)");
    assert.deepStrictEqual(result.locations, [{ path: "/tmp/foo.ts", line: 10 }]);
    assert.deepStrictEqual(result.content, []);
  });

  it("maps a read tool call with no offset/limit", () => {
    const tc: ToolCall = {
      id: "tc-2",
      type: "function",
      function: {
        name: "read",
        arguments: JSON.stringify({ path: "/tmp/bar.ts" }),
      },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.title, "Read /tmp/bar.ts");
    assert.deepStrictEqual(result.locations, [{ path: "/tmp/bar.ts", line: 1 }]);
  });

  it("maps a write tool call with diff content", () => {
    const tc: ToolCall = {
      id: "tc-3",
      type: "function",
      function: {
        name: "write",
        arguments: JSON.stringify({ path: "/tmp/new.ts", content: "hello world" }),
      },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.kind, "edit");
    assert.strictEqual(result.title, "Write /tmp/new.ts");
    assert.strictEqual(result.content!.length, 1);
    assert.strictEqual(result.content![0]!.type, "diff");
    const diff = result.content![0] as { type: "diff"; path: string; oldText: null; newText: string };
    assert.strictEqual(diff.oldText, null);
    assert.strictEqual(diff.newText, "hello world");
  });

  it("maps an edit tool call with diff content", () => {
    const tc: ToolCall = {
      id: "tc-4",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({
          path: "/tmp/file.ts",
          old_string: "foo",
          new_string: "bar",
        }),
      },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.kind, "edit");
    assert.strictEqual(result.title, "Edit /tmp/file.ts");
    const diff = result.content![0] as { type: "diff"; oldText: string; newText: string };
    assert.strictEqual(diff.oldText, "foo");
    assert.strictEqual(diff.newText, "bar");
  });

  it("maps a bash tool call", () => {
    const tc: ToolCall = {
      id: "tc-5",
      type: "function",
      function: {
        name: "bash",
        arguments: JSON.stringify({ command: "cd /tmp && ls -la" }),
      },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.kind, "execute");
    assert.strictEqual(result.title, "$ ls -la");
  });

  it("truncates bash title to 120 chars", () => {
    const longCmd = "echo " + "x".repeat(200);
    const tc: ToolCall = {
      id: "tc-6",
      type: "function",
      function: { name: "bash", arguments: JSON.stringify({ command: longCmd }) },
    };
    const result = toAcpToolCall(tc);
    assert.ok(result.title.length <= 120);
  });

  it("maps glob and grep to search kind", () => {
    const glob: ToolCall = {
      id: "tc-7",
      type: "function",
      function: { name: "glob", arguments: JSON.stringify({ pattern: "**/*.ts" }) },
    };
    assert.strictEqual(toAcpToolCall(glob).kind, "search");
    assert.strictEqual(toAcpToolCall(glob).title, "Find **/*.ts");

    const grep: ToolCall = {
      id: "tc-8",
      type: "function",
      function: {
        name: "grep",
        arguments: JSON.stringify({ pattern: "TODO", path: "/src", case_insensitive: true }),
      },
    };
    const grepResult = toAcpToolCall(grep);
    assert.strictEqual(grepResult.kind, "search");
    assert.ok(grepResult.title.includes("grep -i"));
    assert.ok(grepResult.title.includes('"TODO"'));
  });

  it("truncates grep title to 120 chars", () => {
    const longPattern = "x".repeat(200);
    const tc: ToolCall = {
      id: "tc-9",
      type: "function",
      function: { name: "grep", arguments: JSON.stringify({ pattern: longPattern }) },
    };
    const result = toAcpToolCall(tc);
    assert.ok(result.title.length <= 120);
  });

  it("maps web_fetch to fetch kind", () => {
    const tc: ToolCall = {
      id: "tc-10",
      type: "function",
      function: {
        name: "web_fetch",
        arguments: JSON.stringify({ url: "https://example.com" }),
      },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.kind, "fetch");
    assert.strictEqual(result.title, "GET https://example.com");
  });

  it("truncates web_fetch title to 120 chars", () => {
    const longUrl = "https://example.com/" + "a".repeat(200);
    const tc: ToolCall = {
      id: "tc-11",
      type: "function",
      function: { name: "web_fetch", arguments: JSON.stringify({ url: longUrl }) },
    };
    const result = toAcpToolCall(tc);
    assert.ok(result.title.length <= 120);
  });

  it("maps tasks_set to think kind", () => {
    const tc: ToolCall = {
      id: "tc-12",
      type: "function",
      function: {
        name: "tasks_set",
        arguments: JSON.stringify({ tasks: [{ id: "1", title: "a" }] }),
      },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.kind, "think");
    assert.strictEqual(result.title, "Update tasks (1 items)");
  });

  it("maps unknown tools to other kind", () => {
    const tc: ToolCall = {
      id: "tc-13",
      type: "function",
      function: { name: "mcp_custom_tool", arguments: "{}" },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.kind, "other");
    assert.strictEqual(result.title, "mcp_custom_tool");
  });

  it("handles malformed JSON arguments gracefully", () => {
    const tc: ToolCall = {
      id: "tc-14",
      type: "function",
      function: { name: "read", arguments: "not valid json{" },
    };
    // Should not throw
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.toolCallId, "tc-14");
    assert.strictEqual(result.kind, "read");
    // Falls back to generic title with no path
    assert.strictEqual(result.title, "Read file");
  });

  it("handles empty arguments string", () => {
    const tc: ToolCall = {
      id: "tc-15",
      type: "function",
      function: { name: "bash", arguments: "" },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.title, "$ ");
  });

  it("includes rawInput in the result", () => {
    const tc: ToolCall = {
      id: "tc-16",
      type: "function",
      function: { name: "read", arguments: JSON.stringify({ path: "/x" }) },
    };
    const result = toAcpToolCall(tc);
    assert.deepStrictEqual(result.rawInput, { path: "/x" });
  });

  it("maps edit with replace_all flag", () => {
    const tc: ToolCall = {
      id: "tc-17",
      type: "function",
      function: {
        name: "edit",
        arguments: JSON.stringify({
          path: "/tmp/f.ts",
          old_string: "a",
          new_string: "b",
          replace_all: true,
        }),
      },
    };
    const result = toAcpToolCall(tc);
    assert.strictEqual(result.title, "Edit /tmp/f.ts (replace_all)");
  });
});

// ---------------------------------------------------------------------------
// toAcpToolUpdate
// ---------------------------------------------------------------------------

describe("toAcpToolUpdate", () => {
  it("maps a successful tool result", () => {
    const result: ToolResult = {
      tool_call_id: "tc-1",
      name: "read",
      content: "file contents here",
      ok: true,
    };
    const update = toAcpToolUpdate(result);
    assert.strictEqual(update.toolCallId, "tc-1");
    assert.strictEqual(update.status, "completed");
    assert.strictEqual(update.content!.length, 1);
    assert.strictEqual(update.content![0]!.type, "content");
    assert.strictEqual(update.rawOutput, "file contents here");
  });

  it("maps a failed tool result", () => {
    const result: ToolResult = {
      tool_call_id: "tc-2",
      name: "bash",
      content: "Error: command not found",
      ok: false,
    };
    const update = toAcpToolUpdate(result);
    assert.strictEqual(update.status, "failed");
    assert.strictEqual(update.rawOutput, "Error: command not found");
  });

  it("handles empty content", () => {
    const result: ToolResult = {
      tool_call_id: "tc-3",
      name: "write",
      content: "",
      ok: true,
    };
    const update = toAcpToolUpdate(result);
    assert.strictEqual(update.status, "completed");
    assert.strictEqual(update.content, undefined);
  });
});

// ---------------------------------------------------------------------------
// permissionOptions
// ---------------------------------------------------------------------------

describe("permissionOptions", () => {
  it("returns three options with correct kinds", () => {
    const opts = permissionOptions();
    assert.strictEqual(opts.length, 3);
    assert.strictEqual(opts[0]!.kind, "allow_once");
    assert.strictEqual(opts[1]!.kind, "allow_always");
    assert.strictEqual(opts[2]!.kind, "reject_once");
  });

  it("has unique option IDs", () => {
    const opts = permissionOptions();
    const ids = opts.map((o) => o.optionId);
    assert.strictEqual(new Set(ids).size, 3);
  });
});

// ---------------------------------------------------------------------------
// fromAcpPermissionOutcome
// ---------------------------------------------------------------------------

describe("fromAcpPermissionOutcome", () => {
  const selected = (optionId: string) => ({ outcome: "selected" as const, optionId });

  it("maps cancelled, deny and unknown options to deny", () => {
    for (const outcome of [{ outcome: "cancelled" as const }, selected("deny"), selected("unknown_thing")]) {
      assert.deepStrictEqual(fromAcpPermissionOutcome(outcome), { decision: "deny", scope: "once" });
    }
  });

  it("maps allow_once and allow_session to their scopes", () => {
    assert.deepStrictEqual(fromAcpPermissionOutcome(selected("allow_once")), { decision: "allow", scope: "once" });
    assert.deepStrictEqual(fromAcpPermissionOutcome(selected("allow_session")), { decision: "allow", scope: "session" });
  });

  it("an irreversible action is confirmed only by allow_once, never for the session", () => {
    assert.deepStrictEqual(fromAcpPermissionOutcome(selected("allow_once"), { destructive: true }), {
      decision: "allow",
      scope: "once",
      irreversibleConfirmed: true,
    });
    assert.deepStrictEqual(fromAcpPermissionOutcome(selected("allow_session"), { destructive: true }), { decision: "deny", scope: "once" });
    assert.deepStrictEqual(
      destructivePermissionOptions().map((o) => o.kind),
      ["allow_once", "reject_once"],
    );
  });
});

describe("toAcpToolCall paths", () => {
  it("resolves relative paths against the session folder (ACP wants absolute paths)", () => {
    const call = toAcpToolCall({ id: "c1", type: "function", function: { name: "edit", arguments: JSON.stringify({ path: "src/a.ts", old_string: "a", new_string: "b" }) } }, "/work/repo");
    assert.deepStrictEqual(call.locations, [{ path: "/work/repo/src/a.ts" }]);
    assert.strictEqual((call.content?.[0] as { path: string }).path, "/work/repo/src/a.ts");
  });
});
