import { describe, it } from "node:test";
import assert from "node:assert";
import { decidePermission, resolvePermission } from "./use-permission-controller.js";
import type { PermissionRequest } from "../tools/executor.js";

function req(toolName: string, args: Record<string, unknown> = {}): PermissionRequest {
  return {
    tool: { name: toolName } as PermissionRequest["tool"],
    args,
    sessionKey: toolName,
  };
}

describe("decidePermission", () => {
  describe("auto mode", () => {
    it("resolves any tool with allow", () => {
      assert.deepStrictEqual(decidePermission(req("bash", { command: "rm -rf /" }), "auto"), {
        kind: "resolve",
        decision: { decision: "allow", scope: "once" },
      });
      assert.deepStrictEqual(decidePermission(req("write"), "auto"), {
        kind: "resolve",
        decision: { decision: "allow", scope: "once" },
      });
    });
  });

  describe("plan mode", () => {
    it("prompts for non-blocked tools (e.g. read)", () => {
      assert.deepStrictEqual(decidePermission(req("read"), "plan"), { kind: "prompt" });
    });

    it("auto-allows read-only bash without prompting", () => {
      assert.deepStrictEqual(decidePermission(req("bash", { command: "git status" }), "plan"), {
        kind: "resolve",
        decision: { decision: "allow", scope: "once" },
      });
    });

    it("blocks mutating bash by default", () => {
      assert.deepStrictEqual(decidePermission(req("bash", { command: "rm -rf node_modules" }), "plan"), {
        kind: "plan_blocked",
        toolName: "bash",
      });
    });

    it("prompts for mutating bash when promptOnBlockedBash is true", () => {
      assert.deepStrictEqual(
        decidePermission(req("bash", { command: "npm install" }), "plan", {
          promptOnBlockedBash: true,
        }),
        { kind: "prompt" },
      );
    });

    it("does NOT escape-hatch non-bash blocked tools even with promptOnBlockedBash", () => {
      assert.deepStrictEqual(
        decidePermission(req("write"), "plan", { promptOnBlockedBash: true }),
        { kind: "plan_blocked", toolName: "write" },
      );
    });

    it("blocks write and edit", () => {
      assert.deepStrictEqual(decidePermission(req("write"), "plan"), {
        kind: "plan_blocked",
        toolName: "write",
      });
      assert.deepStrictEqual(decidePermission(req("edit"), "plan"), {
        kind: "plan_blocked",
        toolName: "edit",
      });
    });

    it("blocks MCP tools", () => {
      assert.deepStrictEqual(decidePermission(req("mcp_github_create_issue"), "plan"), {
        kind: "plan_blocked",
        toolName: "mcp_github_create_issue",
      });
    });
  });

  describe("edit mode", () => {
    it("prompts for mutating tools", () => {
      assert.deepStrictEqual(decidePermission(req("bash", { command: "npm install" }), "edit"), {
        kind: "prompt",
      });
      assert.deepStrictEqual(decidePermission(req("write"), "edit"), { kind: "prompt" });
    });

    it("also prompts for read-only tools (the executor decides per spec.needsPermission)", () => {
      assert.deepStrictEqual(decidePermission(req("read"), "edit"), { kind: "prompt" });
    });

    it("ignores promptOnBlockedBash (irrelevant outside plan mode)", () => {
      assert.deepStrictEqual(
        decidePermission(req("bash", { command: "npm test" }), "edit", {
          promptOnBlockedBash: true,
        }),
        { kind: "prompt" },
      );
    });
  });
});

describe("resolvePermission — PermissionRequest hooks (#891)", () => {
  const host = (prompts: string[], blocked: string[] = []) => ({
    onPlanModeBlocked: (t: string) => void blocked.push(t),
    prompt: async () => {
      prompts.push("prompt");
      return "allow" as const;
    },
  });
  const withHook = (decision: "allow" | "deny" | null, calls: string[]): PermissionRequest => ({
    ...req("write"),
    firePermissionHook: async (mode) => {
      calls.push(mode);
      return decision ? { decision } : null;
    },
  });

  it("a hook's deny answers without prompting", async () => {
    const prompts: string[] = [];
    const calls: string[] = [];
    assert.deepStrictEqual(await resolvePermission(withHook("deny", calls), "edit", {}, host(prompts)), { decision: "deny", scope: "once" });
    assert.deepStrictEqual(prompts, []);
    assert.deepStrictEqual(calls, ["edit"]);
  });

  it("a hook's allow skips the prompt", async () => {
    const prompts: string[] = [];
    assert.deepStrictEqual(await resolvePermission(withHook("allow", []), "edit", {}, host(prompts)), { decision: "allow", scope: "once" });
    assert.deepStrictEqual(prompts, []);
  });

  it("no decision shows the prompt", async () => {
    const prompts: string[] = [];
    await resolvePermission(withHook(null, []), "edit", {}, host(prompts));
    assert.deepStrictEqual(prompts, ["prompt"]);
  });

  it("plan mode's block and auto mode's allow come first; the hook isn't asked", async () => {
    const calls: string[] = [];
    const blocked: string[] = [];
    assert.deepStrictEqual(await resolvePermission(withHook("allow", calls), "plan", {}, host([], blocked)), { decision: "deny", scope: "once" });
    assert.deepStrictEqual(blocked, ["write"]);
    await resolvePermission(withHook("deny", calls), "auto", {}, host([]));
    assert.deepStrictEqual(calls, []);
  });
});
