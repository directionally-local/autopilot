/**
 * The project tour: when a new session starts in a git repository and the
 * person hasn't typed yet, show a one-line project summary and three
 * concrete starter tasks they can pick with 1–3.
 *
 *   shop · Next.js app · 214 files · tests: npm test
 *   1  Run the tests (npm test) and fix what fails
 *   2  Explain how checkout works
 *   3  Pick up issue #12: “discount applied twice”
 *   Press 1–3 and Enter, or type anything.
 *
 * Facts are gathered locally and cheaply (manifests, `git ls-files`; never
 * running tests or installing anything). Open issues come from `gh` only
 * when it is already signed in and the repo has a GitHub remote. Then one
 * small model call words the tasks from those facts (never the code); when
 * it fails or is slow, local suggestions are shown instead.
 *
 * Shown once per project — remembered in Autopilot's state directory, never
 * in the repo — and again on `/tour`. `/settings tour off` turns it off.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stateDir } from "../util/app-dirs.js";

export interface ProjectIssue {
  number: number;
  title: string;
}

export interface ProjectFacts {
  /** Repository root. */
  root: string;
  name: string;
  /** e.g. "Next.js app", "Python package", "Rust crate"; undefined when nothing is recognized. */
  kind?: string;
  /** Main language, when known. */
  language?: string;
  /** Files tracked by git. */
  fileCount: number;
  /** How the project's tests run, e.g. "npm test"; undefined when none was found. */
  testCommand?: string;
  /** Open GitHub issues (newest first), empty when gh isn't available. */
  issues: ProjectIssue[];
}

/** Hard cap on the one model call's completion. */
export const TOUR_MAX_COMPLETION_TOKENS = 200;
/** Give up on the model call after this long and show local suggestions. */
export const TOUR_MODEL_TIMEOUT_MS = 4_000;
/** Give up on `gh issue list` after this long. */
export const TOUR_ISSUES_TIMEOUT_MS = 2_500;
/** How the tour ends; the selection rule below matches it. */
export const TOUR_PROMPT = "Press 1–3 and Enter, or type anything.";

// ── Running commands ─────────────────────────────────────────────────────

export type RunCommand = (cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }) => Promise<string | null>;

/** stdout of a command, or null on any failure (missing binary, non-zero exit, timeout). */
export const runCommand: RunCommand = (cmd, args, opts) =>
  new Promise((resolve) => {
    try {
      execFile(
        cmd,
        args,
        {
          cwd: opts.cwd,
          timeout: opts.timeoutMs,
          maxBuffer: 64 * 1024 * 1024,
          windowsHide: true,
          env: { ...process.env, GH_PROMPT_DISABLED: "1", GIT_TERMINAL_PROMPT: "0", NO_COLOR: "1" },
        },
        (err, stdout) => resolve(err ? null : String(stdout)),
      );
    } catch {
      resolve(null);
    }
  });

/** The git repository root containing `cwd`, or null outside a repository. */
export async function gitRoot(cwd: string, run: RunCommand = runCommand): Promise<string | null> {
  const out = await run("git", ["rev-parse", "--show-toplevel"], { cwd, timeoutMs: 2_000 });
  return out?.trim() || null;
}

// ── Facts ────────────────────────────────────────────────────────────────

function readText(root: string, file: string): string | null {
  try {
    return readFileSync(join(root, file), "utf8");
  } catch {
    return null;
  }
}

function readJson(root: string, file: string): Record<string, unknown> | null {
  const text = readText(root, file);
  if (text === null) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return v && typeof v === "object" ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const JS_FRAMEWORKS: Array<[dep: string, label: string]> = [
  ["next", "Next.js"],
  ["nuxt", "Nuxt"],
  ["@sveltejs/kit", "SvelteKit"],
  ["@remix-run/react", "Remix"],
  ["astro", "Astro"],
  ["@angular/core", "Angular"],
  ["expo", "Expo"],
  ["react-native", "React Native"],
  ["electron", "Electron"],
  ["@nestjs/core", "NestJS"],
  ["svelte", "Svelte"],
  ["vue", "Vue"],
  ["react", "React"],
  ["hono", "Hono"],
  ["fastify", "Fastify"],
  ["express", "Express"],
];

const PY_FRAMEWORKS: Array<[dep: RegExp, label: string]> = [
  [/\bdjango\b/i, "Django"],
  [/\bfastapi\b/i, "FastAPI"],
  [/\bflask\b/i, "Flask"],
  [/\bstreamlit\b/i, "Streamlit"],
];

/** npm's placeholder test script ("Error: no test specified") isn't a test command. */
function realTestScript(script: unknown): boolean {
  return typeof script === "string" && script.trim() !== "" && !/no test specified/i.test(script);
}

function nodePackageManager(root: string): string {
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "bun.lockb")) || existsSync(join(root, "bun.lock"))) return "bun run";
  return "npm";
}

function makefileHasTest(root: string): boolean {
  const mk = readText(root, "Makefile") ?? readText(root, "makefile") ?? readText(root, "GNUmakefile");
  return !!mk && /^test\s*:/m.test(mk);
}

function tomlName(toml: string, table: string): string | undefined {
  const at = toml.indexOf(`[${table}]`);
  if (at < 0) return undefined;
  const after = toml.slice(at + table.length + 2);
  const end = after.search(/^\[/m);
  const body = end < 0 ? after : after.slice(0, end);
  return /^\s*name\s*=\s*["']([^"']+)["']/m.exec(body)?.[1];
}

interface Manifest {
  name?: string;
  kind?: string;
  language?: string;
  testCommand?: string;
}

/** What the manifest files say: name, kind, language and test command. Reads files only. */
export function readManifest(root: string): Manifest {
  const pkg = readJson(root, "package.json");
  if (pkg) {
    const deps = { ...(pkg.dependencies as object), ...(pkg.devDependencies as object) } as Record<string, unknown>;
    const ts = "typescript" in deps || existsSync(join(root, "tsconfig.json"));
    const language = ts ? "TypeScript" : "JavaScript";
    const framework = JS_FRAMEWORKS.find(([dep]) => dep in deps)?.[1];
    // A package with a `bin` is a CLI even when it renders with React (Ink) or serves with Express.
    const kind = pkg.bin ? `${language} CLI` : framework ? `${framework} app` : `${language} package`;
    const scripts = (pkg.scripts ?? {}) as Record<string, unknown>;
    const pm = nodePackageManager(root);
    const testCommand = realTestScript(scripts.test)
      ? pm === "npm" ? "npm test" : `${pm} test`
      : makefileHasTest(root) ? "make test" : undefined;
    return { ...(typeof pkg.name === "string" ? { name: pkg.name } : {}), kind, language, ...(testCommand ? { testCommand } : {}) };
  }
  const pyproject = readText(root, "pyproject.toml");
  const requirements = readText(root, "requirements.txt");
  if (pyproject !== null || requirements !== null || existsSync(join(root, "setup.py"))) {
    const text = `${pyproject ?? ""}\n${requirements ?? ""}`;
    const framework = PY_FRAMEWORKS.find(([re]) => re.test(text))?.[1];
    const name = pyproject ? tomlName(pyproject, "project") ?? tomlName(pyproject, "tool.poetry") : undefined;
    const pytest = /\bpytest\b/i.test(text) || existsSync(join(root, "tests")) || existsSync(join(root, "pytest.ini"));
    const testCommand = makefileHasTest(root) ? "make test" : pytest ? "pytest" : undefined;
    return {
      ...(name ? { name } : {}),
      kind: framework ? `${framework} app` : "Python project",
      language: "Python",
      ...(testCommand ? { testCommand } : {}),
    };
  }
  const cargo = readText(root, "Cargo.toml");
  if (cargo !== null) {
    const name = tomlName(cargo, "package");
    return { ...(name ? { name } : {}), kind: "Rust crate", language: "Rust", testCommand: "cargo test" };
  }
  const gomod = readText(root, "go.mod");
  if (gomod !== null) {
    const mod = /^module\s+(\S+)/m.exec(gomod)?.[1];
    return { ...(mod ? { name: mod.split("/").pop()! } : {}), kind: "Go module", language: "Go", testCommand: "go test ./..." };
  }
  const gemfile = readText(root, "Gemfile");
  if (gemfile !== null) {
    const rails = /['"]rails['"]/.test(gemfile);
    const testCommand = existsSync(join(root, "spec")) ? "bundle exec rspec" : rails ? "bin/rails test" : makefileHasTest(root) ? "make test" : undefined;
    return { kind: rails ? "Rails app" : "Ruby project", language: "Ruby", ...(testCommand ? { testCommand } : {}) };
  }
  if (existsSync(join(root, "mix.exs"))) return { kind: "Elixir project", language: "Elixir", testCommand: "mix test" };
  if (existsSync(join(root, "pom.xml"))) return { kind: "Java (Maven) project", language: "Java", testCommand: "mvn test" };
  if (existsSync(join(root, "build.gradle")) || existsSync(join(root, "build.gradle.kts"))) {
    return { kind: "Gradle project", language: "Java/Kotlin", testCommand: existsSync(join(root, "gradlew")) ? "./gradlew test" : "gradle test" };
  }
  const composer = readJson(root, "composer.json");
  if (composer) {
    const scripts = (composer.scripts ?? {}) as Record<string, unknown>;
    return { kind: "PHP project", language: "PHP", ...(scripts.test ? { testCommand: "composer test" } : {}) };
  }
  return makefileHasTest(root) ? { testCommand: "make test" } : {};
}

/** True when a git remote points at github.com. */
export async function hasGitHubRemote(root: string, run: RunCommand = runCommand): Promise<boolean> {
  const out = await run("git", ["remote", "-v"], { cwd: root, timeoutMs: 2_000 });
  return !!out && /github\.com[:/]/i.test(out);
}

/**
 * Open issues through `gh`, only when the repo has a GitHub remote and `gh`
 * is already signed in (an unsigned gh just fails, which is skipped too).
 * Never prompts; empty on any failure or after the timeout.
 */
export async function openIssues(root: string, o: { run?: RunCommand; timeoutMs?: number; limit?: number } = {}): Promise<ProjectIssue[]> {
  const run = o.run ?? runCommand;
  if (!(await hasGitHubRemote(root, run))) return [];
  const out = await run("gh", ["issue", "list", "--state", "open", "--limit", String(o.limit ?? 3), "--json", "number,title"], {
    cwd: root,
    timeoutMs: o.timeoutMs ?? TOUR_ISSUES_TIMEOUT_MS,
  });
  if (!out) return [];
  try {
    const list = JSON.parse(out) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((i): i is ProjectIssue => !!i && typeof i.number === "number" && typeof i.title === "string")
      .map((i) => ({ number: i.number, title: i.title.trim() }));
  } catch {
    return [];
  }
}

/** Gather the facts for the summary. Local and cheap: nothing is run but git (and gh, when signed in). */
export async function gatherProjectFacts(root: string, o: { run?: RunCommand; issuesTimeoutMs?: number } = {}): Promise<ProjectFacts> {
  const run = o.run ?? runCommand;
  const [files, issues] = await Promise.all([
    run("git", ["ls-files", "-z"], { cwd: root, timeoutMs: 3_000 }),
    openIssues(root, { run, ...(o.issuesTimeoutMs !== undefined ? { timeoutMs: o.issuesTimeoutMs } : {}) }),
  ]);
  const m = readManifest(root);
  return {
    root,
    name: m.name || basename(root),
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.language ? { language: m.language } : {}),
    fileCount: files ? files.split("\0").filter(Boolean).length : 0,
    ...(m.testCommand ? { testCommand: m.testCommand } : {}),
    issues,
  };
}

// ── Suggestions ──────────────────────────────────────────────────────────

const MAX_TASK_CHARS = 90;

function clipTask(s: string): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= MAX_TASK_CHARS ? t : `${t.slice(0, MAX_TASK_CHARS - 1).trimEnd()}…`;
}

export function issueTask(i: ProjectIssue): string {
  return clipTask(`Pick up issue #${i.number}: “${i.title}”`);
}

/** Three suggestions from the facts alone (no model). */
export function localSuggestions(f: ProjectFacts): string[] {
  if (f.fileCount === 0) {
    return ["Help me plan what to build here", "Scaffold a starter project with a test setup", "Write a README for this project"];
  }
  const tasks = [
    f.testCommand ? `Run the tests (${f.testCommand}) and fix what fails` : "Find the code most in need of tests and add a few",
    "Explain how this project is structured",
    f.issues[0] ? issueTask(f.issues[0]) : "Suggest three small, safe improvements to this codebase",
  ];
  return tasks.map(clipTask);
}

export const TOUR_SYSTEM_PROMPT =
  "You suggest starter tasks for a coding agent that just opened a repository. " +
  "From the facts given, write exactly three concrete, useful first tasks a developer would ask for, " +
  "each an imperative sentence under 70 characters. When open issues are listed, make one task pick up the most promising issue, " +
  "written as: Pick up issue #<number>: “<title>”. Reply with the three tasks only, one per line, no numbering, no markdown.";

/** The facts as the model sees them: counts and names only, never file contents. */
export function factsPrompt(f: ProjectFacts): string {
  const lines = [
    `Project: ${f.name}`,
    `Kind: ${f.kind ?? "unknown"}`,
    ...(f.language ? [`Language: ${f.language}`] : []),
    `Files tracked: ${f.fileCount}`,
    `Test command: ${f.testCommand ?? "none found"}`,
  ];
  if (f.issues.length) lines.push("Open issues:", ...f.issues.map((i) => `#${i.number} ${i.title}`));
  return lines.join("\n");
}

/** Parse the model's reply into up to three tasks (numbering and bullets stripped). */
export function parseSuggestions(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.replace(/^\s*(?:[-*•]|\d+[.):]?)\s*/, "").replace(/^["'`]|["'`]$/g, "").trim())
    .filter((l) => l.length >= 4)
    .slice(0, 3)
    .map(clipTask);
}

/** One small model call: system + user message in, text out. Must honour the signal. */
export type AskModel = (o: { system: string; user: string; maxTokens: number; signal: AbortSignal }) => Promise<string>;

export interface Suggestions {
  tasks: string[];
  source: "model" | "local";
}

/**
 * Three tasks: worded by one capped model call, or — when it fails, is
 * slower than `timeoutMs`, or returns fewer than three usable lines — the
 * local suggestions (a partial reply is topped up from them).
 */
export async function suggestTasks(
  f: ProjectFacts,
  ask: AskModel | null,
  o: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Suggestions> {
  const local = localSuggestions(f);
  if (!ask || f.fileCount === 0) return { tasks: local, source: "local" };
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  o.signal?.addEventListener("abort", onAbort, { once: true });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve(null);
      }, o.timeoutMs ?? TOUR_MODEL_TIMEOUT_MS);
      timer.unref?.();
    });
    const reply = await Promise.race([
      ask({ system: TOUR_SYSTEM_PROMPT, user: factsPrompt(f), maxTokens: TOUR_MAX_COMPLETION_TOKENS, signal: ctrl.signal }).catch(() => null),
      timeout,
    ]);
    const tasks = reply ? parseSuggestions(reply) : [];
    if (tasks.length === 0) return { tasks: local, source: "local" };
    for (const t of local) if (tasks.length < 3 && !tasks.includes(t)) tasks.push(t);
    return { tasks, source: "model" };
  } finally {
    if (timer) clearTimeout(timer);
    o.signal?.removeEventListener("abort", onAbort);
  }
}

// ── Rendering and selection ──────────────────────────────────────────────

export function summaryLine(f: ProjectFacts): string {
  const parts = [f.name];
  if (f.fileCount === 0) parts.push("empty repository");
  else {
    if (f.kind) parts.push(f.kind);
    parts.push(`${f.fileCount} file${f.fileCount === 1 ? "" : "s"}`);
    parts.push(f.testCommand ? `tests: ${f.testCommand}` : "no test command found");
  }
  return parts.join(" · ");
}

/** The tour as printed: summary, three numbered tasks, how to pick. */
export function renderTour(f: ProjectFacts, tasks: string[], o: { firstTime?: boolean } = {}): string {
  const lines = [`  ${summaryLine(f)}`, ...tasks.map((t, i) => `  ${i + 1}  ${t}`), `  ${TOUR_PROMPT}`];
  if (o.firstTime) lines.push("  /tour shows this again · /settings tour off turns it off");
  return lines.join("\n");
}

/**
 * The first thing typed while the tour is showing: "1"–"3" picks that task,
 * anything else goes through unchanged. Either way the tour is done.
 */
export function resolveTourInput(text: string, tasks: readonly string[] | null): string {
  if (!tasks) return text;
  const m = /^\s*([1-9])\s*$/.exec(text);
  const pick = m ? tasks[Number(m[1]) - 1] : undefined;
  return pick ?? text;
}

// ── "Shown" state, per project, outside the repo ─────────────────────────

export function tourStatePath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "project-tour.json");
}

async function readShown(file: string): Promise<Record<string, string>> {
  try {
    const v = JSON.parse(await readFile(file, "utf8")) as { shown?: Record<string, string> };
    return v.shown && typeof v.shown === "object" ? v.shown : {};
  } catch {
    return {};
  }
}

export async function tourShownFor(root: string, file = tourStatePath()): Promise<boolean> {
  return root in (await readShown(file));
}

export async function markTourShown(root: string, file = tourStatePath(), now = new Date()): Promise<void> {
  try {
    const shown = await readShown(file);
    shown[root] = now.toISOString();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, `${JSON.stringify({ shown }, null, 2)}\n`);
  } catch {
    // Best effort: at worst the tour shows once more.
  }
}

// ── Putting it together ──────────────────────────────────────────────────

export interface TourDeps {
  cwd: string;
  /** `/tour`: show it even when already shown or turned off. */
  force?: boolean;
  /** The projectTour setting (default on). */
  enabled: boolean;
  ask: AskModel | null;
  /** Aborted when the person types before the tour is ready: nothing is shown then. */
  signal?: AbortSignal;
  run?: RunCommand;
  statePath?: string;
  modelTimeoutMs?: number;
  issuesTimeoutMs?: number;
}

export type TourResult =
  | { kind: "shown"; text: string; tasks: string[]; source: Suggestions["source"]; facts: ProjectFacts }
  | { kind: "skipped"; reason: "off" | "not-a-repo" | "already-shown" | "typed" };

/**
 * Decide whether to show the tour and build it. Marks it shown for the
 * project only when it is actually returned for display.
 */
export async function buildTour(d: TourDeps): Promise<TourResult> {
  if (!d.force && !d.enabled) return { kind: "skipped", reason: "off" };
  const run = d.run ?? runCommand;
  const root = await gitRoot(d.cwd, run);
  if (!root) return { kind: "skipped", reason: "not-a-repo" };
  const file = d.statePath ?? tourStatePath();
  const seen = await tourShownFor(root, file);
  if (!d.force && seen) return { kind: "skipped", reason: "already-shown" };
  if (d.signal?.aborted) return { kind: "skipped", reason: "typed" };
  const facts = await gatherProjectFacts(root, { run, ...(d.issuesTimeoutMs !== undefined ? { issuesTimeoutMs: d.issuesTimeoutMs } : {}) });
  if (d.signal?.aborted) return { kind: "skipped", reason: "typed" };
  const { tasks, source } = await suggestTasks(facts, d.ask, {
    ...(d.modelTimeoutMs !== undefined ? { timeoutMs: d.modelTimeoutMs } : {}),
    ...(d.signal ? { signal: d.signal } : {}),
  });
  if (d.signal?.aborted) return { kind: "skipped", reason: "typed" };
  if (!seen) await markTourShown(root, file);
  return { kind: "shown", text: renderTour(facts, tasks, { firstTime: !seen }), tasks, source, facts };
}
