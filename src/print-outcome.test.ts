import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { assistantText, closingQuestion, unfinishedRun, UNFINISHED_EXIT_CODE } from "./print-outcome.js";
import { PROMPT_BLOCKED_EXIT_CODE } from "./hooks/prompt-submit.js";
import { buildSystemPrompt, HEADLESS_PROMPT_SECTION } from "./agent/system-prompt.js";

describe("print mode's unfinished-run exit code", () => {
  it("is 45, distinct from every other exit code", () => {
    assert.equal(UNFINISHED_EXIT_CODE, 45);
    assert.ok(![0, 1, 2, 42, 43, PROMPT_BLOCKED_EXIT_CODE].includes(UNFINISHED_EXIT_CODE));
  });

  it("a clean run is finished", () => {
    assert.equal(unfinishedRun({ denied: [], finalText: "Fixed the test. All 12 pass.", planOptions: false, turnEnd: "complete" }), null);
    assert.equal(unfinishedRun({ denied: [], finalText: "Done. Let me know if you need anything else.", planOptions: false, turnEnd: "complete" }), null);
  });

  it("any denied call makes it unfinished", () => {
    const r = unfinishedRun({ denied: ["write", "write", "bash"], finalText: "Done.", planOptions: false, turnEnd: "complete" });
    assert.deepEqual(r?.reasons, ["denied_tool_calls"]);
    assert.equal(r?.code, 45);
    assert.match(r?.message ?? "", /3 tool calls were denied \(write, bash\)/);
  });

  it("a final question, plan options, or a limit stopping the turn make it unfinished", () => {
    assert.deepEqual(unfinishedRun({ denied: [], finalText: "Should I also update the docs?", planOptions: false, turnEnd: "complete" })?.reasons, ["asks_user"]);
    assert.deepEqual(unfinishedRun({ denied: [], finalText: "Here are two plans.", planOptions: true, turnEnd: "complete" })?.reasons, ["plan_options"]);
    assert.deepEqual(unfinishedRun({ denied: [], finalText: "Stopped: reached the limit.", planOptions: false, turnEnd: "guardrail" })?.reasons, ["stopped_early"]);
  });

  it("the question heuristic is narrow: the last line, outside code, ends with '?'", () => {
    assert.ok(closingQuestion("I can't write to /etc.\n\nDo you want me to try with sudo?"));
    assert.ok(closingQuestion("Which file should I change?**"));
    assert.ok(closingQuestion("Proceed? (y/n)") === null, "ends with ')' after a non-question");
    assert.ok(closingQuestion("Should I proceed (yes/no)?") !== null);
    assert.equal(closingQuestion("Why did it fail? The cache was stale, so I cleared it."), null);
    assert.equal(closingQuestion("Fixed.\n```js\nconst ok = a ? b : c?\n```"), null);
    assert.equal(closingQuestion("Updated the README."), null);
    assert.equal(closingQuestion(""), null);
  });

  it("reads text from string or part content", () => {
    assert.equal(assistantText({ role: "assistant", content: "hi?" }), "hi?");
    assert.equal(assistantText({ role: "assistant", content: [{ type: "text", text: "a" }, { type: "text", text: "b?" }] }), "ab?");
    assert.equal(assistantText({ role: "assistant", content: null }), "");
  });
});

describe("the headless prompt section", () => {
  it("is in the system prompt only when headless (print mode)", () => {
    const base = { cwd: process.cwd(), tools: [], model: "m" };
    assert.ok(buildSystemPrompt({ ...base, headless: true }).includes(HEADLESS_PROMPT_SECTION));
    assert.ok(!buildSystemPrompt(base).includes(HEADLESS_PROMPT_SECTION));
    assert.ok(!buildSystemPrompt({ ...base, mode: "auto" }).includes("No one can answer questions"));
    assert.match(HEADLESS_PROMPT_SECTION, /No one can answer questions in this run; don't ask for permission or confirmation\. If an action is denied, choose another way or finish and report what's left\./);
  });
});
