import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import {
  GH_INSTALL_LINE,
  GITHUB_ACCESS_HEADLESS_LINE,
  GITHUB_SIGNED_IN_LINE,
  githubAccessOptions,
  githubAccessTitle,
  githubOperation,
  hasGithubToken,
  looksLikeMissingGithubAccess,
  notOpenedNote,
  runGithubAccess,
  runWithGithubAccess,
  type GithubAccessDeps,
  type GithubAccessRequest,
} from "./github-access.js";
import { parseGhDeviceCode, type GhLogin, type GhResult, type GhRun } from "./util/gh-cli.js";
import type { ToolOutput } from "./tools/registry.js";

function fakeGh(answers: Record<string, Partial<GhResult>>, o: { missing?: boolean } = {}) {
  const calls: string[] = [];
  const run: GhRun = async (args) => {
    calls.push(args.join(" "));
    if (o.missing) return { code: null, stdout: "", stderr: "", missing: true };
    const a = answers[args.join(" ")];
    return { code: a?.code ?? 1, stdout: a?.stdout ?? "", stderr: a?.stderr ?? "" };
  };
  return { run, calls };
}

const SIGNED_OUT = fakeGh({ "auth token": { code: 1, stderr: "no oauth token found" } }).run;
const NO_GH = fakeGh({}, { missing: true }).run;

function bashOut(exit: number, stderr: string): ToolOutput {
  const content = `exit=${exit}\n--- stderr ---\n${stderr}`;
  return { content, rawBytes: content.length, reducedBytes: content.length, meta: { exitCode: exit, stderr } };
}

const PUSH_AUTH_FAIL = "fatal: could not read Username for 'https://github.com': No such device or address";
const GH_NOT_SIGNED_IN = "To get started with GitHub CLI, please run:  gh auth login\nAlternatively, populate the GH_TOKEN environment variable with a GitHub API authentication token.";

describe("GitHub access: what counts", () => {
  it("knows pushes and pull requests", () => {
    assert.strictEqual(githubOperation("github_create_pr", {}), "pr");
    assert.strictEqual(githubOperation("bash", { command: "git push -u origin feat/x && gh pr create --fill" }), "pr");
    assert.strictEqual(githubOperation("bash", { command: "git push -u origin feat/x" }), "push");
    assert.strictEqual(githubOperation("bash", { command: "cd sub && git -C . push" }), "push");
    assert.strictEqual(githubOperation("bash", { command: "git status" }), undefined);
    assert.strictEqual(githubOperation("bash", { command: "gh pr create --web" }), undefined);
    assert.strictEqual(githubOperation("read", { path: "x" }), undefined);
  });

  it("recognises missing access, not other failures", () => {
    for (const out of [
      PUSH_AUTH_FAIL,
      "remote: Invalid username or token.\nfatal: Authentication failed for 'https://github.com/o/r.git/'",
      GH_NOT_SIGNED_IN,
      "bash: gh: command not found",
      "Failed to create PR: GitHub API 401: Unauthorized — Requires authentication; gh CLI fallback failed: spawn gh ENOENT",
    ]) assert.ok(looksLikeMissingGithubAccess(out), out);
    for (const out of [
      "! [rejected] main -> main (non-fast-forward)",
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      "fatal: Authentication failed for 'https://gitlab.com/o/r.git/'",
      "Failed to create PR: GitHub API 422: Unprocessable Entity — A pull request already exists",
    ]) assert.ok(!looksLikeMissingGithubAccess(out), out);
  });

  it("finds a token in the session, the environment, or gh", async () => {
    assert.ok(await hasGithubToken({ githubToken: "t" }, { env: {}, gh: NO_GH }));
    assert.ok(await hasGithubToken({}, { env: { GITHUB_TOKEN: "t" }, gh: NO_GH }));
    assert.ok(await hasGithubToken({}, { env: { GH_TOKEN: "t" }, gh: NO_GH }));
    assert.ok(await hasGithubToken({}, { env: {}, gh: fakeGh({ "auth token": { code: 0, stdout: "gho_x" } }).run }));
    assert.ok(!(await hasGithubToken({}, { env: {}, gh: SIGNED_OUT })));
    assert.ok(!(await hasGithubToken({}, { env: {}, gh: NO_GH })));
  });
});

describe("GitHub access: around a push or pull request", () => {
  const o = { env: {}, gh: SIGNED_OUT };

  it("asks, then tries once more after a sign-in", async () => {
    const asked: GithubAccessRequest[] = [];
    let runs = 0;
    const r = await runWithGithubAccess(
      "bash",
      { command: "git push -u origin feat/x" },
      { askGithubAccess: async (req) => (asked.push(req), "signed-in") },
      async () => (++runs === 1 ? bashOut(128, PUSH_AUTH_FAIL) : bashOut(0, "branch 'feat/x' set up to track 'origin/feat/x'.")),
      o,
    );
    assert.deepStrictEqual(asked, [{ op: "push" }]);
    assert.strictEqual(runs, 2);
    assert.match((r as ToolOutput).content, /^exit=0/);
  });

  it("retries only once: a second failure is returned as it is", async () => {
    let runs = 0;
    let asks = 0;
    const r = await runWithGithubAccess(
      "bash",
      { command: "gh pr create --fill" },
      { askGithubAccess: async () => (asks++, "signed-in") },
      async () => (runs++, bashOut(4, GH_NOT_SIGNED_IN)),
      o,
    );
    assert.deepStrictEqual([runs, asks], [2, 1]);
    assert.match((r as ToolOutput).content, /gh auth login/);
  });

  it("not now: tells the model the pull request wasn't opened and the work stays on a local branch", async () => {
    let runs = 0;
    const r = await runWithGithubAccess(
      "github_create_pr",
      { owner: "o", repo: "r", title: "t", head: "feat/x" },
      { askGithubAccess: async () => "not-now" },
      async () => (runs++, "Failed to create PR: GitHub API 401: Unauthorized — Requires authentication; gh CLI fallback failed: spawn gh ENOENT"),
      o,
    );
    assert.strictEqual(runs, 1);
    const text = (r as ToolOutput).content;
    assert.strictEqual(text, notOpenedNote("pr", "not-now"));
    assert.match(text, /The pull request wasn't opened/);
    assert.match(text, /local branch/);
    assert.match(text, /Don't push or open a pull request again/);
    assert.doesNotMatch(text, /Created PR #/, "never looks like a win");
  });

  it("I'll set GITHUB_TOKEN myself: the same, saying the user will set the token", async () => {
    const r = await runWithGithubAccess("bash", { command: "git push" }, { askGithubAccess: async () => "token" }, async () => bashOut(128, PUSH_AUTH_FAIL), o);
    assert.match((r as ToolOutput).content, /will set GITHUB_TOKEN themselves/);
    assert.match((r as ToolOutput).content, /wasn't pushed/);
  });

  it("headless and -p (no one to ask): the output plus one clear line", async () => {
    const r = await runWithGithubAccess("bash", { command: "git push" }, {}, async () => bashOut(128, PUSH_AUTH_FAIL), o);
    const text = (r as ToolOutput).content;
    assert.ok(text.endsWith(`\n\n${GITHUB_ACCESS_HEADLESS_LINE}`));
    assert.strictEqual(GITHUB_ACCESS_HEADLESS_LINE.split("\n").length, 1);
  });

  it("leaves everything else alone: success, other failures, a token present, other tools", async () => {
    const ask = async () => {
      throw new Error("should not ask");
    };
    const ok = bashOut(0, "");
    assert.strictEqual(await runWithGithubAccess("bash", { command: "git push" }, { askGithubAccess: ask }, async () => ok, o), ok);
    const rejected = bashOut(1, "! [rejected] main -> main (non-fast-forward)");
    assert.strictEqual(await runWithGithubAccess("bash", { command: "git push" }, { askGithubAccess: ask }, async () => rejected, o), rejected);
    const failed = bashOut(128, PUSH_AUTH_FAIL);
    assert.strictEqual(await runWithGithubAccess("bash", { command: "git push" }, { githubToken: "t", askGithubAccess: ask }, async () => failed, o), failed);
    assert.strictEqual(await runWithGithubAccess("bash", { command: "git push" }, { askGithubAccess: ask }, async () => failed, { env: { GH_TOKEN: "x" }, gh: NO_GH }), failed);
    const other = bashOut(1, PUSH_AUTH_FAIL);
    assert.strictEqual(await runWithGithubAccess("bash", { command: "git fetch" }, { askGithubAccess: ask }, async () => other, o), other);
  });
});

function promptDeps(selects: (string | null)[], o: { gh?: GhRun; login?: GhLogin; browser?: boolean } = {}) {
  const said: string[] = [];
  const prompts: { title: string; options: string[]; subtitle?: string }[] = [];
  const waits: string[] = [];
  let ended = 0;
  const d: GithubAccessDeps = {
    select: async (title, options, subtitle) => {
      prompts.push({ title, options: options.map((x) => x.label), ...(subtitle ? { subtitle } : {}) });
      return selects.shift() ?? null;
    },
    say: (m) => said.push(m),
    wait: async (text) => (waits.push(text), () => void ended++),
    openBrowser: () => o.browser ?? false,
    gh: o.gh ?? fakeGh({ "auth token": { code: 1 }, "auth setup-git": { code: 0 } }).run,
    login: o.login ?? (async () => ({ ok: false, message: "unused" })),
    env: { AUTOPILOT_LAUNCHED_BY: "dl" },
  };
  return { d, said, prompts, waits, ended: () => ended };
}

describe("GitHub access: the question", () => {
  it("asks with the three choices", async () => {
    const p = promptDeps([null]);
    assert.strictEqual(await runGithubAccess(p.d), "not-now");
    assert.deepStrictEqual(p.prompts[0], {
      title: "To push a branch and open a pull request, dl needs GitHub access.",
      options: ["Sign in with GitHub in the browser", "I'll set GITHUB_TOKEN myself", "Not now (keep the changes on a local branch)"],
      subtitle: "Enter to choose · Esc for not now",
    });
    assert.strictEqual(githubAccessTitle({}), "To push a branch and open a pull request, Autopilot needs GitHub access.");
  });

  it("sign in: runs gh's browser sign-in, shows its one-time code and URL, sets up git, and says so", async () => {
    const gh = fakeGh({ "auth token": { code: 1 }, "auth setup-git": { code: 0 } });
    let loginCalls = 0;
    const login: GhLogin = async ({ onCode }) => {
      loginCalls++;
      onCode({ code: "ABCD-1234", url: "https://github.com/login/device" });
      return { ok: true };
    };
    const p = promptDeps(["signin"], { gh: gh.run, login });
    assert.strictEqual(await runGithubAccess(p.d), "signed-in");
    assert.strictEqual(loginCalls, 1);
    assert.match(p.waits[0]!, /one-time code: ABCD-1234/);
    assert.match(p.waits[0]!, /https:\/\/github\.com\/login\/device/);
    assert.match(p.waits[0]!, /Esc to cancel/);
    assert.strictEqual(p.ended(), 1, "the waiting line is taken down");
    assert.ok(gh.calls.includes("auth setup-git"));
    assert.deepStrictEqual(p.said, [GITHUB_SIGNED_IN_LINE]);
  });

  it("a failed or cancelled sign-in asks again", async () => {
    const login: GhLogin = async () => ({ ok: false, message: "authentication timed out" });
    const p = promptDeps(["signin", "not-now"], { login });
    assert.strictEqual(await runGithubAccess(p.d), "not-now");
    assert.strictEqual(p.prompts.length, 2);
    assert.ok(p.said.some((l) => /didn't finish: authentication timed out/.test(l)));
  });

  it("without gh: one line on installing it, then the token option (no sign-in)", async () => {
    const p = promptDeps(["signin", "token"], { gh: NO_GH });
    assert.strictEqual(await runGithubAccess(p.d), "token");
    assert.strictEqual(p.said[0], GH_INSTALL_LINE);
    assert.match(GH_INSTALL_LINE, /brew install gh/);
    assert.match(GH_INSTALL_LINE, /install_linux\.md/);
    assert.deepStrictEqual(p.prompts[1]!.options, ["I'll set GITHUB_TOKEN myself", "Not now (keep the changes on a local branch)"]);
    assert.match(p.said[1]!, /set GITHUB_TOKEN/);
  });

  it("the options without sign-in", () => {
    assert.deepStrictEqual(githubAccessOptions({ signIn: false }).map((o) => o.value), ["token", "not-now"]);
  });
});

describe("gh's device code", () => {
  it("reads the one-time code and URL from gh auth login --web", () => {
    const out = "! First copy your one-time code: 1A2B-3C4D\nOpen this URL to continue in your web browser: https://github.com/login/device\n";
    assert.deepStrictEqual(parseGhDeviceCode(out), { code: "1A2B-3C4D", url: "https://github.com/login/device" });
    assert.strictEqual(parseGhDeviceCode("! First copy your one-time code: 1A2B-3C4D\n"), undefined);
  });
});

describe("GitHub access through the executor", () => {
  // A fake `gh` first on PATH: signed out. The real gh is never run.
  let savedPath: string | undefined;
  const savedTokens = { GITHUB_TOKEN: process.env.GITHUB_TOKEN, GH_TOKEN: process.env.GH_TOKEN };
  before(() => {
    const bin = mkdtempSync(join(tmpdir(), "fake-gh-"));
    const gh = join(bin, "gh");
    writeFileSync(gh, "#!/bin/sh\necho 'no oauth token found for github.com' >&2\nexit 1\n");
    chmodSync(gh, 0o755);
    savedPath = process.env.PATH;
    process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
    delete process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
  });
  after(() => {
    process.env.PATH = savedPath;
    for (const [k, v] of Object.entries(savedTokens)) if (v !== undefined) process.env[k] = v;
  });

  it("asks through ctx.askGithubAccess and hands the model the note", { skip: process.platform === "win32" }, async () => {
    const { ToolExecutor } = await import("./tools/executor.js");
    let runs = 0;
    const tool = {
      name: "github_create_pr",
      description: "fake",
      parameters: { type: "object", properties: {} },
      needsPermission: false,
      run: async () => (runs++, "Failed to create PR: GitHub API 401: Unauthorized — Requires authentication; gh CLI fallback failed: To get started with GitHub CLI, please run:  gh auth login"),
    };
    const ex = new ToolExecutor([tool]);
    const asked: GithubAccessRequest[] = [];
    const r = await ex.run(
      { id: "c1", name: "github_create_pr", arguments: JSON.stringify({ owner: "o", repo: "r", title: "t", head: "feat/x" }) },
      async () => ({ decision: "allow", scope: "once" }) as never,
      { cwd: process.cwd(), askGithubAccess: async (req) => (asked.push(req), "not-now") },
    );
    assert.deepStrictEqual(asked, [{ op: "pr" }]);
    assert.strictEqual(runs, 1);
    assert.match(r.content, /The pull request wasn't opened/);
  });
});
