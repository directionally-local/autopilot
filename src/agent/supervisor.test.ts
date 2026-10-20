import { describe, it } from "node:test";
import assert from "node:assert";
import { TurnSupervisor } from "./supervisor.js";
import type { AgentTurnOpts } from "./loop.js";

function supervisorWith(run: () => Promise<void>): TurnSupervisor {
  const s = new TurnSupervisor();
  (s as unknown as { _runAgentTurn: () => Promise<void> })._runAgentTurn = run;
  return s;
}

const opts = { sessionId: "s1" } as unknown as AgentTurnOpts;

describe("TurnSupervisor", () => {
  it("runs one turn at a time and reports completion", async () => {
    let release!: () => void;
    let runs = 0;
    const s = supervisorWith(() => {
      runs++;
      return new Promise<void>((r) => (release = r));
    });
    let done = 0;
    s.startTurn(opts, { onDone: () => void done++ });
    assert.strictEqual(s.isRunning, true);
    s.startTurn(opts); // ignored while running
    assert.strictEqual(runs, 1);
    release();
    await s.waitForIdle();
    assert.strictEqual(s.isRunning, false);
    assert.strictEqual(done, 1);
  });

  it("reports errors and clears the kill flag after the turn", async () => {
    const s = supervisorWith(() => Promise.reject(new Error("boom")));
    let error: Error | undefined;
    s.startTurn(opts, { onError: (e) => void (error = e) });
    s.killTurn();
    assert.strictEqual(s.killRequested, true);
    await s.waitForIdle();
    assert.strictEqual(error?.message, "boom");
    assert.strictEqual(s.killRequested, false);
    assert.strictEqual(s.phase, "idle");
  });

  it("ignores a kill when nothing is running", () => {
    const s = supervisorWith(() => Promise.resolve());
    s.killTurn();
    assert.strictEqual(s.killRequested, false);
  });
});
