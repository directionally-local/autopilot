import { describe, it } from "node:test";
import assert from "node:assert";
import type { ChatMessage } from "../agent/messages.js";
import { loadSession, saveSession } from "../sessions.js";
import { buildResumeReplay } from "./resume-replay.js";
import { buildWhereYouLeftOff, checkOutcome, continuePrompt, displayCommand, formatWhereYouLeftOff, isCheckCommand } from "./resume-summary.js";

const user = (content: string): ChatMessage => ({ role: "user", content });
const text = (content: string): ChatMessage => ({ role: "assistant", content });
let n = 0;
function call(name: string, args: Record<string, unknown>): { msg: ChatMessage; id: string } {
  const id = `call_${++n}`;
  return { id, msg: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }] } as ChatMessage };
}
const result = (id: string, content: string): ChatMessage => ({ role: "tool", tool_call_id: id, content }) as ChatMessage;

const tasks = (list: [string, string][]) => call("tasks_set", { tasks: list.map(([title, status], i) => ({ id: String(i + 1), title, status })) });

/** A long task that was cut off while `npm run build` ran. */
function interruptedHistory(): ChatMessage[] {
  const t1 = tasks([["Reproduce the failing test", "in_progress"], ["Fix the date parsing", "pending"], ["Run the full suite and build", "pending"]]);
  const edit = call("edit", { path: "src/date.ts", old_string: "a", new_string: "b" });
  const test = call("bash", { command: "cd /repo && npm test" });
  const lint = call("bash", { command: "npm run lint" });
  const t2 = tasks([["Reproduce the failing test", "completed"], ["Fix the date parsing", "completed"], ["Run the full suite and build", "in_progress"]]);
  const build = call("bash", { command: "npm run build" });
  return [
    { role: "system", content: "you are autopilot" },
    user("Fix the flaky date test and make CI green\n\nDetails: it fails around midnight UTC."),
    t1.msg, result(t1.id, "3 tasks set"),
    edit.msg, result(edit.id, "edited src/date.ts"),
    test.msg, result(test.id, "exit=0\n--- stdout ---\n# tests 42\nℹ pass 42\nℹ fail 0"),
    lint.msg, result(lint.id, "exit=1\n--- stdout ---\n2 problems"),
    t2.msg, result(t2.id, "3 tasks set"),
    build.msg, // no result: the terminal was closed while it ran
  ];
}

describe("where you left off", () => {
  it("reads the goal, finished tasks, checks with pass/fail, the interrupted command and what's left", () => {
    const s = buildWhereYouLeftOff(interruptedHistory())!;
    assert.equal(s.goal, "Fix the flaky date test and make CI green");
    assert.deepStrictEqual(s.done, ["Reproduce the failing test", "Fix the date parsing"]);
    assert.deepStrictEqual(s.filesChanged, ["src/date.ts"]);
    assert.deepStrictEqual(s.checks, [
      { command: "npm test", outcome: "passed", detail: "42 passed" },
      { command: "npm run lint", outcome: "failed", detail: "exit 1" },
    ]);
    assert.deepStrictEqual(s.inProgress, ["Run the full suite and build", "npm run build — interrupted"]);
    assert.equal(s.interrupted, 1);
    assert.equal(s.stoppedMidTask, true);
    assert.equal(
      formatWhereYouLeftOff(s, { updatedAt: "2026-11-26T09:13:00.000Z", now: Date.parse("2026-11-26T12:00:00.000Z"), timeZone: "UTC" }),
      [
        "Where you left off: stopped mid-task today at 09:13",
        "Goal: Fix the flaky date test and make CI green",
        "Done",
        "  ✓ Reproduce the failing test",
        "  ✓ Fix the date parsing",
        "  ✓ Changed src/date.ts",
        "Checks",
        "  ✓ npm test  42 passed",
        "  ✗ npm run lint  exit 1",
        "In progress when it stopped",
        "  ▸ Run the full suite and build",
        "  ▸ npm run build — interrupted",
      ].join("\n"),
    );
  });

  it("survives a crash: a call saved without a result loads as interrupted, not lost", async () => {
    const now = new Date().toISOString();
    const path = await saveSession({ id: "left-off-crash", cwd: "/repo", model: "m", createdAt: now, updatedAt: now, messages: interruptedHistory() });
    const file = await loadSession(path); // heals the dangling call with a (stopped) result
    const last = file.messages[file.messages.length - 1]!;
    assert.equal(last.role, "tool");
    const s = buildWhereYouLeftOff(file.messages)!;
    assert.ok(s.inProgress.includes("npm run build — interrupted"));
    assert.equal(s.stoppedMidTask, true);
  });

  it("is not offered for a request that finished", () => {
    const t = tasks([["Do it", "completed"]]);
    const s = buildWhereYouLeftOff([user("rename foo to bar"), t.msg, result(t.id, "ok"), text("Done: renamed.")])!;
    assert.equal(s.stoppedMidTask, false);
  });

  it("counts a request with no reply, a run stopped after a tool, and unfinished tasks as mid-task", () => {
    assert.equal(buildWhereYouLeftOff([user("do a thing")])!.stoppedMidTask, true);
    const b = call("bash", { command: "ls" });
    const afterTool = buildWhereYouLeftOff([user("do a thing"), b.msg, result(b.id, "exit=0")])!;
    assert.equal(afterTool.stoppedMidTask, true);
    assert.deepStrictEqual(afterTool.inProgress, ["the next step after the last tool result — interrupted"]);
    const t = tasks([["One", "completed"], ["Two", "pending"]]);
    const s = buildWhereYouLeftOff([user("two steps"), t.msg, result(t.id, "ok"), text("Did one.")])!;
    assert.equal(s.stoppedMidTask, true);
    assert.deepStrictEqual(s.pending, ["Two"]);
  });

  it("while a turn runs, calls without a result are running, not interrupted", () => {
    const b = call("bash", { command: "npm test" });
    const s = buildWhereYouLeftOff([user("run the tests"), b.msg], { running: true })!;
    assert.deepStrictEqual(s.inProgress, ["npm test — running"]);
    assert.equal(s.interrupted, 0);
    assert.equal(s.stoppedMidTask, false);
  });

  it("keeps the goal across a bare 'continue' and our own Continue prompt", () => {
    const first = buildWhereYouLeftOff(interruptedHistory())!;
    const history = [...interruptedHistory(), user(continuePrompt(first)), text("Picking up.")];
    assert.equal(buildWhereYouLeftOff(history)!.goal, "Fix the flaky date test and make CI green");
    assert.equal(buildWhereYouLeftOff([user("Port the parser to Rust"), text("Started."), user("continue")])!.goal, "Port the parser to Rust");
  });

  it("the Continue prompt carries the summary and shows as a short request on the next resume", () => {
    const s = buildWhereYouLeftOff(interruptedHistory())!;
    const prompt = continuePrompt(s);
    assert.match(prompt, /npm run build — interrupted/);
    assert.match(prompt, /run it again if it's still needed/);
    const replay = buildResumeReplay({ messages: [user(prompt)], updatedAt: new Date().toISOString() });
    assert.equal(replay.exchanges[0]!.user, "Continue where it left off");
  });

  it("says when there's no task list to tell what's left", () => {
    const b = call("bash", { command: "npm test" });
    const s = buildWhereYouLeftOff([user("fix it"), b.msg, result(b.id, "(stopped)")])!;
    assert.match(formatWhereYouLeftOff(s), /Still to do: not recorded/);
  });

  it("returns null for an empty conversation", () => {
    assert.equal(buildWhereYouLeftOff([{ role: "system", content: "x" }]), null);
  });
});

describe("check outcomes", () => {
  it("reads exit codes and test counts from common runners", () => {
    assert.deepStrictEqual(checkOutcome("exit=0\n Test Files  3 passed (3)\n      Tests  42 passed (42)"), { outcome: "passed", detail: "42 passed" });
    assert.deepStrictEqual(checkOutcome("exit=1\nTests:       1 failed, 41 passed, 42 total"), { outcome: "failed", detail: "41 passed, 1 failed" });
    assert.deepStrictEqual(checkOutcome("exit=1\n=== 2 failed, 10 passed in 1.2s ==="), { outcome: "failed", detail: "10 passed, 2 failed" });
    assert.deepStrictEqual(checkOutcome("exit=2\nerror TS2322"), { outcome: "failed", detail: "exit 2" });
    assert.deepStrictEqual(checkOutcome("(timed out after 120000ms)"), { outcome: "failed", detail: "timed out" });
    assert.deepStrictEqual(checkOutcome("[artifact a1: 4 KB]"), { outcome: "ran" });
  });

  it("spots checks by command word, not words inside paths", () => {
    for (const c of ["npm test", "cd /repo && npm run test:unit", "pytest -q tests/", "make check", "node --test", "./node_modules/.bin/jest", "npx tsc --noEmit", "cargo clippy"]) {
      assert.equal(isCheckCommand(c), true, c);
    }
    for (const c of ["ls -la /root/rs-test && cat /root/rs-test/package.json", "cat src/build-info.ts", "git status", "sleep 5"]) {
      assert.equal(isCheckCommand(c), false, c);
    }
  });

  it("shows commands without a leading cd and cut to one line", () => {
    assert.equal(displayCommand("cd /repo && npm test\necho done"), "npm test");
    assert.ok(displayCommand(`npm test -- ${"x".repeat(100)}`).endsWith("…"));
  });
});

describe("where you left off in Code Mode", () => {
  const taskList = (statuses: string[]) =>
    `await api.tasks_set({ tasks: [\n${["Run npm test", "Add mul to math.js", "Run tests with: sleep 40 && npm test", "Document add, sub, mul in README.md"]
      .map((title, i) => `  { id: "${i + 1}", status: "${statuses[i]}", title: "${title}" },`)
      .join("\n")}\n]});\n`;
  const code = (src: string, reasoning?: string) => call("execute_code", { code: src, ...(reasoning ? { reasoning } : {}) });

  /** The calls live inside execute_code scripts; the last one was cut off when the terminal closed. */
  function codeModeHistory(): ChatMessage[] {
    const c1 = code(`${taskList(["in_progress", "pending", "pending", "pending"])}const out = await api.bash({ command: "cd /root/p && npm test 2>&1", timeout_ms: 60000 });\nconsole.log(out);`);
    const c2 = code(`${taskList(["completed", "in_progress", "pending", "pending"])}const r = await api.edit({\n  path: "/root/p/math.js",\n  old_string: \`a\`,\n  new_string: \`export function mul(a, b) { return a * b; }\`,\n});\nconsole.log(r);`);
    const c3 = code(`const out = await api.bash({ command: "cd /root/p && npm test 2>&1" });\nconsole.log(out);`);
    const c4 = code(`${taskList(["completed", "completed", "in_progress", "pending"])}const out = await api.bash({ command: "cd /root/p && sleep 40 && npm test 2>&1", timeout_ms: 120000 });\nconsole.log(out);`, "Run the tests");
    return [
      user("Make a task list, add mul, run the tests, then update the README"),
      c1.msg, result(c1.id, "exit=1\n--- stdout ---\n✔ add\n✖ sub\nℹ tests 2\nℹ pass 1\nℹ fail 1"),
      c2.msg, result(c2.id, "Replaced 1 occurrence(s) in /root/p/math.js."),
      c3.msg, result(c3.id, "exit=0\n--- stdout ---\nℹ tests 3\nℹ pass 3\nℹ fail 0"),
      c4.msg, result(c4.id, "Error: The Code Mode sandbox was shut down.\n\nOutput:\n"),
    ];
  }

  it("reads tasks, changed files, checks and the cut-off command from the scripts", () => {
    const s = buildWhereYouLeftOff(codeModeHistory())!;
    assert.deepStrictEqual(s.done, ["Run npm test", "Add mul to math.js"]);
    assert.deepStrictEqual(s.filesChanged, ["/root/p/math.js"]);
    assert.deepStrictEqual(s.checks, [{ command: "npm test", outcome: "passed", detail: "3 passed" }]);
    assert.deepStrictEqual(s.inProgress, ["Run tests with: sleep 40 && npm test", "sleep 40 && npm test — interrupted"]);
    assert.deepStrictEqual(s.pending, ["Document add, sub, mul in README.md"]);
    assert.equal(s.interrupted, 1);
    assert.equal(s.stoppedMidTask, true);
    assert.equal(s.hasTaskList, true);
  });

  it("shows a failed check from a script's output", () => {
    const h = codeModeHistory().slice(0, 3);
    const s = buildWhereYouLeftOff(h)!;
    assert.deepStrictEqual(s.checks, [{ command: "npm test", outcome: "failed", detail: "1 passed, 1 failed" }]);
  });

  it("labels a cut-off script without commands by its reasoning", () => {
    const c = code("const x = await api.read({ path: 'a.ts' });\nconsole.log(x);", "Read the parser");
    const s = buildWhereYouLeftOff([user("Fix the parser"), c.msg])!;
    assert.deepStrictEqual(s.inProgress, ["Read the parser — interrupted"]);
  });

  it("doesn't attribute one output to several checks in a script", () => {
    const c = code(`const a = await api.bash({ command: 'npm test' });\nconst b = await api.bash({ command: 'npm run lint' });\nconsole.log(a, b);`);
    const s = buildWhereYouLeftOff([user("Check everything"), c.msg, result(c.id, "exit=0\nℹ pass 3"), text("All good.")])!;
    assert.deepStrictEqual(s.checks, []);
  });
});
