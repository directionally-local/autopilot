import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { runSimpleView, simpleViewBanner, simpleViewRequested, simpleViewStartHint, type SimpleViewDeps } from "./simple-view.js";

function fakeDeps(lines: Array<string | null>, turn?: (prompt: string, id: string | undefined) => void) {
  const out: string[] = [];
  const turns: Array<{ prompt: string; sessionId: string | undefined }> = [];
  let n = 0;
  const deps: SimpleViewDeps = {
    readLine: async () => (lines.length ? lines.shift()! : null),
    write: (t) => out.push(t),
    runTurn: async (prompt, sessionId, onSession) => {
      turns.push({ prompt, sessionId });
      turn?.(prompt, sessionId);
      onSession(sessionId ?? `new-${++n}`);
    },
  };
  return { deps, out, turns };
}

describe("simpleViewRequested", () => {
  it("is on with --simple or AUTOPILOT_SIMPLE_VIEW=1, off otherwise", () => {
    assert.equal(simpleViewRequested(true, {}), true);
    assert.equal(simpleViewRequested(undefined, { AUTOPILOT_SIMPLE_VIEW: "1" }), true);
    assert.equal(simpleViewRequested(false, { AUTOPILOT_SIMPLE_VIEW: "true" }), true);
    assert.equal(simpleViewRequested(undefined, { AUTOPILOT_SIMPLE_VIEW: "0" }), false);
    assert.equal(simpleViewRequested(undefined, {}), false);
  });

  it("the start hint uses dl's command under dl", () => {
    assert.equal(simpleViewStartHint({ AUTOPILOT_LAUNCHED_BY: "dl" }), "AUTOPILOT_SIMPLE_VIEW=1 dl");
    assert.match(simpleViewStartHint({}), /autopilot --simple/);
  });
});

describe("runSimpleView", () => {
  it("sends each line as a turn on one session, and stops at /exit", async () => {
    const { deps, out, turns } = fakeDeps(["fix the test", "", "  and push  ", "/exit", "never sent"]);
    const id = await runSimpleView({ env: {} }, deps);
    assert.deepEqual(turns, [
      { prompt: "fix the test", sessionId: undefined },
      { prompt: "and push", sessionId: "new-1" },
    ]);
    assert.equal(id, "new-1");
    assert.match(out[0]!, /autopilot simple view .*\/exit quits/);
    assert.match(out.at(-1)!, /autopilot -S new-1/);
  });

  it("continues the crashed full screen view's session", async () => {
    const { deps, out, turns } = fakeDeps(["go on"]);
    await runSimpleView({ sessionId: "s1", env: { AUTOPILOT_LAUNCHED_BY: "dl" } }, deps);
    assert.deepEqual(turns, [{ prompt: "go on", sessionId: "s1" }]);
    assert.match(out[0]!, /^dl simple view/);
    assert.match(out[0]!, /Continuing this conversation \(session s1\)/);
    assert.match(out.at(-1)!, /dl -c/);
  });

  it("ends on end of input; slash commands other than /exit are explained, not sent", async () => {
    const { deps, out, turns } = fakeDeps(["/model x", null]);
    assert.equal(await runSimpleView({ env: {} }, deps), null);
    assert.deepEqual(turns, []);
    assert.ok(out.some((l) => /only \/exit works/.test(l)));
  });

  it("a failed turn doesn't end the loop or leave an exit code behind", async () => {
    const before = process.exitCode;
    const { deps, out, turns } = fakeDeps(["one", "two", "/quit"], (prompt) => {
      process.exitCode = 1;
      if (prompt === "one") throw new Error("provider said no");
    });
    try {
      await runSimpleView({ env: {} }, deps);
      assert.equal(turns.length, 2);
      assert.ok(out.some((l) => l === "autopilot: provider said no\n"));
      assert.equal(process.exitCode, before);
    } finally {
      process.exitCode = before;
    }
  });

  it("the banner says approvals are refused", () => {
    assert.match(simpleViewBanner({}, {}), /need your approval are refused/);
  });
});
