import { describe, it, afterEach } from "node:test";
import assert from "node:assert";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { configPath } from "../config.js";
import { createsGhPr, hasPrFooter, PR_FOOTER, prFooterEnabled, withPrFooter, wrapGhPrCreate } from "./pr-footer.js";
import { githubCreatePrTool, githubUpdatePrTool } from "../tools/github.js";
import { bashTool } from "../tools/bash.js";
import type { ToolOutput } from "../tools/registry.js";

const FOOTER = "Opened with [dl](https://dl.new), a free coding agent.";

describe("Opened with dl: the PR footer", () => {
  const savedEnv = process.env.AUTOPILOT_PR_FOOTER;
  afterEach(async () => {
    if (savedEnv === undefined) delete process.env.AUTOPILOT_PR_FOOTER;
    else process.env.AUTOPILOT_PR_FOOTER = savedEnv;
    await writeFile(configPath(), "{}").catch(() => undefined);
  });

  it("is the exact line, added once, after the body", () => {
    assert.strictEqual(PR_FOOTER, FOOTER);
    assert.strictEqual(withPrFooter("Fixes the bug.\n\nResolves #4\n"), `Fixes the bug.\n\nResolves #4\n\n${FOOTER}`);
    assert.strictEqual(withPrFooter(withPrFooter("x")), `x\n\n${FOOTER}`, "never twice");
    assert.strictEqual(withPrFooter(""), FOOTER);
    assert.strictEqual(withPrFooter(undefined), FOOTER);
    assert.ok(hasPrFooter(`body\n\n${FOOTER}`));
  });

  it("is on by default; prFooter: false or AUTOPILOT_PR_FOOTER=0 turns it off", async () => {
    delete process.env.AUTOPILOT_PR_FOOTER;
    await mkdir(dirname(configPath()), { recursive: true });
    await writeFile(configPath(), "{}");
    assert.strictEqual(prFooterEnabled(), true);
    await writeFile(configPath(), JSON.stringify({ prFooter: false }));
    assert.strictEqual(prFooterEnabled(), false);
    assert.strictEqual(prFooterEnabled({ AUTOPILOT_PR_FOOTER: "1" }), true, "the env wins");
    await writeFile(configPath(), "{}");
    assert.strictEqual(prFooterEnabled({ AUTOPILOT_PR_FOOTER: "0" }), false);
  });

  it("github_create_pr sends the footer, for every provider, unless turned off", async () => {
    delete process.env.AUTOPILOT_PR_FOOTER;
    const original = globalThis.fetch;
    const bodies: string[] = [];
    globalThis.fetch = async (_input, init) => {
      bodies.push(JSON.parse(String((init as RequestInit).body)).body);
      return new Response(JSON.stringify({ number: 1, title: "T", html_url: "https://github.com/o/r/pull/1", state: "open" }), { status: 201 });
    };
    try {
      const run = (body?: string) => githubCreatePrTool.run({ owner: "o", repo: "r", title: "T", head: "h", base: "main", ...(body !== undefined ? { body } : {}) }, { cwd: "/tmp" }) as Promise<ToolOutput>;
      await run("What changed.");
      await run(`Already there.\n\n${FOOTER}`);
      await run();
      await writeFile(configPath(), JSON.stringify({ prFooter: false }));
      await run("No footer.");
      assert.deepStrictEqual(bodies, [`What changed.\n\n${FOOTER}`, `Already there.\n\n${FOOTER}`, FOOTER, "No footer."]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("github_update_pr keeps the footer when the agent rewrites the body of a PR that had it", async () => {
    delete process.env.AUTOPILOT_PR_FOOTER;
    const original = globalThis.fetch;
    const patches: Record<string, unknown>[] = [];
    let currentBody = `Old.\n\n${FOOTER}`;
    globalThis.fetch = async (input, init) => {
      if ((init as RequestInit | undefined)?.method === "PATCH") {
        patches.push(JSON.parse(String((init as RequestInit).body)));
        return new Response("{}", { status: 200 });
      }
      assert.match(String(input), /\/pulls\/5$/);
      return new Response(JSON.stringify({ body: currentBody }), { status: 200 });
    };
    try {
      await githubUpdatePrTool.run({ owner: "o", repo: "r", number: 5, body: "New." }, { cwd: "/tmp" });
      currentBody = "Someone else's PR.";
      await githubUpdatePrTool.run({ owner: "o", repo: "r", number: 5, body: "Edited." }, { cwd: "/tmp" });
      assert.deepStrictEqual(patches.map((p) => p.body), [`New.\n\n${FOOTER}`, "Edited."]);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("finds `gh pr create` (not --web) in a command", () => {
    assert.ok(createsGhPr("gh pr create --title t --body b"));
    assert.ok(createsGhPr("git push -u origin x && gh pr create --fill"));
    assert.ok(!createsGhPr("gh pr create --web"));
    assert.ok(!createsGhPr("gh pr view 3"));
    assert.ok(!createsGhPr("echo 'not a sigh pr create'"));
    assert.deepStrictEqual(wrapGhPrCreate("ls", "/tmp/x"), { command: "ls", env: {} });
  });

  it("amends the body of the PR `gh pr create` opened, keeps its output and exit status", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    const dir = await mkdtemp(join(tmpdir(), "pr-footer-gh-"));
    const log = join(dir, "gh.log");
    const edited = join(dir, "edited.txt");
    // A fake `gh`: create prints a URL, view prints the body, edit saves what it's given.
    await writeFile(
      join(dir, "gh"),
      [
        "#!/bin/sh",
        `echo "$*" >> "${log}"`,
        'case "$1 $2" in',
        '  "pr create") echo "https://github.com/o/r/pull/9"; exit "${FAKE_GH_EXIT:-0}" ;;',
        '  "pr view") printf "%s" "${FAKE_GH_BODY}" ;;',
        `  "pr edit") cat > "${edited}" ;;`,
        "esac",
      ].join("\n"),
    );
    await chmod(join(dir, "gh"), 0o755);
    const run = (env: Record<string, string>) => {
      const { command, env: extra } = wrapGhPrCreate("gh pr create --title T --body B", join(dir, "out.txt"));
      return spawnSync("/bin/sh", ["-c", command], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...extra, ...env }, encoding: "utf8" });
    };
    const ok = run({ FAKE_GH_BODY: "B" });
    assert.strictEqual(ok.status, 0);
    assert.strictEqual(ok.stdout, "https://github.com/o/r/pull/9\n");
    assert.strictEqual(await readFile(edited, "utf8"), `B\n\n${FOOTER}\n`);
    assert.match(await readFile(log, "utf8"), /pr view https:\/\/github\.com\/o\/r\/pull\/9 --json body -q \.body\npr edit https:\/\/github\.com\/o\/r\/pull\/9 --body-file -/);

    await writeFile(edited, "untouched");
    run({ FAKE_GH_BODY: `B\n\n${FOOTER}` });
    assert.strictEqual(await readFile(edited, "utf8"), "untouched", "not twice");

    const failed = run({ FAKE_GH_EXIT: "3", FAKE_GH_BODY: "B" });
    assert.strictEqual(failed.status, 3, "the command's exit status is kept");
    assert.strictEqual(await readFile(edited, "utf8"), "untouched", "nothing amended after a failure");
  });

  it("the bash tool applies it to `gh pr create`", async (t) => {
    if (process.platform === "win32") return t.skip("POSIX shell only");
    delete process.env.AUTOPILOT_PR_FOOTER;
    const dir = await mkdtemp(join(tmpdir(), "pr-footer-bash-"));
    const edited = join(dir, "edited.txt");
    await writeFile(
      join(dir, "gh"),
      ["#!/bin/sh", 'case "$1 $2" in', '  "pr create") echo "https://github.com/o/r/pull/9" ;;', '  "pr view") printf "Body" ;;', `  "pr edit") cat > "${edited}" ;;`, "esac"].join("\n"),
    );
    await chmod(join(dir, "gh"), 0o755);
    // The fake `gh` first on PATH for the whole command, the amend included.
    const path = process.env.PATH;
    process.env.PATH = `${dir}:${path}`;
    try {
      const out = (await bashTool.run({ command: "gh pr create --fill" }, { cwd: dir, shell: "bash" })) as ToolOutput;
      assert.match(out.content, /^exit=0\n--- stdout ---\nhttps:\/\/github\.com\/o\/r\/pull\/9/);
      assert.strictEqual(await readFile(edited, "utf8"), `Body\n\n${FOOTER}\n`);
    } finally {
      process.env.PATH = path;
    }
  });
});
