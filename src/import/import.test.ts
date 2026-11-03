/**
 * Bringing in setup from other coding agents (#1126), against a fake home
 * folder holding a realistic Claude Code + Cursor setup. Never reads the
 * real home folder.
 */
import { after, before, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildInstructionsBlock, findImports, loadInstructions, MAX_FILE_BYTES } from "./instructions.js";
import { deniedBy, importedDenyFor, loadDenyRules } from "./permissions.js";
import {
  createImportedMcpTool,
  discoverMcpServers,
  displayCommand,
  importedMcpPromptFor,
  resetMcpSessionState,
  type McpLaunch,
} from "./mcp.js";
import { loadClaudeCommands } from "./commands.js";
import { formatChecklist, formatSessionLine, scanSetup, sessionStartNotice, setupImportReport } from "./setup.js";
import { loadCustomCommands } from "../commands/loader.js";
import { renderCommand } from "../commands/renderer.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import { resolvePermission, type SetupPrompt } from "../ui/use-permission-controller.js";

const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

let base: string;
let home: string;
let repo: string;
let state: string;

function write(path: string, text: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}

function json(path: string, value: unknown): void {
  write(path, JSON.stringify(value, null, 2));
}

/** Every file under `dir` with its size and modification time. */
function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else {
        const s = statSync(p, { throwIfNoEntry: false });
        out.push(`${p}:${s?.size}:${s?.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out.sort();
}

function buildFixture(): void {
  // scripts/test-setup.mjs (#1142) gives this process a temporary HOME and
  // XDG folders; the fake Claude Code + Cursor setup goes there.
  assert.ok(process.env.AUTOPILOT_TEST_ROOT, "run through npm test / npm run test:file");
  home = process.env.HOME!;
  state = process.env.XDG_STATE_HOME!;
  base = mkdtempSync(join(process.env.AUTOPILOT_TEST_ROOT!, "ap-import-"));
  repo = join(base, "repo");
  mkdirSync(join(repo, ".git"), { recursive: true });

  // ── Claude Code, personal ──
  write(join(home, ".claude", "CLAUDE.md"), "# Personal\nAlways answer in British English.\n@~/.claude/tone.md\n");
  write(join(home, ".claude", "tone.md"), "Keep replies short.\n");
  json(join(home, ".claude", "settings.json"), {
    permissions: {
      allow: ["Bash(*)", "Read(**)", "WebFetch"],
      deny: ["Bash(rm -rf:*)", "Bash(git push)", "Read(./.env)", "Read(./secrets/**)", "Edit(./infra/**)", "WebFetch(domain:evil.example)", "mcp__dangerous", "SomethingUnknown(x)"],
    },
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: `touch ${join(base, "HOOK_RAN")}` }] }],
      PostToolUse: [{ matcher: "Edit|Write", hooks: [{ type: "command", command: `touch ${join(base, "HOOK_RAN")}` }, { type: "command", command: "prettier --write ." }] }],
    },
    enabledPlugins: { "code-review@claude-plugins": true, "off@claude-plugins": false },
  });
  write(join(home, ".claude", "commands", "review-pr.md"), "---\ndescription: Review a pull request\nargument-hint: <number>\nmodel: claude-3-5-haiku-20241022\n---\nReview PR #$ARGUMENTS and list risks.\n");
  write(join(home, ".claude", "commands", "explain.md"), "Explain $1 in simple terms.\n");
  write(join(home, ".claude", "commands", "ship.md"), "---\ndescription: Ship it\nallowed-tools: Bash(git status:*)\n---\nStatus: !`git status`\nThen ship.\n");
  write(join(home, ".claude", "commands", "help.md"), "My own help.\n");
  write(join(home, ".claude", "agents", "reviewer.md"), "---\nname: reviewer\ndescription: Reviews code\n---\nYou review code.\n");
  write(join(home, ".claude", "skills", "pdf", "SKILL.md"), "---\nname: pdf\ndescription: PDFs\n---\nUse pdftotext.\n");
  json(join(home, ".claude.json"), {
    numStartups: 12,
    mcpServers: {
      github: { type: "stdio", command: "npx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: SECRET } },
      notion: { type: "http", url: "https://mcp.notion.com/mcp" },
    },
    projects: {
      [repo]: { mcpServers: { postgres: { command: "node", args: ["db-server.js", "--token", "s3cr3t-token-value"] } }, disabledMcpjsonServers: ["off-server"] },
    },
  });

  // ── Cursor, personal ──
  json(join(home, ".cursor", "mcp.json"), { mcpServers: { linear: { url: "https://mcp.linear.app/sse" }, github: { command: "other-github" } } });

  // ── The project ──
  write(join(repo, "CLAUDE.md"), "# Project\nUse pnpm, not npm.\nSee @docs/style.md and @.env and email me at me@example.com.\n```\n@docs/in-fence.md\n```\n");
  symlinkSync("CLAUDE.md", join(repo, "AGENTS.md"));
  write(join(repo, "docs", "style.md"), "Two-space indent.\n@level2.md\n");
  write(join(repo, "docs", "level2.md"), "Level two rule.\n@level3.md\n");
  write(join(repo, "docs", "level3.md"), "Level three must not appear.\n");
  write(join(repo, "docs", "in-fence.md"), "Fenced import must not appear.\n");
  write(join(repo, ".env"), "API_KEY=super-secret-env\n");
  write(join(repo, "CLAUDE.local.md"), "My sandbox URL is http://localhost:3000.\n");
  write(join(repo, "GEMINI.md"), "Gemini: prefer small PRs.\n");
  write(join(repo, ".cursor", "rules", "always.mdc"), "---\ndescription: Base rules\nglobs:\nalwaysApply: true\n---\nNever use any.\n");
  write(join(repo, ".cursor", "rules", "ts.mdc"), "---\ndescription: TS rules\nglobs: src/**/*.ts\nalwaysApply: false\n---\nPrefer type imports.\n");
  write(join(repo, ".cursor", "rules", "react.mdc"), "---\ndescription: React\nglobs: src/**/*.tsx\n---\nFunction components only.\n");
  write(join(repo, ".cursor", "rules", "docs.md"), "Docs in plain English.\n");
  write(join(repo, ".cursorrules"), "Legacy cursor rule.\n");
  write(join(repo, ".github", "copilot-instructions.md"), "Copilot: run tests before committing.\n");
  json(join(repo, ".mcp.json"), {
    mcpServers: {
      dangerous: { command: "rm-everything" },
      "off-server": { command: "noop" },
      sentry: { command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_TOKEN: "${SENTRY_TOKEN}" } },
    },
  });
  write(join(repo, ".claude", "commands", "test.md"), "---\ndescription: Run the tests\n---\nRun the test suite for $ARGUMENTS.\n");
  json(join(repo, ".claude", "settings.json"), { hooks: { Stop: [{ hooks: [{ type: "command", command: `touch ${join(base, "HOOK_RAN")}` }] }] } });
  write(join(repo, ".autopilot", "commands", "explain.md"), "Autopilot's own explain: $ARGUMENTS\n");
}

const env = () => ({ home, managed: [] as string[] });

before(() => {
  buildFixture();
  delete process.env.AUTOPILOT_IMPORT_SETUP;
});

after(() => {
  rmSync(base, { recursive: true, force: true });
  for (const p of [".claude", ".claude.json", ".cursor"]) rmSync(join(home, p), { recursive: true, force: true });
});

beforeEach(() => {
  resetMcpSessionState();
});

describe("instructions", () => {
  it("reads every agent's files in precedence order, AGENTS.md first", () => {
    const files = loadInstructions(repo, env());
    assert.deepEqual(
      files.map((f) => f.label),
      [
        "AGENTS.md",
        "CLAUDE.local.md",
        "GEMINI.md",
        ".cursor/rules/always.mdc",
        ".cursor/rules/docs.md",
        ".cursor/rules/react.mdc",
        ".cursor/rules/ts.mdc",
        ".cursorrules",
        ".github/copilot-instructions.md",
        "~/.claude/CLAUDE.md",
      ],
    );
  });

  it("reads AGENTS.md and CLAUDE.md once when one is a symlink to the other", () => {
    const [agents] = loadInstructions(repo, env());
    assert.equal(agents!.label, "AGENTS.md");
    assert.deepEqual(agents!.also, ["CLAUDE.md"]);
    const block = buildInstructionsBlock(repo, env());
    assert.equal(block.split("Use pnpm, not npm.").length - 1, 1);
    assert.match(block, /Project context from AGENTS\.md \(\d+ lines, same file as CLAUDE\.md, treat as authoritative\)/);
  });

  it("dedupes identical copies too", () => {
    const d = mkdtempSync(join(tmpdir(), "ap-import-dup-"));
    try {
      mkdirSync(join(d, ".git"));
      write(join(d, "AGENTS.md"), "Same text.\n");
      write(join(d, "CLAUDE.md"), "Same text.\n");
      const files = loadInstructions(d, { home: join(d, "nohome") });
      assert.equal(files.length, 1);
      assert.deepEqual(files[0]!.also, ["CLAUDE.md"]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("states the precedence and labels each file in the prompt", () => {
    const block = buildInstructionsBlock(repo, env());
    assert.match(block, /Where they conflict, AGENTS\.md above wins, then the file listed first\./);
    const order = ["Use pnpm", "My sandbox URL", "Gemini: prefer", "Never use any", "Copilot: run tests", "British English"].map((t) => block.indexOf(t));
    assert.ok(order.every((i) => i > 0), "every file is in the prompt");
    assert.deepEqual([...order].sort((a, b) => a - b), order, "in precedence order");
    assert.match(block, /--- CLAUDE\.local\.md \(Claude Code, personal for this project\) ---/);
    assert.match(block, /--- ~\/\.claude\/CLAUDE\.md \(Claude Code, personal for all projects\) ---/);
    assert.match(block, /--- \.cursor\/rules\/ts\.mdc \(Cursor, applies when working on src\/\*\*\/\*\.ts\) ---/);
    assert.ok(!block.includes("alwaysApply"), "Cursor frontmatter is dropped");
  });

  it("follows @imports two levels deep, never into secrets or code fences", () => {
    const block = buildInstructionsBlock(repo, env());
    assert.ok(block.includes("Two-space indent."), "level 1 import");
    assert.ok(block.includes("Level two rule."), "level 2 import");
    assert.ok(!block.includes("Level three must not appear."), "level 3 is past the cap");
    assert.ok(!block.includes("super-secret-env"), ".env is never imported");
    assert.ok(!block.includes("Fenced import must not appear."));
    assert.ok(block.includes("Keep replies short."), "~/ imports in the personal file");
    assert.deepEqual(findImports("see @a/b.md, @user and me@x.com `@c.md`"), ["a/b.md"]);
  });

  it("caps a large file", () => {
    write(join(repo, "GEMINI.md"), "x".repeat(MAX_FILE_BYTES + 5000));
    try {
      const gemini = loadInstructions(repo, env()).find((f) => f.label === "GEMINI.md")!;
      assert.ok(gemini.truncated);
      assert.ok(gemini.content.length < MAX_FILE_BYTES + 100);
    } finally {
      write(join(repo, "GEMINI.md"), "Gemini: prefer small PRs.\n");
    }
  });

  it("keeps the old prompt exactly when there is only AGENTS.md", () => {
    const d = mkdtempSync(join(tmpdir(), "ap-import-only-"));
    try {
      write(join(d, "AGENTS.md"), "# Rules\nBe nice.\n");
      assert.equal(buildInstructionsBlock(d, { home: join(d, "nohome") }), "\n\nProject context from AGENTS.md (3 lines, treat as authoritative):\n# Rules\nBe nice.");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("reads files in place each time, so an edit shows up without a copy", () => {
    write(join(repo, "CLAUDE.local.md"), "Changed: sandbox on port 4000.\n");
    try {
      assert.ok(buildInstructionsBlock(repo, env()).includes("sandbox on port 4000"));
    } finally {
      write(join(repo, "CLAUDE.local.md"), "My sandbox URL is http://localhost:3000.\n");
    }
  });

  it("AUTOPILOT_IMPORT_SETUP=0 leaves only AGENTS.md", () => {
    process.env.AUTOPILOT_IMPORT_SETUP = "0";
    try {
      assert.deepEqual(loadInstructions(repo, env()).map((f) => f.label), ["AGENTS.md"]);
    } finally {
      delete process.env.AUTOPILOT_IMPORT_SETUP;
    }
  });
});

describe("MCP servers", () => {
  it("finds Claude Code, project and Cursor servers, first name wins", () => {
    const { servers, skipped } = discoverMcpServers(repo, env());
    assert.deepEqual(
      servers.map((s) => `${s.agent}:${s.name}`),
      ["claude:postgres", "claude:sentry", "claude:github", "cursor:linear"],
    );
    assert.deepEqual(
      skipped.map((s) => `${s.name}: ${s.reason}`),
      ["dangerous: denied in your Claude Code settings", "off-server: turned off in Claude Code", "notion: remote HTTP servers aren't supported yet"],
    );
  });

  it("leaves out servers Autopilot's own config already has", () => {
    const { servers } = discoverMcpServers(repo, { ...env(), exclude: ["github"] });
    assert.ok(servers.some((s) => s.agent === "cursor" && s.name === "linear"));
    assert.ok(!servers.some((s) => s.name === "github" && s.agent === "claude"));
    // Cursor's github is a different server under a taken name: also left out.
    assert.ok(!servers.some((s) => s.name === "github"));
  });

  it("never holds or shows secrets", () => {
    const { servers } = discoverMcpServers(repo, env());
    assert.ok(!JSON.stringify(servers).includes(SECRET));
    const postgres = servers.find((s) => s.name === "postgres")!;
    assert.equal(displayCommand(postgres.command!), "node db-server.js --token …");
    const tool = createImportedMcpTool(servers, { connect: async () => [] })!;
    assert.ok(!tool.description.includes("s3cr3t-token-value"));
    assert.ok(!tool.description.includes(SECRET));
  });

  it("asks once before a server starts and never starts one silently", async () => {
    const { servers } = discoverMcpServers(repo, env());
    const launches: McpLaunch[] = [];
    const started: string[] = [];
    const fakeTool: ToolSpec = {
      name: "mcp_github_search_issues",
      description: "Search issues",
      parameters: { type: "object", properties: { q: { type: "string" } } },
      needsPermission: true,
      run: async (args: { q?: string }) => `found 3 issues for ${args.q}`,
    };
    const tool = createImportedMcpTool(servers, {
      connect: async (_s, launch) => {
        launches.push(launch);
        return [fakeTool];
      },
      onStarted: (s) => started.push(s.name),
    })!;
    assert.equal(tool.name, "mcp_imported");
    assert.equal(tool.needsPermission, true);

    const req = { tool, args: { server: "github" } };
    const prompt = importedMcpPromptFor(req);
    assert.ok(prompt, "the first use asks");
    assert.equal(prompt.prompt, "Use the `github` MCP server from your Claude Code setup?");
    assert.equal(prompt.subtitle, "It runs `npx -y @modelcontextprotocol/server-github`. Its settings and any keys stay in ~/.claude.json.");
    assert.deepEqual(prompt.choices.map((c) => c.label), ["Allow once", "Always", "Don't"]);

    // Called without an answer (a host that skipped the prompt): nothing starts.
    const blocked = await tool.run({ server: "github" }, { cwd: repo });
    assert.match(String(blocked), /not turned on/);
    assert.equal(launches.length, 0);

    prompt.onAnswer("once");
    assert.equal(importedMcpPromptFor(req), null, "asked only once");
    const listed = String(await tool.run({ server: "github" }, { cwd: repo }));
    assert.match(listed, /The github MCP server is on, with 1 tool/);
    assert.match(listed, /- search_issues: Search issues/);
    assert.deepEqual(started, ["github"]);
    // The key is read in place at start, handed to the process only.
    assert.equal(launches[0]!.kind, "local");
    assert.equal((launches[0] as { env?: Record<string, string> }).env?.GITHUB_PERSONAL_ACCESS_TOKEN, SECRET);
    assert.equal(await tool.run({ server: "github", tool: "search_issues", arguments: { q: "bug" } }, { cwd: repo }), "found 3 issues for bug");
    assert.equal(launches.length, 1, "started once");
    // "Allow once" is not remembered on disk.
    assert.ok(!existsSync(join(state, "autopilot", "imported-mcp.json")));
  });

  it("asks in the session even in auto mode, through the once-per-project prompt", async () => {
    const { servers } = discoverMcpServers(repo, env());
    const tool = createImportedMcpTool(servers, { connect: async () => [] })!;
    const shown: SetupPrompt[] = [];
    const host = {
      onPlanModeBlocked: () => {},
      prompt: async () => "allow" as const,
      promptSetup: async (p: SetupPrompt) => {
        shown.push(p);
        p.onAnswer?.("deny");
        return "deny" as const;
      },
    };
    const decision = await resolvePermission({ tool, args: { server: "github" }, sessionKey: "k" }, "auto", undefined, host);
    assert.equal(decision, "deny");
    assert.equal(shown.length, 1);
    assert.equal(shown[0]!.kind, "mcp");
    assert.equal(shown[0]!.prompt, "Use the `github` MCP server from your Claude Code setup?");
    // Plan mode blocks MCP calls before any question.
    const planned = await resolvePermission({ tool, args: { server: "sentry" }, sessionKey: "k" }, "plan", undefined, host);
    assert.deepEqual(planned, { decision: "deny", scope: "once" });
    assert.equal(shown.length, 1);
  });

  it("remembers Always and Don't per machine, without secrets", async () => {
    const { servers } = discoverMcpServers(repo, env());
    createImportedMcpTool(servers, { connect: async () => [] });
    importedMcpPromptFor({ tool: { name: "mcp_imported" }, args: { server: "sentry" } })!.onAnswer("always");
    importedMcpPromptFor({ tool: { name: "mcp_imported" }, args: { server: "linear" } })!.onAnswer("deny");
    const stored = readFileSync(join(state, "autopilot", "imported-mcp.json"), "utf8");
    assert.ok(!stored.includes(SECRET) && !stored.includes("SENTRY_TOKEN"));
    resetMcpSessionState(); // a new session
    const tool = createImportedMcpTool(servers, { connect: async () => [] })!;
    assert.equal(importedMcpPromptFor({ tool, args: { server: "sentry" } }), null, "Always: not asked again");
    const props = (tool.parameters as { properties: { server: { enum: string[] } } }).properties;
    assert.ok(!props.server.enum.includes("linear"), "Don't: no longer offered");
  });
});

describe("commands", () => {
  it("maps Claude Code commands that translate cleanly and lists the rest", () => {
    const { commands, skipped } = loadClaudeCommands(repo, env());
    assert.deepEqual(commands.map((c) => `${c.source}:${c.name}`), ["global:explain", "global:review-pr", "project:test"]);
    const review = commands.find((c) => c.name === "review-pr")!;
    assert.equal(review.description, "Review a pull request (Claude Code)");
    assert.equal(review.model, undefined, "Claude model ids are not carried over");
    assert.deepEqual(skipped.map((s) => `${s.name}:${s.reason}`).sort(), ["help:builtin", "ship:shell"]);
  });

  it("renders $ARGUMENTS and $1 as Claude Code does", async () => {
    const { commands } = loadClaudeCommands(repo, env());
    const review = commands.find((c) => c.name === "review-pr")!;
    assert.equal((await renderCommand(review, "/review-pr 42", { cwd: repo })).prompt.trim(), "Review PR #42 and list risks.");
  });

  it("joins Autopilot's commands, which win a name clash", async () => {
    const { commands } = await loadCustomCommands(repo);
    const explain = commands.find((c) => c.name === "explain")!;
    assert.equal(explain.importedFrom, undefined);
    assert.match(explain.template, /Autopilot's own explain/);
    assert.ok(commands.some((c) => c.name === "review-pr" && c.importedFrom === "claude"));
  });
});

describe("permissions", () => {
  const call = (tool: string, args: Record<string, unknown>) => importedDenyFor({ tool, args, cwd: repo }, { home });

  it("honours Claude Code deny rules", () => {
    assert.equal(call("bash", { command: "rm -rf build" })?.raw, "Bash(rm -rf:*)");
    assert.equal(call("bash", { command: "cd x && rm -rf /" })?.raw, "Bash(rm -rf:*)");
    assert.equal(call("bash", { command: "FOO=1 git push origin main" })?.raw, "Bash(git push)");
    assert.equal(call("read", { path: ".env" })?.raw, "Read(./.env)");
    assert.equal(call("grep", { path: "secrets/keys", pattern: "x" })?.raw, "Read(./secrets/**)");
    assert.equal(call("write", { path: "infra/main.tf", content: "" })?.raw, "Edit(./infra/**)");
    assert.equal(call("web_fetch", { url: "https://api.evil.example/x" })?.raw, "WebFetch(domain:evil.example)");
    assert.equal(call("mcp_dangerous_wipe", {})?.raw, "mcp__dangerous");
    assert.equal(call("mcp_imported", { server: "dangerous" })?.raw, "mcp__dangerous");
  });

  it("imports no allow rules and loosens nothing", () => {
    assert.equal(call("bash", { command: "ls -la" }), null);
    assert.equal(call("read", { path: "src/index.ts" }), null);
    assert.equal(call("web_fetch", { url: "https://example.com" }), null);
    const rules = loadDenyRules(repo, { home, managed: [] });
    assert.equal(rules.length, 7, "unknown rule shapes are ignored, allow rules never loaded");
    assert.equal(deniedBy(rules, { tool: "bash", args: { command: "rm -rf x" }, cwd: repo })?.raw, "Bash(rm -rf:*)");
  });

  it("blocks the call in the executor, in any mode, before asking", async () => {
    let ran = 0;
    let asked = 0;
    const bash: ToolSpec = { name: "bash", description: "run", parameters: { type: "object" }, needsPermission: true, run: async () => (ran++, "ok") };
    const read: ToolSpec = { name: "read", description: "read", parameters: { type: "object" }, needsPermission: false, run: async () => (ran++, "contents") };
    const ex = new ToolExecutor([bash, read]);
    const allow = async () => (asked++, "allow" as const);
    const r1 = await ex.run({ id: "1", name: "bash", arguments: JSON.stringify({ command: "rm -rf dist" }) }, allow, { cwd: repo });
    assert.equal(r1.ok, false);
    assert.match(r1.content, /Bash\(rm -rf:\*\) in the user's Claude Code settings \(~\/\.claude\/settings\.json\)/);
    const r2 = await ex.run({ id: "2", name: "read", arguments: JSON.stringify({ path: ".env" }) }, allow, { cwd: repo });
    assert.equal(r2.ok, false);
    assert.equal(ran, 0);
    assert.equal(asked, 0);
    const r3 = await ex.run({ id: "3", name: "bash", arguments: JSON.stringify({ command: "ls" }) }, allow, { cwd: repo });
    assert.equal(r3.ok, true);
    assert.equal(ran, 1);
  });
});

describe("the checklist", () => {
  it("lists what's brought in and what isn't, with reasons", () => {
    const checklist = formatChecklist(scanSetup(repo, env()));
    assert.equal(
      checklist,
      [
        "Bringing in your setup (stays on this computer)",
        "  ✓ Claude Code     CLAUDE.md (project + personal) · 3 MCP servers · 3 commands · 7 deny rules",
        "  ✓ Cursor          .cursor/rules (4 files) · .cursorrules · 1 MCP server",
        "  ✓ Gemini CLI      GEMINI.md",
        "  ✓ GitHub Copilot  .github/copilot-instructions.md",
        "  ↷ 4 Claude Code hooks found, not turned on · they run shell commands",
        "  ↷ 1 Claude Code plugin found, not turned on · plugins aren't supported yet",
        "  ↷ 1 Claude Code subagent found, not brought in · Autopilot has no custom subagents yet",
        "  ↷ 1 Claude Code skill found, not brought in yet",
        "  ↷ 1 Claude Code command not brought in · Autopilot has a built-in command with that name",
        "  ↷ 1 Claude Code command not brought in · it runs shell commands",
        "  ↷ dangerous MCP server (Claude Code) not brought in · denied in your Claude Code settings",
        "  ↷ off-server MCP server (Claude Code) not brought in · turned off in Claude Code",
        "  ↷ notion MCP server (Claude Code) not brought in · remote HTTP servers aren't supported yet",
        "  MCP servers stay off until a task needs one; you're asked before each starts the first time.",
      ].join("\n"),
    );
  });

  it("shows the checklist on the first run, then one line per session", () => {
    const first = sessionStartNotice(repo, env());
    assert.match(first ?? "", /^Bringing in your setup \(stays on this computer\)/);
    assert.equal(sessionStartNotice(repo, env()), "Using your CLAUDE.md, CLAUDE.local.md, GEMINI.md, .cursor/rules, .cursorrules and .github/copilot-instructions.md");
    assert.match(setupImportReport(repo, env()), /^Bringing in your setup/);
  });

  it("shows nothing when there is nothing to import", () => {
    const d = mkdtempSync(join(tmpdir(), "ap-import-empty-"));
    try {
      mkdirSync(join(d, "repo", ".git"), { recursive: true });
      write(join(d, "repo", "AGENTS.md"), "Only Autopilot's own file.\n");
      const opts = { home: join(d, "home"), managed: [] };
      assert.equal(sessionStartNotice(join(d, "repo"), opts), null);
      assert.equal(formatSessionLine(scanSetup(join(d, "repo"), opts)), null);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("never runs hooks and writes nothing into the repository", async () => {
    const before = snapshot(repo);
    const homeBefore = snapshot(home);
    scanSetup(repo, env());
    sessionStartNotice(repo, env());
    buildInstructionsBlock(repo, env());
    await loadCustomCommands(repo);
    discoverMcpServers(repo, env());
    assert.equal(existsSync(join(base, "HOOK_RAN")), false, "no hook ran");
    assert.deepEqual(snapshot(repo), before, "the repository is unchanged");
    assert.deepEqual(snapshot(home), homeBefore, "the other agents' files are unchanged");
  });
});
