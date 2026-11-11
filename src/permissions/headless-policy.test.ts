import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, type PermissionAsker, type PermissionHookResult, type PermissionRequest } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import type { PermissionRules } from "../config.js";
import { classifyCommand } from "./destructive.js";
import { destructivePrompt } from "./guardrails.js";
import { decideHeadlessPermission, type HeadlessPermissionOptions } from "./headless-policy.js";
import { undoLatest } from "./recovery.js";
import { startMode } from "../mode.js";
import { decidePermission } from "./mode-policy.js";
import { readTool } from "../tools/read.js";
import { writeTool } from "../tools/write.js";
import { editTool } from "../tools/edit.js";
import { changelogImageTool } from "../tools/changelog-image.js";
import { existsSync } from "node:fs";

let T: string;
const savedDir = process.env.AUTOPILOT_RECOVERY_DIR;

before(() => {
  T = mkdtempSync(join(tmpdir(), "ap-headless-policy-"));
  process.env.AUTOPILOT_RECOVERY_DIR = join(T, "state");
});
after(() => {
  if (savedDir === undefined) delete process.env.AUTOPILOT_RECOVERY_DIR;
  else process.env.AUTOPILOT_RECOVERY_DIR = savedDir;
  rmSync(T, { recursive: true, force: true });
});

const tool = (name: string): ToolSpec => ({ name, description: "t", parameters: { type: "object", properties: {} }, needsPermission: true, run: async () => "ok" }) as unknown as ToolSpec;
const edit = (path = "src/a.ts", extra: Partial<PermissionRequest> = {}): PermissionRequest => ({ tool: tool("edit"), args: { path }, sessionKey: "k", ...extra });
const bash = (command: string, extra: Partial<PermissionRequest> = {}): PermissionRequest => {
  const a = classifyCommand(command, { cwd: T });
  return {
    tool: tool("bash"),
    args: { command },
    sessionKey: "k",
    ...(a.verdict === "irreversible" ? { destructive: destructivePrompt(a, command) } : {}),
    ...extra,
  };
};
const withHook = (answer: PermissionHookResult | null, seen: string[] = []): Partial<PermissionRequest> => ({
  firePermissionHook: async (mode) => (seen.push(mode), answer),
});
const opts = (o: Partial<HeadlessPermissionOptions> = {}): HeadlessPermissionOptions => ({ allowAll: false, cwd: T, mode: "auto", ...o });

describe("print mode follows interactive mode's permission policy", () => {
  it("starts from the mode interactive starts in: auto, or edit with the modes flag", () => {
    assert.equal(startMode({}), "auto");
    assert.equal(startMode(null), "auto");
    assert.equal(startMode({ modesEnabled: true }), "edit");
  });

  it("approves an edit without --dangerously-allow-all, as interactive auto mode does", async () => {
    const d = await decideHeadlessPermission(edit(), opts());
    assert.equal(d.decision.decision, "allow");
    assert.equal(d.reason, "mode");
    assert.equal(d.notice, undefined);
  });

  it("approves safe and recoverable commands, but denies an irreversible one without an exact rule", async () => {
    assert.equal((await decideHeadlessPermission(bash("npm test"), opts())).decision.decision, "allow");
    assert.equal((await decideHeadlessPermission(bash("rm draft.md"), opts())).decision.decision, "allow");
    const d = await decideHeadlessPermission(bash("terraform destroy"), opts());
    assert.equal(d.decision.decision, "deny");
    assert.equal(d.reason, "irreversible");
    assert.match(d.notice ?? "", /don't cover irreversible actions/);
  });

  it("--dangerously-allow-all and broad rules don't cover irreversible actions; an exact rule does", async () => {
    assert.equal((await decideHeadlessPermission(bash("terraform destroy"), opts({ allowAll: true }))).decision.decision, "deny");
    assert.equal((await decideHeadlessPermission(bash("terraform destroy"), opts({ rules: { bash: { "**": "allow" } } }))).decision.decision, "deny");
    const exact = await decideHeadlessPermission(bash("terraform destroy"), opts({ rules: { bash: { "terraform destroy": "allow" } } }));
    assert.equal(exact.decision.decision, "allow");
    assert.equal(exact.decision.irreversibleConfirmed, true);
  });

  it("a config deny rule still denies, and tells the model not to ask", async () => {
    const rules: Record<string, PermissionRules> = { edit: { "**": "deny" } };
    const d = await decideHeadlessPermission(edit(), opts({ rules }));
    assert.equal(d.decision.decision, "deny");
    assert.equal(d.reason, "config_rule");
    assert.match(d.decision.message ?? "", /do not retry it or ask for permission/);
  });

  it("an \"ask\" rule means a person decides: denied, since no one can answer", async () => {
    const d = await decideHeadlessPermission(edit(), opts({ rules: { edit: { "**": "ask" } } }));
    assert.equal(d.decision.decision, "deny");
    assert.equal(d.reason, "no_one_to_ask");
    assert.equal((await decideHeadlessPermission(edit(), opts({ rules: { edit: { "**": "ask" } }, allowAll: true }))).decision.decision, "allow");
  });

  it("a PreToolUse hook answering \"ask\" is denied without the flag", async () => {
    assert.equal((await decideHeadlessPermission(edit("a", { hookAsked: true }), opts())).decision.decision, "deny");
  });

  it("with the modes flag on, interactive starts in edit and asks: denied unless a rule, hook or the flag approves", async () => {
    assert.equal((await decideHeadlessPermission(edit(), opts({ mode: "edit" }))).decision.decision, "deny");
    assert.equal((await decideHeadlessPermission(edit(), opts({ mode: "edit", allowAll: true }))).decision.decision, "allow");
    assert.equal((await decideHeadlessPermission(edit(), opts({ mode: "edit", rules: { edit: { "**": "allow" } } }))).decision.decision, "allow");
  });

  it("a PermissionRequest hook still decides", async () => {
    const seen: string[] = [];
    const denied = await decideHeadlessPermission(edit("a", withHook({ decision: "deny", reason: "no" }, seen)), opts());
    assert.equal(denied.decision.decision, "deny");
    assert.equal(denied.reason, "hook");
    assert.deepEqual(seen, ["edit"]);
    const allowed = await decideHeadlessPermission(edit("a", withHook({ decision: "allow" })), opts({ rules: { edit: { "**": "ask" } } }));
    assert.equal(allowed.decision.decision, "allow");
    assert.equal(allowed.reason, "hook");
    // A hook may deny an irreversible action, never allow it.
    assert.equal((await decideHeadlessPermission(bash("terraform destroy", withHook({ decision: "deny" })), opts())).reason, "hook");
    assert.equal((await decideHeadlessPermission(bash("terraform destroy", withHook({ decision: "allow" })), opts())).decision.decision, "deny");
    // A deny rule wins before the hook is asked.
    const unasked: string[] = [];
    await decideHeadlessPermission(edit("a", withHook({ decision: "allow" }, unasked)), opts({ rules: { edit: { "**": "deny" } } }));
    assert.deepEqual(unasked, []);
  });
});

describe("print mode reads credentials only with an exact rule or the flag", () => {
  const readEnv = (path = ".env", extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
    tool: { ...tool("read"), needsPermission: false } as ToolSpec,
    args: { path },
    sessionKey: "k",
    sensitiveReason: "reads an environment file (.env)",
    ...extra,
  });

  it("denies a credentials read without a rule, and tells the model not to ask", async () => {
    const d = await decideHeadlessPermission(readEnv(), opts());
    assert.equal(d.decision.decision, "deny");
    assert.equal(d.reason, "credentials");
    assert.match(d.decision.message ?? "", /do not retry it or ask for permission/);
    assert.match(d.notice ?? "", /exact path/);
  });

  it("allows it with an allow rule naming the exact path, relative, absolute or under ~", async () => {
    assert.equal((await decideHeadlessPermission(readEnv(), opts({ rules: { read: { [join(T, ".env")]: "allow" } } }))).decision.decision, "allow");
    assert.equal((await decideHeadlessPermission(readEnv(), opts({ rules: { read: { ".env": "allow" } } }))).reason, "config_rule");
    assert.equal(
      (await decideHeadlessPermission(readEnv("~/.aws/credentials", { sensitiveReason: "reads credentials location ~/.aws" }), opts({ rules: { read: { "~/.aws/credentials": "allow" } } }))).decision.decision,
      "allow",
    );
  });

  it("broad allow rules, other paths' rules and PermissionRequest hooks don't allow it; a deny rule still denies", async () => {
    assert.equal((await decideHeadlessPermission(readEnv(), opts({ rules: { read: { "**": "allow" } } }))).decision.decision, "deny");
    assert.equal((await decideHeadlessPermission(readEnv(), opts({ rules: { read: { [T]: "allow" } } }))).decision.decision, "deny");
    assert.equal((await decideHeadlessPermission(readEnv(), opts({ rules: { edit: { [join(T, ".env")]: "allow" } } }))).decision.decision, "deny");
    const unasked: string[] = [];
    assert.equal((await decideHeadlessPermission(readEnv(".env", withHook({ decision: "allow" }, unasked)), opts())).decision.decision, "deny");
    assert.deepEqual(unasked, []);
    const d = await decideHeadlessPermission(readEnv(), opts({ rules: { read: { [join(T, ".env")]: "deny" } } }));
    assert.equal(d.reason, "config_rule");
    assert.equal(d.decision.decision, "deny");
  });

  it("--dangerously-allow-all allows it, as for other calls that would need a person", async () => {
    const d = await decideHeadlessPermission(readEnv(), opts({ allowAll: true }));
    assert.equal(d.decision.decision, "allow");
    assert.equal(d.reason, "allow_all");
  });

  it("covers grep over a credentials location, and leaves ordinary reads alone", async () => {
    const grep: PermissionRequest = { tool: { ...tool("grep"), needsPermission: false } as ToolSpec, args: { pattern: "x" }, sessionKey: "k", sensitiveReason: "reads credentials location /x" };
    assert.equal((await decideHeadlessPermission(grep, opts())).reason, "credentials");
    assert.equal((await decideHeadlessPermission(grep, opts({ rules: { grep: { [T]: "allow" } } }))).decision.decision, "allow");
    const plain: PermissionRequest = { tool: tool("read"), args: { path: "src/a.ts" }, sessionKey: "k" };
    assert.equal((await decideHeadlessPermission(plain, opts())).decision.decision, "allow");
  });

  it("interactive auto mode still approves a credentials read without asking", () => {
    assert.deepEqual(decidePermission(readEnv(), "auto"), { kind: "resolve", decision: { decision: "allow", scope: "once" } });
    assert.equal(decidePermission(readEnv(), "edit").kind, "prompt");
  });

  it("through the executor, the real read tool's credentials read is a denied call", async () => {
    const dir = mkdtempSync(join(T, "creds-"));
    writeFileSync(join(dir, ".env"), "SECRET=1\n");
    const exec = new ToolExecutor([readTool as unknown as ToolSpec]);
    const asker: PermissionAsker = (req) => decideHeadlessPermission(req, opts({ cwd: dir })).then((d) => d.decision);
    const res = await exec.run({ id: "r1", name: "read", arguments: JSON.stringify({ path: ".env" }) }, asker, { cwd: dir });
    assert.equal(res.ok, false);
    assert.equal(res.denied, true);
    assert.doesNotMatch(res.content, /SECRET=1/);
    assert.match(res.content, /finish and report what's left/);
    const allowAll: PermissionAsker = (req) => decideHeadlessPermission(req, opts({ cwd: dir, allowAll: true })).then((d) => d.decision);
    const ok = await exec.run({ id: "r2", name: "read", arguments: JSON.stringify({ path: ".env" }) }, allowAll, { cwd: dir });
    assert.equal(ok.ok, true);
    assert.match(ok.content, /SECRET=1/);
  });
});

describe("print mode writes credentials only with an exact rule or the flag", () => {
  const writeCreds = (name: "write" | "edit", path = ".env", extra: Partial<PermissionRequest> = {}): PermissionRequest => ({
    tool: tool(name),
    args: name === "write" ? { path, content: "x" } : { path, old_string: "a", new_string: "b" },
    sessionKey: "k",
    sensitiveReason: path.startsWith("~/.ssh") ? "writes credentials location ~/.ssh" : "writes an environment file (.env)",
    ...extra,
  });

  it("denies a write or edit to a credentials path without a rule, and tells the model not to ask", async () => {
    for (const name of ["write", "edit"] as const) {
      const d = await decideHeadlessPermission(writeCreds(name, "~/.ssh/authorized_keys"), opts());
      assert.equal(d.decision.decision, "deny");
      assert.equal(d.reason, "credentials");
      assert.match(d.decision.message ?? "", /print mode writes credentials only/);
      assert.match(d.decision.message ?? "", /do not retry it or ask for permission/);
      assert.match(d.notice ?? "", /doesn't write credentials/);
      assert.ok(d.notice?.includes(`"${name}": { ${JSON.stringify(join(homedir(), ".ssh", "authorized_keys"))}: "allow" }`), d.notice);
    }
  });

  it("allows it with an allow rule for that tool naming the exact path", async () => {
    assert.equal((await decideHeadlessPermission(writeCreds("write"), opts({ rules: { write: { [join(T, ".env")]: "allow" } } }))).decision.decision, "allow");
    assert.equal((await decideHeadlessPermission(writeCreds("edit"), opts({ rules: { edit: { ".env": "allow" } } }))).reason, "config_rule");
    assert.equal(
      (await decideHeadlessPermission(writeCreds("write", "~/.ssh/authorized_keys"), opts({ rules: { write: { "~/.ssh/authorized_keys": "allow" } } }))).decision.decision,
      "allow",
    );
  });

  it("broad allow rules, other tools' rules and PermissionRequest hooks don't allow it; a deny rule still denies", async () => {
    assert.equal((await decideHeadlessPermission(writeCreds("write"), opts({ rules: { write: { "**": "allow" } } }))).decision.decision, "deny");
    assert.equal((await decideHeadlessPermission(writeCreds("edit"), opts({ rules: { edit: { [T]: "allow" } } }))).decision.decision, "deny");
    assert.equal((await decideHeadlessPermission(writeCreds("write"), opts({ rules: { read: { [join(T, ".env")]: "allow" } } }))).decision.decision, "deny");
    assert.equal((await decideHeadlessPermission(writeCreds("edit"), opts({ rules: { write: { [join(T, ".env")]: "allow" } } }))).decision.decision, "deny");
    const unasked: string[] = [];
    assert.equal((await decideHeadlessPermission(writeCreds("write", ".env", withHook({ decision: "allow" }, unasked)), opts())).decision.decision, "deny");
    assert.deepEqual(unasked, []);
    const d = await decideHeadlessPermission(writeCreds("write"), opts({ rules: { write: { [join(T, ".env")]: "deny" } } }));
    assert.equal(d.reason, "config_rule");
    assert.equal(d.decision.decision, "deny");
  });

  it("--dangerously-allow-all allows it", async () => {
    const d = await decideHeadlessPermission(writeCreds("edit", "~/.ssh/authorized_keys"), opts({ allowAll: true }));
    assert.equal(d.decision.decision, "allow");
    assert.equal(d.reason, "allow_all");
  });

  it("leaves ordinary writes and edits alone", async () => {
    for (const name of ["write", "edit"] as const) {
      const d = await decideHeadlessPermission({ tool: tool(name), args: { path: "src/a.ts", content: "x" }, sessionKey: "k" }, opts());
      assert.equal(d.decision.decision, "allow");
      assert.equal(d.reason, "mode");
    }
  });

  it("the real write and edit tools flag credentials paths, and not ordinary ones", async () => {
    const ctx = { cwd: T } as Parameters<NonNullable<typeof writeTool.permissionReason>>[1];
    assert.match((await writeTool.permissionReason!({ path: "~/.ssh/authorized_keys", content: "k" }, ctx)) ?? "", /^writes credentials location/);
    assert.match((await editTool.permissionReason!({ path: ".env.local", old_string: "a", new_string: "b" }, ctx)) ?? "", /^writes an environment file/);
    assert.equal(await writeTool.permissionReason!({ path: "src/a.ts", content: "k" }, ctx), null);
    assert.equal(await writeTool.permissionReason!({ path: ".env.example", content: "k" }, ctx), null);
    // changelog_image saves a PNG to `output`: flagged the same way, and the policy reads that path.
    assert.match((await changelogImageTool.permissionReason!({ owner: "o", repo: "r", output: "~/.ssh/authorized_keys" }, ctx)) ?? "", /^writes credentials location/);
    assert.equal(await changelogImageTool.permissionReason!({ owner: "o", repo: "r", output: "out.png" }, ctx), null);
    const png: PermissionRequest = { tool: tool("changelog_image"), args: { owner: "o", repo: "r", output: "~/.ssh/authorized_keys" }, sessionKey: "k", sensitiveReason: "writes credentials location ~/.ssh" };
    assert.equal((await decideHeadlessPermission(png, opts())).reason, "credentials");
  });

  it("interactive auto mode still approves a credentials write without asking", () => {
    assert.deepEqual(decidePermission(writeCreds("write"), "auto"), { kind: "resolve", decision: { decision: "allow", scope: "once" } });
    assert.equal(decidePermission(writeCreds("edit"), "edit").kind, "prompt");
  });

  it("through the executor, the real write tool's credentials write is a denied call and the file isn't written", async () => {
    const dir = mkdtempSync(join(T, "creds-w-"));
    const exec = new ToolExecutor([writeTool as unknown as ToolSpec, editTool as unknown as ToolSpec]);
    const asker: PermissionAsker = (req) => decideHeadlessPermission(req, opts({ cwd: dir })).then((d) => d.decision);
    const res = await exec.run({ id: "w1", name: "write", arguments: JSON.stringify({ path: ".env", content: "SECRET=1\n" }) }, asker, { cwd: dir });
    assert.equal(res.ok, false);
    assert.equal(res.denied, true);
    assert.match(res.content, /finish and report what's left/);
    assert.equal(existsSync(join(dir, ".env")), false);

    writeFileSync(join(dir, ".env"), "TOKEN=old\n");
    const edited = await exec.run({ id: "e1", name: "edit", arguments: JSON.stringify({ path: ".env", old_string: "old", new_string: "new" }) }, asker, { cwd: dir });
    assert.equal(edited.denied, true);
    assert.equal(readFileSync(join(dir, ".env"), "utf8"), "TOKEN=old\n");

    const ordinary = await exec.run({ id: "w2", name: "write", arguments: JSON.stringify({ path: "notes.md", content: "hi\n" }) }, asker, { cwd: dir });
    assert.equal(ordinary.ok, true, ordinary.content);
    assert.equal(readFileSync(join(dir, "notes.md"), "utf8"), "hi\n");

    const allowAll: PermissionAsker = (req) => decideHeadlessPermission(req, opts({ cwd: dir, allowAll: true })).then((d) => d.decision);
    const ok = await exec.run({ id: "w3", name: "write", arguments: JSON.stringify({ path: ".env.local", content: "SECRET=1\n" }) }, allowAll, { cwd: dir });
    assert.equal(ok.ok, true, ok.content);
    assert.equal(readFileSync(join(dir, ".env.local"), "utf8"), "SECRET=1\n");
  });
});

describe("print mode's policy through the executor", () => {
  const asker = (o: Partial<HeadlessPermissionOptions> = {}): PermissionAsker => (req) => decideHeadlessPermission(req, opts(o)).then((d) => d.decision);
  const call = (command: string) => ({ id: "c1", name: "bash", arguments: JSON.stringify({ command }) });

  it("takes a recovery point before an approved recoverable action, as in the TUI", async () => {
    const repo = mkdtempSync(join(T, "repo-"));
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "draft.md"), "keep me\n");
    const exec = new ToolExecutor([
      {
        name: "bash",
        description: "test",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        needsPermission: true,
        run: async () => (rmSync(join(repo, "draft.md")), "removed"),
      } as ToolSpec,
    ]);
    const res = await exec.run(call("rm draft.md"), asker(), { cwd: repo });
    assert.equal(res.ok, true);
    assert.equal(res.denied, undefined);
    assert.match(res.content, /\/undo puts it back/);
    assert.match(undoLatest(repo), /restored 1 file \(draft\.md\)/);
    assert.equal(readFileSync(join(repo, "draft.md"), "utf8"), "keep me\n");
  });

  it("marks denied calls, and the model hears it's headless instead of \"ask the user\"", async () => {
    const ran: string[] = [];
    const exec = new ToolExecutor([
      { name: "bash", description: "t", parameters: { type: "object", properties: {}, additionalProperties: true }, needsPermission: true, run: async (a: { command: string }) => (ran.push(a.command), "ok") } as ToolSpec,
    ]);
    const res = await exec.run(call("npm publish"), asker({ rules: { bash: { "npm publish": "deny" } } }), { cwd: T });
    assert.equal(res.ok, false);
    assert.equal(res.denied, true);
    assert.deepEqual(ran, []);
    assert.doesNotMatch(res.content, /ask the user/);
    assert.match(res.content, /finish and report what's left/);
    const irreversible = await exec.run(call("terraform destroy"), asker({ allowAll: true }), { cwd: T });
    assert.equal(irreversible.denied, true);
    assert.deepEqual(ran, []);
  });
});
