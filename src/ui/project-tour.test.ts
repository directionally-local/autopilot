import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildTour,
  factsPrompt,
  gatherProjectFacts,
  localSuggestions,
  parseSuggestions,
  readManifest,
  renderTour,
  resolveTourInput,
  runCommand,
  suggestTasks,
  TOUR_MAX_COMPLETION_TOKENS,
  type AskModel,
  type ProjectFacts,
  type RunCommand,
} from "./project-tour.js";

let dir: string;
let statePath: string;

function repo(files: Record<string, string>, remote?: string): string {
  const root = join(dir, "shop");
  mkdirSync(root, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    mkdirSync(join(root, name, ".."), { recursive: true });
    writeFileSync(join(root, name), body);
  }
  execFileSync("git", ["init", "-q"], { cwd: root });
  if (remote) execFileSync("git", ["remote", "add", "origin", remote], { cwd: root });
  if (Object.keys(files).length) execFileSync("git", ["add", "-A"], { cwd: root });
  return root;
}

/** Real git, fake gh (signed in, with these issues), and a record of every gh call. */
function withGh(issues: unknown, calls: string[][] = []): RunCommand {
  return async (cmd, args, opts) => {
    if (cmd === "gh") {
      calls.push(args);
      return JSON.stringify(issues);
    }
    return runCommand(cmd, args, opts);
  };
}

const facts = (over: Partial<ProjectFacts> = {}): ProjectFacts => ({
  root: "/x/shop",
  name: "shop",
  kind: "Next.js app",
  language: "TypeScript",
  fileCount: 214,
  testCommand: "npm test",
  issues: [{ number: 12, title: "discount applied twice" }],
  ...over,
});

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ap-tour-"));
  statePath = join(dir, "state", "project-tour.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("project facts", () => {
  it("reads a Node project: name, framework, file count, test command, issues", async () => {
    const root = repo(
      {
        "package.json": JSON.stringify({ name: "shop", scripts: { test: "vitest" }, dependencies: { next: "15", react: "19" }, devDependencies: { typescript: "5" } }),
        "pnpm-lock.yaml": "",
        "app/page.tsx": "export default 1",
        "cart.spec.ts": "",
      },
      "git@github.com:acme/shop.git",
    );
    const f = await gatherProjectFacts(root, { run: withGh([{ number: 12, title: "discount applied twice" }]) });
    assert.deepStrictEqual(
      { ...f, root: undefined },
      { root: undefined, name: "shop", kind: "Next.js app", language: "TypeScript", fileCount: 4, testCommand: "pnpm test", issues: [{ number: 12, title: "discount applied twice" }] },
    );
  });

  it("ignores npm's placeholder test script and falls back to a Makefile test target", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "lib", scripts: { test: 'echo "Error: no test specified" && exit 1' } }),
      Makefile: "build:\n\ttrue\ntest:\n\tnode t.js\n",
    });
    assert.deepStrictEqual(readManifest(root), { name: "lib", kind: "JavaScript package", language: "JavaScript", testCommand: "make test" });
  });

  it("calls a package with a bin a CLI, even when it uses React", () => {
    const root = repo({ "package.json": JSON.stringify({ name: "tool", bin: { tool: "cli.js" }, dependencies: { react: "19", ink: "5" }, devDependencies: { typescript: "5" } }) });
    assert.strictEqual(readManifest(root).kind, "TypeScript CLI");
  });

  it("reads a Python project from pyproject.toml", async () => {
    const root = repo({
      "pyproject.toml": '[project]\nname = "slugify"\ndependencies = ["fastapi"]\n[project.optional-dependencies]\ndev = ["pytest"]\n',
      "slugify/__init__.py": "",
    });
    const f = await gatherProjectFacts(root, { run: withGh([]) });
    assert.strictEqual(f.name, "slugify");
    assert.strictEqual(f.kind, "FastAPI app");
    assert.strictEqual(f.language, "Python");
    assert.strictEqual(f.testCommand, "pytest");
    assert.strictEqual(f.fileCount, 2);
  });

  it("handles a repository with no manifest: folder name, no kind, no tests", async () => {
    const root = repo({ "notes.txt": "hi" });
    const f = await gatherProjectFacts(root, { run: withGh([]) });
    assert.deepStrictEqual({ ...f, root: undefined }, { root: undefined, name: "shop", fileCount: 1, issues: [] });
    assert.strictEqual(renderTour(f, localSuggestions(f)).split("\n")[0], "  shop · 1 file · no test command found");
  });

  it("asks gh for issues only when there is a GitHub remote, and survives gh failing", async () => {
    const calls: string[][] = [];
    const local = repo({ "a.txt": "" }, "https://gitlab.com/acme/shop.git");
    assert.deepStrictEqual((await gatherProjectFacts(local, { run: withGh([{ number: 1, title: "x" }], calls) })).issues, []);
    assert.strictEqual(calls.length, 0);
    rmSync(local, { recursive: true, force: true });
    const gh = repo({ "a.txt": "" }, "https://github.com/acme/shop");
    const failing: RunCommand = async (cmd, args, opts) => (cmd === "gh" ? null : runCommand(cmd, args, opts));
    assert.deepStrictEqual((await gatherProjectFacts(gh, { run: failing })).issues, []);
  });
});

describe("suggestions", () => {
  it("makes one capped model call with the facts (never the code) and uses its three lines", async () => {
    const seen: Parameters<AskModel>[0][] = [];
    const ask: AskModel = async (o) => {
      seen.push(o);
      return "1. Fix the failing test in cart.spec.ts\n2. Explain how checkout works\n3. Pick up issue #12: “discount applied twice”";
    };
    const r = await suggestTasks(facts(), ask);
    assert.deepStrictEqual(r, {
      source: "model",
      tasks: ["Fix the failing test in cart.spec.ts", "Explain how checkout works", "Pick up issue #12: “discount applied twice”"],
    });
    assert.strictEqual(seen.length, 1);
    assert.strictEqual(seen[0]!.maxTokens, TOUR_MAX_COMPLETION_TOKENS);
    assert.strictEqual(seen[0]!.user, factsPrompt(facts()));
  });

  it("falls back to local suggestions when the model is slower than the timeout, and aborts it", async () => {
    let aborted = false;
    // Like a real request: it settles (rejects) when aborted, and its timer
    // is a normal one, so nothing depends on unref'd timers keeping the loop alive.
    const slow: AskModel = (o) =>
      new Promise((resolve, reject) => {
        const t = setTimeout(() => resolve("too late"), 1_000);
        o.signal.addEventListener("abort", () => {
          aborted = true;
          clearTimeout(t);
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    const started = Date.now();
    const r = await suggestTasks(facts(), slow, { timeoutMs: 50 });
    assert.ok(Date.now() - started < 900);
    assert.strictEqual(r.source, "local");
    assert.deepStrictEqual(r.tasks, [
      "Run the tests (npm test) and fix what fails",
      "Explain how this project is structured",
      "Pick up issue #12: “discount applied twice”",
    ]);
    assert.ok(aborted);
  });

  it("stops waiting as soon as the caller aborts, even if the model never answers", async () => {
    const ctrl = new AbortController();
    let sawAbort = false;
    const hanging: AskModel = (o) =>
      new Promise(() => {
        o.signal.addEventListener("abort", () => (sawAbort = true));
        setTimeout(() => ctrl.abort(), 10);
      });
    const started = Date.now();
    const r = await suggestTasks(facts(), hanging, { timeoutMs: 5_000, signal: ctrl.signal });
    assert.ok(Date.now() - started < 1_000);
    assert.strictEqual(r.source, "local");
    assert.ok(sawAbort);
  });

  it("falls back when the call fails, and tops up a short reply", async () => {
    assert.strictEqual((await suggestTasks(facts(), async () => { throw new Error("401"); })).source, "local");
    const short = await suggestTasks(facts({ issues: [] }), async () => "Explain how checkout works");
    assert.deepStrictEqual(short.tasks, ["Explain how checkout works", "Run the tests (npm test) and fix what fails", "Explain how this project is structured"]);
  });

  it("parses bullets and numbering away", () => {
    assert.deepStrictEqual(parseSuggestions("- one task\n2) two task\n\n* three task\nfour task"), ["one task", "two task", "three task"]);
  });
});

describe("selection", () => {
  const tasks = ["Fix the failing test", "Explain checkout", "Pick up issue #12"];
  it("1–3 sends that task; anything else goes through unchanged", () => {
    assert.strictEqual(resolveTourInput("1", tasks), "Fix the failing test");
    assert.strictEqual(resolveTourInput(" 3 ", tasks), "Pick up issue #12");
    assert.strictEqual(resolveTourInput("4", tasks), "4");
    assert.strictEqual(resolveTourInput("1 more thing", tasks), "1 more thing");
    assert.strictEqual(resolveTourInput("2", null), "2");
  });
});

describe("buildTour", () => {
  const ask: AskModel = async () => "Fix the failing test in cart.spec.ts\nExplain how checkout works\nAdd a coupon test";

  it("shows on the first session in a project, then only with /tour", async () => {
    const root = repo({ "package.json": JSON.stringify({ name: "shop", scripts: { test: "jest" }, dependencies: { next: "15" } }) });
    const first = await buildTour({ cwd: root, enabled: true, ask, statePath, run: withGh([]) });
    assert.strictEqual(first.kind, "shown");
    if (first.kind === "shown") {
      assert.strictEqual(
        first.text,
        [
          "  shop · Next.js app · 1 file · tests: npm test",
          "  1  Fix the failing test in cart.spec.ts",
          "  2  Explain how checkout works",
          "  3  Add a coupon test",
          "  Press 1–3 and Enter, or type anything.",
          "  /tour shows this again · /settings tour off turns it off",
        ].join("\n"),
      );
    }
    // Remembered outside the repo, keyed by the repository root.
    assert.ok(existsSync(statePath));
    assert.ok(Object.keys(JSON.parse(readFileSync(statePath, "utf8")).shown).length === 1);
    assert.deepStrictEqual(execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).includes(".autopilot"), false);

    assert.deepStrictEqual(await buildTour({ cwd: root, enabled: true, ask, statePath, run: withGh([]) }), { kind: "skipped", reason: "already-shown" });
    const again = await buildTour({ cwd: join(root), enabled: true, force: true, ask, statePath, run: withGh([]) });
    assert.strictEqual(again.kind, "shown");
    if (again.kind === "shown") assert.ok(!again.text.includes("/tour shows this again"));
  });

  it("respects the off setting (but /tour still works)", async () => {
    const root = repo({ "a.txt": "" });
    assert.deepStrictEqual(await buildTour({ cwd: root, enabled: false, ask, statePath, run: withGh([]) }), { kind: "skipped", reason: "off" });
    assert.ok(!existsSync(statePath));
    assert.strictEqual((await buildTour({ cwd: root, enabled: false, force: true, ask, statePath, run: withGh([]) })).kind, "shown");
  });

  it("skips outside a git repository", async () => {
    const plain = join(dir, "plain");
    mkdirSync(plain);
    assert.deepStrictEqual(await buildTour({ cwd: plain, enabled: true, ask, statePath }), { kind: "skipped", reason: "not-a-repo" });
  });

  it("shows nothing (and doesn't mark it shown) once the person has typed", async () => {
    const root = repo({ "a.txt": "" });
    const ctrl = new AbortController();
    const typing: AskModel = async () => {
      ctrl.abort();
      return "x task\ny task\nz task";
    };
    assert.deepStrictEqual(await buildTour({ cwd: root, enabled: true, ask: typing, signal: ctrl.signal, statePath, run: withGh([]) }), {
      kind: "skipped",
      reason: "typed",
    });
    assert.ok(!existsSync(statePath));
  });
});
