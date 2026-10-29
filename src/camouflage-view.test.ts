import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpOptions, listMentionDir, modelOptions, noticeSeverity, queuePlanOptions, shouldSendSubagentPolicyNotice, splitBangResult, statusSegments, syncSlashCommands, toolOutputWithCommand, toolRow, toolSummary, validateCommandName } from "./camouflage-view.js";
import type { AppActions, AppSnapshot } from "./ui/app-bridge.js";
import { listModels } from "./models/registry.js";
import { bashTool } from "./tools/bash.js";
import { jobStartTool } from "./tools/jobs.js";

describe("Camouflage event sync helpers", () => {
  it("registers slash commands only when the complete payload changes", () => {
    const sent: { name: string; description?: string; args_hint?: string }[][] = [];
    const send = (commands: { name: string; description?: string; args_hint?: string }[]) => sent.push(commands);
    let key = syncSlashCommands([], undefined, send);
    key = syncSlashCommands([], key, send);
    key = syncSlashCommands([{ name: "review", description: "Review changes" }], key, send);
    key = syncSlashCommands([{ name: "review", description: "Review changes" }], key, send);
    key = syncSlashCommands([{ name: "review", description: "Review carefully" }], key, send);
    assert.equal(sent.length, 3, "startup sends once, then only the add and edit changes");
    assert.ok(sent[0]!.some((command) => command.args_hint), "built-in argument hints are in the registered payload");
    assert.deepEqual(sent[2]!.at(-1), { name: "review", description: "Review carefully (custom)" });
  });

  it("deduplicates repeated policy notices but keeps user-directed decisions", () => {
    const sent = new Set<string>();
    const automatic = "Subagent policy: auto will assess this substantial task for independent work; worker calls remain permission-gated.";
    assert.equal(shouldSendSubagentPolicyNotice(automatic, sent), true);
    assert.equal(shouldSendSubagentPolicyNotice(automatic, sent), false);
    assert.equal(shouldSendSubagentPolicyNotice("Subagent policy: auto policy changed.", sent), true);
    const explicit = "Subagent policy: respecting your explicit request to delegate. Worker calls still require permission.";
    assert.equal(shouldSendSubagentPolicyNotice(explicit, sent), true);
    assert.equal(shouldSendSubagentPolicyNotice(explicit, sent), true);
  });

  it("strips bang status from output and preserves ordinary tool output", () => {
    assert.deepEqual(splitBangResult("! false", "exit=7\nfailed\n"), { output: "failed\n", status: "exit=7", exitCode: 7 });
    assert.deepEqual(splitBangResult("! kill", "signal=SIGTERM\npartial output"), { output: "partial output", status: "signal=SIGTERM" });
    assert.deepEqual(splitBangResult("Bash", "exit=1\nnot a bang command"), { output: "exit=1\nnot a bang command" });
  });
});
describe("noticeSeverity (#889)", () => {
  it("shows warning-toned info events, such as a failed hook, as warnings", () => {
    assert.strictEqual(noticeSeverity({ kind: "info", key: "k", text: "hook x (PreToolUse) failed: …", tone: "warn" }), "warn");
    assert.strictEqual(noticeSeverity({ kind: "info", key: "k", text: "plain" }), "info");
  });
});

describe("listMentionDir", () => {
  it("lists the folder being typed, folders first, prefixed as typed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-"));
    await mkdir(join(root, "proj"));
    await mkdir(join(root, "zeta"));
    await writeFile(join(root, "a.md"), "");
    await writeFile(join(root, ".hidden"), "");
    const cwd = join(root, "proj");
    assert.deepEqual(await listMentionDir(cwd, "../"), { dir: "../", entries: ["../proj/", "../zeta/", "../a.md"] });
    assert.deepEqual((await listMentionDir(cwd, "..")).dir, "../");
    assert.deepEqual((await listMentionDir(cwd, "../ze")).entries[0], "../proj/");
    assert.deepEqual(await listMentionDir(cwd, "../nope/x"), { dir: "../nope/", entries: [] });
  });
});

describe("tool rows", () => {
  it("splits a render title into name and arguments", () => {
    assert.deepEqual(toolRow("read", "read src/a.ts", "{}"), { label: "Read", args: "src/a.ts" });
    assert.deepEqual(toolRow("mcp_x_y", undefined, '{"q":1}'), { label: "mcp_x_y", args: '{"q":1}' });
  });
  it("describes execute_code by its reasoning or first code line instead of raw JSON", () => {
    assert.deepEqual(toolRow("execute_code", undefined, '{"code":"const p = 1;\\nconsole.log(p);","reasoning":"Check the  worktree state"}'), { label: "Code", args: "Check the worktree state" });
    assert.deepEqual(toolRow("execute_code", undefined, '{"code":"// read files\\nconst r = await api.read({path:\\"a\\"});"}'), { label: "Code", args: 'const r = await api.read({path:"a"});' });
    assert.deepEqual(toolRow("execute_code", undefined, "not json"), { label: "Code", args: "running a code batch" });
  });
  it("collapses a long shell command to a short preview with +N lines", () => {
    const script = ["for r in 1 2 3; do", '  echo "=== rep $r"', ...Array.from({ length: 12 }, (_, i) => `  echo ${i}`), "done"].join("\n");
    const raw = JSON.stringify({ command: script });
    const title = bashTool.render!({ command: script }).title;
    assert.equal(title, "$ for r in 1 2 3; do … +14 lines");
    assert.deepEqual(toolRow("bash", title, raw), { label: "Bash", args: "$ for r in 1 2 3; do … +14 lines" });
    assert.deepEqual(toolRow("bash", title, raw, 80), { label: "Bash", args: "$ for r in 1 2 3; do … +14 lines" });
    const job = jobStartTool.render!({ command: script }).title;
    assert.equal(job, "job_start: for r in 1 2 3; do … +14 lines");
    assert.deepEqual(toolRow("job_start", job, raw, 80), { label: "Job_start", args: "job_start: for r in 1 2 3; do … +14 lines" });
  });
  it("keeps short shell commands unchanged and fits long lines to the terminal", () => {
    const raw = JSON.stringify({ command: "npm test" });
    assert.deepEqual(toolRow("bash", bashTool.render!({ command: "npm test" }).title, raw, 80), { label: "Bash", args: "$ npm test" });
    const long = `echo ${"x".repeat(300)}`;
    const row = toolRow("bash", bashTool.render!({ command: long }).title, JSON.stringify({ command: long }), 60);
    assert.equal(Array.from(row.args).length, 60 - "Bash".length - 12);
    assert.match(row.args, /^\$ echo x+…$/);
    assert.equal(Array.from(toolRow("bash", bashTool.render!({ command: long }).title, JSON.stringify({ command: long })).args).length, 120);
  });
  it("puts a collapsed command in the expandable output, after the result", () => {
    assert.equal(toolOutputWithCommand("ok\n", "npm test"), "ok\n");
    assert.equal(toolOutputWithCommand("ok\n", "make\nmake test"), "ok\n\nFull command:\nmake\nmake test");
    assert.equal(toolOutputWithCommand("", "make\nmake test"), "Full command:\nmake\nmake test");
    assert.equal(toolOutputWithCommand("ok", undefined), "ok");
  });
  it("summarizes results", () => {
    assert.equal(toolSummary("read", true, false, "a\nb\nc\n"), "3 lines");
    assert.equal(toolSummary("grep", true, false, ""), "No matches");
    assert.equal(toolSummary("bash", false, false, "\nboom: failed\n"), "boom: failed");
    assert.match(toolSummary("edit", false, true, "Permission denied"), /declined/);
  });
});

describe("modelOptions", () => {
  it("matches the Ink picker: current, then best & latest, then the rest, with columns", () => {
    const models = listModels().filter((m) => m.supports.tools);
    const current = models[models.length - 1]!.id;
    const opts = modelOptions(models, current);
    assert.equal(opts.length, models.length, "every model is reachable");
    assert.ok(opts.every((o) => o.columns?.length === 2), "context and price columns");
    const sections = [...new Set(opts.map((o) => o.section))];
    assert.ok(sections.some((x) => x?.startsWith("Best & latest")));
    if (sections[0] === "Current") assert.equal(opts[0]!.value, current);
  });
});

describe("helpOptions", () => {
  it("lists the Ink help pages as sections, with custom commands last", () => {
    const opts = helpOptions([{ name: "ship", description: "Ship it" }]);
    const sections = [...new Set(opts.map((o) => o.section))];
    assert.deepEqual(sections.slice(0, 3), ["Mode", "Session", "Memory"]);
    assert.ok(opts.some((o) => o.value === "/memory search <query>"), "argument templates are pickable");
    assert.deepEqual(opts[opts.length - 1], { value: "/ship", label: "/ship", description: "Ship it", section: "Custom commands" });
  });
});

describe("validateCommandName", () => {
  it("applies the Ink wizard's rules", () => {
    assert.equal(validateCommandName("review", []), null);
    assert.equal(validateCommandName("ops/deploy-check", []), null);
    assert.match(validateCommandName("1bad", [])!, /start with a letter/);
    assert.match(validateCommandName("Model", [])!, /built-in/);
    assert.match(validateCommandName("review", ["review"])!, /already exists/);
  });
});

describe("rendererInfo (#862)", () => {
  it("reports the package's own binary and version, and CAMOUFLAGE_BIN when set", async () => {
    const { rendererInfo } = await import("./camouflage-view.js");
    const info = rendererInfo({});
    assert.strictEqual(info.source, "package");
    assert.match(String(info.packageVersion), /^\d+\.\d+\.\d+/);
    assert.match(info.binary, /node_modules\/camouflage-tui\/bin\/camouflage-tui$/);
    assert.deepStrictEqual(
      (({ source, binary }) => ({ source, binary }))(rendererInfo({ CAMOUFLAGE_BIN: "/opt/custom/camouflage-tui" })),
      { source: "CAMOUFLAGE_BIN", binary: "/opt/custom/camouflage-tui" },
    );
  });
});

// ----- driving App through the bridge ---------------------------------------

type Sent = { type: string; payload: Record<string, unknown> };

function baseSnapshot(over: Partial<AppSnapshot> = {}): AppSnapshot {
  return {
    events: [], busy: false, turnRunning: false, sessionId: null, workers: [], mode: "auto", modesEnabled: false,
    model: "vendor/model-x", usage: null, sessionUsage: null, contextLimit: 100_000, turnPhase: "waiting", currentTool: null,
    kimiMdStale: false, codeMode: false, intentTier: null, tasks: [], permission: null, modals: [], providerSetup: null,
    resumeSessions: null, checkpoints: null, planOptions: null, queuePlan: null, customCommands: [],
    currentShell: "auto", memoryEnabled: false, customCommandDefs: [], commandWizard: null, commandPickerMode: null,
    changelogImageRepo: null, hooks: [], lsp: { servers: {}, scope: "global", hasProjectDir: false },
    ...over,
  };
}

/** A View on a fake renderer: records what it sends and answers prompts from queues. */
async function fakeView(answers: { permission?: { choice: "allow_once" | "allow_session" | "deny"; feedback?: string }[]; form?: { values?: Record<string, string>; cancelled: boolean }[]; select?: (string | null)[] }) {
  process.env.AUTOPILOT_JOBS_DB = join(await mkdtemp(join(tmpdir(), "cam-view-")), "jobs.db");
  const { View } = await import("./camouflage-view.js");
  const sent: Sent[] = [];
  const prompts: Sent[] = [];
  const cam = { send: (type: string, payload: Record<string, unknown> = {}) => (sent.push({ type, payload }), true), on() { return this; }, close: async () => 0 };
  const sdk = {
    mount: async () => cam,
    permission: async (_c: unknown, spec: Record<string, unknown>) => (prompts.push({ type: "permission", payload: spec }), answers.permission!.shift()!),
    selectList: async (_c: unknown, spec: Record<string, unknown>) => {
      prompts.push({ type: "select", payload: spec });
      const value = answers.select!.shift();
      return value === null || value === undefined ? { id: "", cancelled: true } : { id: "", value, cancelled: false };
    },
    confirm: async () => ({ id: "", cancelled: true }),
    form: async (_c: unknown, spec: Record<string, unknown>) => (prompts.push({ type: "form", payload: spec }), { id: "", ...answers.form!.shift()! }),
  };
  const view = new View(cam as never, sdk as never);
  const calls: [string, unknown][] = [];
  const record = (name: string) => (arg?: unknown) => void calls.push([name, arg]);
  view.connect(new Proxy({}, { get: (_t, name) => record(String(name)) }) as AppActions);
  return { view, sent, prompts, calls, cam };
}

const settle = () => new Promise((r) => setTimeout(r, 120));
const permission = { tool: { name: "bash", description: "", parameters: {}, needsPermission: true, run: async () => "" } as never, args: { command: "rm -rf build" } };

describe("Camouflage /queue plan", () => {
  it("shows the queued follow-ups and answers the picker, so the queue can drain", async () => {
    const { view, sent, prompts, calls } = await fakeView({ select: ["group"] });
    view.sync(baseSnapshot({ queuePlan: { prompts: ["fix the tests", "then update the docs"] } }));
    await settle();
    assert.deepStrictEqual(calls, [["pickQueuePlan", "group"]]);
    const splash = sent.find((s) => s.type === "Splash");
    assert.match(String(splash?.payload.text), /1\..*fix the tests[\s\S]*2\..*then update the docs/);
    assert.strictEqual((prompts[0]?.payload.options as { value: string }[]).map((o) => o.value).join(), "group,separate,cancel");
    view.dispose();
  });

  it("cancelling (Esc or the cancel option) clears the plan with null", async () => {
    for (const answer of [null, "cancel"]) {
      const { view, calls } = await fakeView({ select: [answer] });
      view.sync(baseSnapshot({ queuePlan: { prompts: ["a", "b"] } }));
      await settle();
      assert.deepStrictEqual(calls, [["pickQueuePlan", null]]);
      view.dispose();
    }
  });

  it("queuePlanOptions counts the follow-ups", () => {
    assert.match(queuePlanOptions(3)[0]!.label, /Group 3 follow-ups/);
  });
});

describe("Camouflage permission: deny with feedback", () => {
  it("asks what to do instead and sends it to the model", async () => {
    const { view, prompts, calls } = await fakeView({ permission: [{ choice: "deny" }], form: [{ values: { feedback: "  use git clean instead " }, cancelled: false }] });
    view.sync(baseSnapshot({ permission }));
    await settle();
    assert.strictEqual(prompts[1]?.type, "form");
    assert.deepStrictEqual(calls, [["denyWithFeedback", "use git clean instead"]]);
    view.dispose();
  });

  it("an empty or cancelled form is a plain deny", async () => {
    for (const form of [{ values: { feedback: "" }, cancelled: false }, { cancelled: true }]) {
      const { view, calls } = await fakeView({ permission: [{ choice: "deny" }], form: [form] });
      view.sync(baseSnapshot({ permission }));
      await settle();
      assert.deepStrictEqual(calls, [["decidePermission", "deny"]]);
      view.dispose();
    }
  });

  it("Esc (deny + cancelRequested) denies without asking", async () => {
    const { view, prompts, calls } = await fakeView({ permission: [{ choice: "deny" }], form: [] });
    view.sync(baseSnapshot({ permission }));
    view.cancels++; // what the cancelRequested handler does
    await settle();
    assert.deepStrictEqual(calls, [["decidePermission", "deny"]]);
    assert.ok(!prompts.some((p) => p.type === "form"));
    view.dispose();
  });

  it("uses feedback the renderer collected itself, and still allows", async () => {
    const a = await fakeView({ permission: [{ choice: "deny", feedback: "try the dry run" }] });
    a.view.sync(baseSnapshot({ permission }));
    await settle();
    assert.deepStrictEqual(a.calls, [["denyWithFeedback", "try the dry run"]]);
    a.view.dispose();
    const b = await fakeView({ permission: [{ choice: "allow_session" }] });
    b.view.sync(baseSnapshot({ permission }));
    await settle();
    assert.deepStrictEqual(b.calls, [["decidePermission", "allow_session"]]);
    b.view.dispose();
  });

  it("shows a collapsed command in full as the prompt's detail", async () => {
    const command = "for f in a b; do\n  echo $f\ndone";
    const { view, prompts } = await fakeView({ permission: [{ choice: "allow_once" }] });
    view.sync(baseSnapshot({ permission: { tool: bashTool as never, args: { command } } }));
    await settle();
    assert.strictEqual(prompts[0]?.payload.action, "$ for f in a b; do … +2 lines");
    assert.strictEqual(prompts[0]?.payload.detail, command);
    view.dispose();
    const short = await fakeView({ permission: [{ choice: "allow_once" }] });
    short.view.sync(baseSnapshot({ permission: { tool: bashTool as never, args: { command: "npm test" } } }));
    await settle();
    assert.strictEqual(short.prompts[0]?.payload.detail, undefined);
    short.view.dispose();
  });
});

describe("statusSegments", () => {
  const usage = { prompt_tokens: 85_000, completion_tokens: 10, total_tokens: 85_010 };
  it("shows context used, and warns near the limit", () => {
    const low = statusSegments(baseSnapshot({ usage: { ...usage, prompt_tokens: 42_000 } }));
    assert.strictEqual(low.context, "ctx 42%");
    assert.strictEqual(low.warn, "");
    assert.match(statusSegments(baseSnapshot({ usage })).warn!, /ctx 85% · \/compact recommended/);
  });

  it("names the running tool and the turn's intent", () => {
    const seg = statusSegments(baseSnapshot({ busy: true, turnPhase: "executing", currentTool: "bash", intentTier: "light" }));
    assert.strictEqual(seg.phase, "tool");
    assert.strictEqual(seg.activity, "Running bash");
    assert.strictEqual(seg.intent, "light task");
    const thinking = statusSegments(baseSnapshot({ busy: true, turnPhase: "generating", intentTier: "medium" }));
    assert.strictEqual(thinking.phase, "thinking");
    assert.strictEqual(thinking.activity, "");
    const idle = statusSegments(baseSnapshot({ intentTier: "heavy" }));
    assert.strictEqual(idle.phase, "idle");
    assert.strictEqual(idle.intent, "");
  });

  it("badges code mode and a stale project context file", () => {
    const seg = statusSegments(baseSnapshot({ codeMode: true, kimiMdStale: true }));
    assert.strictEqual(seg.code, "code mode");
    assert.match(seg.warn!, /stale · run \/init/);
    assert.strictEqual(statusSegments(baseSnapshot()).code, "");
  });
});
