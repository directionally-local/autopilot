import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, type PermissionAsker, type PermissionDecision, type PermissionRequest } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import { resolvePermission } from "../ui/use-permission-controller.js";
import { classifyCommand } from "./destructive.js";
import { CONFIRMED_IRREVERSIBLE, destructivePrompt, exactRuleAllows, unattendedDestructiveDecision } from "./guardrails.js";
import { undoLatest } from "./recovery.js";

let T: string;
const savedDir = process.env.AUTOPILOT_RECOVERY_DIR;

before(() => {
  T = mkdtempSync(join(tmpdir(), "ap-guardrails-"));
  process.env.AUTOPILOT_RECOVERY_DIR = join(T, "state");
});
after(() => {
  if (savedDir === undefined) delete process.env.AUTOPILOT_RECOVERY_DIR;
  else process.env.AUTOPILOT_RECOVERY_DIR = savedDir;
  rmSync(T, { recursive: true, force: true });
});

/** A bash tool that records commands instead of running them. */
function fakeBash(ran: string[]): ToolSpec {
  return {
    name: "bash",
    description: "test",
    parameters: { type: "object", properties: {}, additionalProperties: true },
    needsPermission: true,
    run: async (args: { command: string }) => {
      ran.push(args.command);
      return "ok";
    },
  } as ToolSpec;
}

const call = (command: string, id = "c1") => ({ id, name: "bash", arguments: JSON.stringify({ command }) });
const autoAllow: PermissionAsker = async () => ({ decision: "allow", scope: "once" });

describe("executor guardrails", () => {
  it("denies an irreversible call that auto mode or --dangerously-allow-all would allow", async () => {
    const ran: string[] = [];
    const exec = new ToolExecutor([fakeBash(ran)]);
    const seen: PermissionRequest[] = [];
    const res = await exec.run(call("terraform destroy"), async (req) => (seen.push(req), "allow"), { cwd: T });
    assert.strictEqual(res.ok, false);
    assert.deepStrictEqual(ran, []);
    assert.match(res.content, /^Not run, because it can't be undone: destroys every resource this Terraform configuration manages/);
    assert.match(res.content, /Do not retry it/);
    assert.strictEqual(seen[0]?.destructive?.title, "This can't be undone: destroys every resource this Terraform configuration manages in the current workspace.");
  });

  it("runs it once a person confirmed, and asks again every time", async () => {
    const ran: string[] = [];
    const exec = new ToolExecutor([fakeBash(ran)]);
    let asked = 0;
    const ask: PermissionAsker = async () => (asked++, { ...CONFIRMED_IRREVERSIBLE, scope: "session" });
    assert.strictEqual((await exec.run(call("terraform destroy"), ask, { cwd: T })).ok, true);
    assert.strictEqual((await exec.run(call("terraform destroy", "c2"), ask, { cwd: T })).ok, true);
    assert.strictEqual(asked, 2);
    assert.deepStrictEqual(ran, ["terraform destroy", "terraform destroy"]);
  });

  it("leaves safe calls as they were", async () => {
    const ran: string[] = [];
    const exec = new ToolExecutor([fakeBash(ran)]);
    const res = await exec.run(call(`echo "drop table users"`), autoAllow, { cwd: T });
    assert.strictEqual(res.ok, true);
  });

  it("saves a recovery point before an auto-approved recoverable action, and says so", async () => {
    const repo = mkdtempSync(join(T, "repo-"));
    execFileSync("git", ["init", "-q", repo]);
    writeFileSync(join(repo, "draft.md"), "keep me\n");
    const exec = new ToolExecutor([
      {
        name: "bash",
        description: "test",
        parameters: { type: "object", properties: {}, additionalProperties: true },
        needsPermission: true,
        run: async () => {
          rmSync(join(repo, "draft.md"));
          return "removed";
        },
      } as ToolSpec,
    ]);
    const res = await exec.run(call("rm draft.md"), autoAllow, { cwd: repo });
    assert.strictEqual(res.ok, true);
    assert.match(res.content, /\[autopilot\] Autopilot saved a copy of 1 file before this ran; \/undo puts it back\./);
    assert.match(undoLatest(repo), /restored 1 file \(draft\.md\)/);
    assert.strictEqual(readFileSync(join(repo, "draft.md"), "utf8"), "keep me\n");
  });
});

describe("the TUI asks in every mode", () => {
  const req = (command: string): PermissionRequest => {
    const a = classifyCommand(command, { cwd: T });
    return { tool: { name: "bash" } as ToolSpec, args: { command }, sessionKey: "k", destructive: destructivePrompt(a, command) };
  };
  const host = (answer: PermissionDecision) => {
    const calls: string[] = [];
    return {
      calls,
      onPlanModeBlocked: () => calls.push("blocked"),
      prompt: async () => (calls.push("prompt"), "allow" as const),
      promptDestructive: async () => (calls.push("destructive"), answer),
    };
  };

  for (const mode of ["auto", "edit"] as const) {
    it(`asks in ${mode} mode`, async () => {
      const h = host(CONFIRMED_IRREVERSIBLE);
      assert.deepStrictEqual(await resolvePermission(req("terraform destroy"), mode, undefined, h), CONFIRMED_IRREVERSIBLE);
      assert.deepStrictEqual(h.calls, ["destructive"]);
    });
  }

  it("blocks in plan mode, and a hook's allow doesn't skip the question", async () => {
    const h = host("deny");
    assert.strictEqual((await resolvePermission(req("terraform destroy"), "plan", undefined, h) as { decision: string }).decision, "deny");
    assert.deepStrictEqual(h.calls, ["blocked"]);
    const h2 = host("deny");
    const r = { ...req("terraform destroy"), firePermissionHook: async () => ({ decision: "allow" as const }) };
    assert.strictEqual(await resolvePermission(r, "auto", undefined, h2), "deny");
    assert.deepStrictEqual(h2.calls, ["destructive"]);
  });

  it("denies when the host can't ask", async () => {
    const { promptDestructive: _, ...noAsk } = host("deny");
    assert.strictEqual((await resolvePermission(req("terraform destroy"), "auto", undefined, noAsk) as { decision: string }).decision, "deny");
  });
});

describe("prompts", () => {
  it("says what is lost, where, and that there's no recovery", () => {
    const command = `DATABASE_URL=postgres://u:p@db.example.com/shop psql "$DATABASE_URL" -c 'DROP TABLE orders'`;
    const d = destructivePrompt(classifyCommand(command, { cwd: T, env: {} }), command);
    assert.strictEqual(d.title, "This can't be undone: drops table `orders` in the database at DATABASE_URL (db.example.com/shop), which looks like production (not on this machine).");
    assert.strictEqual(d.recovery, "No automatic recovery: Autopilot can't put this back.");
    assert.strictEqual(d.confirmName, "shop");
    assert.ok(d.subtitle.endsWith(`Command: ${command}`));
  });

  it("names the recovery a force push has", () => {
    const repo = mkdtempSync(join(T, "push-"));
    const g = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e", "-C", repo, ...a], { encoding: "utf8" }).trim();
    g("init", "-q", "-b", "main");
    g("commit", "-q", "--allow-empty", "-m", "x");
    g("update-ref", "refs/remotes/origin/main", "HEAD");
    const d = destructivePrompt(classifyCommand("git push --force origin main", { cwd: repo }));
    assert.match(d.title, /^This can't be undone: force-pushes over branch `main` on `origin`/);
    assert.match(d.recovery, /^Autopilot records the branch's old commit \([0-9a-f]{7}, as of your last fetch\) first; \/undo pushes it back\. Commits pushed there since your last fetch are not covered; --force-with-lease avoids that\.$/);
    assert.strictEqual(d.confirmName, undefined);
  });
});

describe("headless runs and server sessions", () => {
  const req = (command: string): PermissionRequest => ({
    tool: { name: "bash" } as ToolSpec,
    args: { command },
    sessionKey: "k",
    destructive: destructivePrompt(classifyCommand(command, { cwd: T }), command),
  });

  it("deny unless a rule names the exact action; ** and globs never count", () => {
    for (const rules of [{ bash: { "**": "allow" as const } }, { bash: { "terraform *": "allow" as const } }, { bash: { terraform: "allow" as const } }, undefined]) {
      const { decision, message } = unattendedDestructiveDecision(req("terraform destroy"), rules, T);
      assert.strictEqual(decision.decision, "deny", JSON.stringify(rules));
      assert.match(message, /To allow exactly this, add "permissions": \{ "bash": \{ "terraform destroy": "allow" \} \} to config\.json/);
    }
    const ok = unattendedDestructiveDecision(req("terraform destroy"), { bash: { "terraform destroy": "allow" } }, T);
    assert.deepStrictEqual(ok.decision, CONFIRMED_IRREVERSIBLE);
  });

  it("an exact rule covers the irreversible part of a compound command", () => {
    assert.strictEqual(exactRuleAllows(req("cd infra && terraform destroy"), { bash: { "terraform destroy": "allow" } }, T), true);
    assert.strictEqual(exactRuleAllows(req("terraform destroy && gh repo delete o/r --yes"), { bash: { "terraform destroy": "allow" } }, T), false);
  });
});
