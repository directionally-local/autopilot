import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grantSetupConsent, hasSetupConsent, isTempPath, resolvesToLocalBin, SETUP_CHOICES, setupCommandOf, setupQuestion } from "./setup-consent.js";
import { resolvePermission } from "../ui/use-permission-controller.js";
import type { PermissionDecision, PermissionRequest } from "../tools/executor.js";

const kind = (c: string) => setupCommandOf(c)?.kind ?? null;

describe("setupCommandOf", () => {
  it("finds dependency installs across package managers", () => {
    for (const c of [
      "npm install",
      "npm i lodash",
      "npm ci",
      "npm --silent install",
      "yarn",
      "yarn add react",
      "pnpm install",
      "bun install",
      "pip install -r requirements.txt",
      "python3 -m pip install requests",
      "uv sync",
      "poetry install",
      "cargo build",
      "cargo fetch",
      "go mod download",
      "go get example.com/x",
      "bundle install",
      "bundle",
      "gem install rails",
      "composer install",
      "sudo apt-get install -y jq",
      "brew install ripgrep",
      "FOO=1 npm install",
      "/usr/bin/npm install",
    ]) {
      assert.strictEqual(kind(c), "install", c);
    }
  });

  it("finds the install inside a compound command, the one the test run used", () => {
    const sc = setupCommandOf("cd /home/dev/code/slugify && npm install --no-audit 2>&1 | tail -3 && npm test");
    assert.deepStrictEqual(sc, { kind: "install", segment: "npm install --no-audit" });
  });

  it("finds packages that are downloaded and run", () => {
    for (const c of ["npx prettier --check .", "npm exec tsc", "pnpm dlx create-vite", "bunx eslint", "uvx ruff check"]) assert.strictEqual(kind(c), "fetch-run", c);
  });

  it("finds commands that write outside the agent's own edits", () => {
    for (const c of [
      "rm -rf dist",
      "mkdir -p build",
      "mv a b",
      "git commit -m x",
      "git push origin main",
      "git checkout -- .",
      "git stash",
      "sed -i 's/a/b/' file.txt",
      "echo hi > notes.txt",
      "cat a >> b",
      "curl -fsSL https://x/y -o y.tgz",
      "tar -xzf y.tgz",
    ]) {
      assert.strictEqual(kind(c), "write", c);
    }
  });

  it("leaves reads, tests and builds without installs alone", () => {
    for (const c of [
      "ls -la",
      "git status",
      "git log --oneline -8 && ls node_modules 2>/dev/null | head -3",
      "git stash list",
      "npm test",
      "npm run lint",
      "node --test",
      "pytest -q",
      "go test ./...",
      "grep -rn 'a > b' src",
      "cat package.json 2>&1",
      "echo done >&2",
      "sed -n 1,20p file.txt",
      "curl -s https://example.com",
    ]) {
      assert.strictEqual(kind(c), null, c);
    }
  });

  describe("binaries that are already installed", () => {
    let project: string;
    before(() => {
      // A workspace: the root's node_modules/.bin has xo (as npm/pnpm link it, workspace bins too),
      // packages/app has its own eslint, and the root package has its own bin.
      project = mkdtempSync(join(tmpdir(), "consent-bins-"));
      mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(project, "node_modules", ".bin", "xo"), "");
      mkdirSync(join(project, "node_modules", "@biomejs", "biome"), { recursive: true });
      writeFileSync(join(project, "node_modules", "@biomejs", "biome", "package.json"), "{}");
      writeFileSync(join(project, "package.json"), JSON.stringify({ name: "tool", bin: { "my-cli": "cli.js" } }));
      mkdirSync(join(project, "packages", "app", "node_modules", ".bin"), { recursive: true });
      writeFileSync(join(project, "packages", "app", "node_modules", ".bin", "eslint"), "");
    });
    after(() => rmSync(project, { recursive: true, force: true }));
    const at = (cwd: string) => (c: string) => setupCommandOf(c, { cwd })?.kind ?? null;

    it("runs them without asking: npx, npm exec, bunx, bun x, pnpm exec and yarn", () => {
      const here = at(project);
      for (const c of ["npx xo", "npx --yes xo --fix", "npm exec xo", "npm exec -- xo", "npx @biomejs/biome check", "bunx xo", "bun x xo", "pnpm exec xo", "yarn xo", "npx my-cli"]) {
        assert.strictEqual(here(c), null, c);
      }
      // The command the fresh-machine test asked about.
      assert.strictEqual(here("cd /elsewhere && npx xo 2>&1 | tail -20"), "fetch-run", "a cd elsewhere leaves the project");
      assert.strictEqual(at("/")(`cd ${project} && npx xo 2>&1 | tail -20`), null, "a cd into the project finds it");
      // From a workspace package, its own bins and the root's.
      assert.strictEqual(at(join(project, "packages", "app"))("npx eslint ."), null);
      assert.strictEqual(at(join(project, "packages", "app"))("npx xo"), null);
      assert.strictEqual(at(project)("npx eslint ."), "fetch-run", "not installed at the root");
    });

    it("still asks when the package would be downloaded", () => {
      const here = at(project);
      for (const c of ["npx prettier --check .", "npx xo@0.60.0", "npx -p xo xo", "npx --package=xo xo", "pnpm dlx xo", "yarn dlx xo", "npm exec prettier"]) {
        assert.strictEqual(here(c), "fetch-run", c);
      }
      assert.strictEqual(resolvesToLocalBin("../xo", project), false);
    });
  });

  describe("temp files", () => {
    it("writing to /tmp or the OS temp dir is not a change", () => {
      for (const c of [
        'npm test > /tmp/test.log 2>&1; echo "EXIT: $?"; grep -E "fail|error" /tmp/test.log | head -20',
        "node --test 2>&1 | tee /tmp/out.txt",
        "echo x >> /var/tmp/notes",
        'echo x > "$TMPDIR/x.log"',
        `echo x > ${join(tmpdir(), "autopilot-scratch.log")}`,
        "rm -f /tmp/a.log /tmp/b.log",
        "mkdir -p /tmp/work",
        "cd /tmp && echo x > out.log",
      ]) {
        assert.strictEqual(kind(c), null, c);
      }
    });

    it("anything outside a temp dir still is", () => {
      for (const c of ["echo x > /tmp/../home/me/x", "mkdir -p /tmp/work build", "cp /tmp/a.ts src/a.ts", "echo x > /tmpfoo/x", "echo x > out.log"]) {
        assert.strictEqual(kind(c), "write", c);
      }
      assert.strictEqual(isTempPath("/srv/scratch/x", undefined, ["/srv/scratch"]), true);
      assert.strictEqual(isTempPath("out.log", undefined), false);
    });
  });

  it("asks in plain words, with three answers", () => {
    const install = setupQuestion(setupCommandOf("npm install")!, "npm install");
    assert.strictEqual(install.prompt, "Install dependencies with `npm install`?");
    assert.strictEqual(install.subtitle, "This downloads packages and runs their install scripts.");
    const compound = setupQuestion(setupCommandOf("npm install && npm test")!, "npm install && npm test");
    assert.match(compound.subtitle, /Full command: npm install && npm test$/);
    assert.strictEqual(setupQuestion(setupCommandOf("rm -rf dist")!, "rm -rf dist").prompt, "Run `rm -rf dist`?");
    assert.deepStrictEqual(SETUP_CHOICES.map((c) => c.label), ["Allow once", "Always allow in this project", "Don't"]);
  });
});

describe("asking once per project", () => {
  let state: string;
  const saved = process.env.XDG_STATE_HOME;
  before(() => {
    state = mkdtempSync(join(tmpdir(), "setup-consent-"));
    process.env.XDG_STATE_HOME = state;
  });
  after(() => {
    if (saved === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = saved;
    rmSync(state, { recursive: true, force: true });
  });

  const req = (command: string, tool = "bash"): PermissionRequest => ({ tool: { name: tool } as PermissionRequest["tool"], args: { command }, sessionKey: `bash:${command}` });
  const host = (asked: string[], answer: PermissionDecision, gate: { root: string; ruleAllows?: () => boolean } | null) => ({
    onPlanModeBlocked: () => undefined,
    prompt: async (): Promise<PermissionDecision> => {
      throw new Error("the ordinary prompt is not used in auto");
    },
    setupGate: gate,
    promptSetup: async (s: { prompt: string }) => (asked.push(s.prompt), answer),
  });

  it("asks before an install in default auto, and remembers 'always' for that project only", async () => {
    const asked: string[] = [];
    const gate = { root: "/work/slugify" };
    assert.strictEqual(await resolvePermission(req("npm install"), "auto", {}, host(asked, "allow", gate)), "allow");
    assert.deepStrictEqual(asked, ["Install dependencies with `npm install`?"]);
    assert.strictEqual(hasSetupConsent("/work/slugify"), false, "Allow once is not remembered");

    grantSetupConsent("/work/slugify");
    assert.strictEqual(hasSetupConsent("/work/slugify"), true);
    assert.strictEqual(statSync(join(state, "autopilot", "project-consent.json")).mode & 0o777, 0o600);
    asked.length = 0;
    assert.deepStrictEqual(await resolvePermission(req("npm install"), "auto", {}, host(asked, "deny", gate)), { decision: "allow", scope: "once" });
    assert.deepStrictEqual(asked, [], "not asked again in that project");
    await resolvePermission(req("npm install"), "auto", {}, host(asked, "deny", { root: "/work/other" }));
    assert.strictEqual(asked.length, 1, "another project asks");
  });

  it("passes a Don't through as a denial", async () => {
    assert.strictEqual(await resolvePermission(req("pip install x"), "auto", {}, host([], "deny", { root: "/work/py" })), "deny");
  });

  it("covers job_start, and never asks for reads", async () => {
    const asked: string[] = [];
    await resolvePermission(req("yarn install", "job_start"), "auto", {}, host(asked, "allow", { root: "/work/j" }));
    await resolvePermission(req("git status"), "auto", {}, host(asked, "allow", { root: "/work/j" }));
    await resolvePermission({ ...req(""), tool: { name: "write" } as PermissionRequest["tool"], args: { path: "a.ts" } }, "auto", {}, host(asked, "allow", { root: "/work/j" }));
    assert.strictEqual(asked.length, 1);
  });

  it("keeps a chosen auto mode, headless (no gate) and configured allow rules as they were", async () => {
    const asked: string[] = [];
    assert.deepStrictEqual(await resolvePermission(req("npm install"), "auto", {}, host(asked, "deny", null)), { decision: "allow", scope: "once" });
    assert.deepStrictEqual(
      await resolvePermission(req("npm install"), "auto", {}, host(asked, "deny", { root: "/work/r", ruleAllows: () => true })),
      { decision: "allow", scope: "once" },
    );
    assert.deepStrictEqual(asked, []);
  });
});
