import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ToolExecutor, type PermissionAsker } from "../tools/executor.js";
import type { ToolSpec } from "../tools/registry.js";
import { resolvePermission } from "../ui/use-permission-controller.js";
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

describe("auto never asks", () => {
  // Default config: modes off, so the TUI runs in auto mode (app.tsx).
  const tuiAuto: PermissionAsker = (req) =>
    resolvePermission(req, "auto", undefined, {
      onPlanModeBlocked: () => assert.fail("plan mode blocked a call in auto mode"),
      prompt: () => assert.fail(`asked about ${String(req.args.command)}`),
    });

  it("allows an install, a write and a destructive command without a prompt", async () => {
    const repo = mkdtempSync(join(T, "auto-"));
    execFileSync("git", ["init", "-q", repo]);
    const ran: string[] = [];
    const exec = new ToolExecutor([fakeBash(ran)]);
    const commands = ["npm install", "mkdir x", "rm -rf build"];
    for (const [i, command] of commands.entries()) {
      const res = await exec.run(call(command, `c${i}`), tuiAuto, { cwd: repo });
      assert.strictEqual(res.ok, true, `${command}: ${res.content}`);
    }
    assert.deepStrictEqual(ran, commands);
  });

  it("runs an irreversible command as the mode decides, without a confirmation", async () => {
    const ran: string[] = [];
    const exec = new ToolExecutor([fakeBash(ran)]);
    assert.strictEqual((await exec.run(call("terraform destroy"), tuiAuto, { cwd: T })).ok, true);
    assert.deepStrictEqual(ran, ["terraform destroy"]);
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
