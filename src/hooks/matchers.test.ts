import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { filterHooks } from "./runner.js";
import { hookMatcherMatches, hookMatcherNames } from "./claude-compat.js";
import { HooksManager } from "./manager.js";
import { projectSettingsPath } from "./settings.js";
import type { HookConfig } from "./types.js";

const hook = (matcher: string | undefined, id = matcher ?? "none"): HookConfig => ({ id, command: "x", ...(matcher !== undefined ? { matcher } : {}) });
const ids = (hooks: HookConfig[]) => hooks.map((h) => h.id);

describe("hookMatcherNames (#890)", () => {
  it("tries the native name and the Claude Code name", () => {
    assert.deepStrictEqual(hookMatcherNames("bash"), ["bash", "Bash"]);
    assert.deepStrictEqual(hookMatcherNames("web_fetch"), ["web_fetch", "WebFetch"]);
    assert.deepStrictEqual(hookMatcherNames("edit", { path: "a" }), ["edit", "Edit"]);
  });

  it("adds MultiEdit for an edit carrying edits[]", () => {
    assert.deepStrictEqual(hookMatcherNames("edit", { path: "a", edits: [] }), ["edit", "Edit", "MultiEdit"]);
  });

  it("tools without a Claude name keep only their own", () => {
    assert.deepStrictEqual(hookMatcherNames("mcp_github_search"), ["mcp_github_search"]);
  });
});

describe("filterHooks matchers (#890)", () => {
  it("native name still matches", () => {
    assert.deepStrictEqual(ids(filterHooks([hook("bash"), hook("^bash$", "anchored")], "bash")), ["bash", "anchored"]);
  });

  it("Claude Code name matches the native call", () => {
    assert.deepStrictEqual(ids(filterHooks([hook("Bash")], "bash")), ["Bash"]);
    assert.deepStrictEqual(ids(filterHooks([hook("^Write$")], "write")), ["^Write$"]);
    assert.deepStrictEqual(ids(filterHooks([hook("WebSearch")], "search_web")), ["WebSearch"]);
  });

  it("alternation mixes either naming", () => {
    const h = hook("Bash|Edit");
    assert.strictEqual(filterHooks([h], "bash").length, 1);
    assert.strictEqual(filterHooks([h], "edit").length, 1);
    assert.strictEqual(filterHooks([h], "write").length, 0);
    assert.strictEqual(filterHooks([hook("^(Edit|write)$")], "edit").length, 1);
    assert.strictEqual(filterHooks([hook("^(Edit|write)$")], "write").length, 1);
  });

  it("is case-sensitive: bash and Bash match, BASH and bAsH do not", () => {
    assert.strictEqual(filterHooks([hook("bash")], "bash").length, 1);
    assert.strictEqual(filterHooks([hook("Bash")], "bash").length, 1);
    assert.strictEqual(filterHooks([hook("BASH")], "bash").length, 0);
    assert.strictEqual(filterHooks([hook("^bAsH$")], "bash").length, 0);
  });

  it("* and an empty matcher match every tool", () => {
    for (const tool of ["bash", "edit", "mcp_x_y"]) {
      assert.strictEqual(filterHooks([hook("*")], tool).length, 1, `* on ${tool}`);
      assert.strictEqual(filterHooks([hook("")], tool).length, 1, `"" on ${tool}`);
      assert.strictEqual(filterHooks([hook(undefined)], tool).length, 1, `no matcher on ${tool}`);
    }
  });

  it("keeps regex semantics (unanchored, malformed matches nothing)", () => {
    assert.strictEqual(filterHooks([hook("^mcp_")], "mcp_github_search").length, 1);
    assert.strictEqual(filterHooks([hook("dit")], "edit").length, 1);
    assert.strictEqual(filterHooks([hook("([")], "edit").length, 0);
    assert.strictEqual(hookMatcherMatches("([", ["edit", "Edit"]), false);
  });

  it("MultiEdit matches only when the names include it", () => {
    assert.strictEqual(filterHooks([hook("^MultiEdit$")], "edit").length, 0);
    assert.strictEqual(filterHooks([hook("^MultiEdit$")], hookMatcherNames("edit", { edits: [] })).length, 1);
  });
});

describe("HooksManager.fire uses both names (#890)", () => {
  let dir: string;
  let xdg: string;
  let savedXdg: string | undefined;
  before(() => {
    savedXdg = process.env.XDG_CONFIG_HOME;
    xdg = mkdtempSync(join(tmpdir(), "hooks-match-xdg-"));
    process.env.XDG_CONFIG_HOME = xdg;
    dir = mkdtempSync(join(tmpdir(), "hooks-match-proj-"));
  });
  after(() => {
    if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = savedXdg;
    rmSync(xdg, { recursive: true, force: true });
    rmSync(dir, { recursive: true, force: true });
  });

  it("runs Bash / MultiEdit matchers on native calls", async () => {
    const path = projectSettingsPath(dir);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            { id: "claude-bash", matcher: "Bash", command: "echo claude-bash" },
            { id: "multi", matcher: "^MultiEdit$", command: "echo multi" },
            { id: "upper", matcher: "BASH", command: "echo upper" },
          ],
        },
      }),
    );
    const m = new HooksManager(dir);
    const base = { event: "PreToolUse" as const, session_id: null, cwd: dir, tool_call_id: "t" };
    const bash = await m.fire("PreToolUse", { ...base, tool: "bash", args: { command: "true" } }, "bash");
    assert.deepStrictEqual(bash.outcomes.map((o) => o.id), ["claude-bash"]);
    const multi = await m.fire("PreToolUse", { ...base, tool: "edit", args: { path: "a", edits: [] } }, "edit");
    assert.deepStrictEqual(multi.outcomes.map((o) => o.id), ["multi"]);
    const single = await m.fire("PreToolUse", { ...base, tool: "edit", args: { path: "a", old_string: "x", new_string: "y" } }, "edit");
    assert.deepStrictEqual(single.outcomes.map((o) => o.id), []);
  });
});
