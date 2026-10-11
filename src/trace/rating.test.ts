import { describe, it } from "node:test";
import assert from "node:assert";
import { dispatchSlashCommand, type SlashContext } from "../ui/slash-commands.js";
import { createMemoryRecorder, createNoopRecorder } from "./recorder.js";
import type { TurnRecord } from "../ui/use-session-manager.js";

function ctxWith(trace: SlashContext["traceRef"]["current"], turns: TurnRecord[]): { ctx: SlashContext; infos: string[] } {
  const infos: string[] = [];
  const ctx = {
    mkKey: () => `k${infos.length}`,
    setEvents: (updater: unknown) => {
      const next = typeof updater === "function" ? (updater as (prev: unknown[]) => Array<{ text?: string }>)([]) : [];
      for (const e of next) if (e.text) infos.push(e.text);
    },
    traceRef: { current: trace },
    turnHistoryRef: { current: turns },
  } as unknown as SlashContext;
  return { ctx, infos };
}

describe("/good and /bad", () => {
  it("records a rating bound to the last turn", async () => {
    const rec = createMemoryRecorder("s");
    const { ctx } = ctxWith(rec, [
      { turnId: "t1", endedAt: 1 },
      { turnId: "t2", endedAt: 2 },
    ]);
    assert.strictEqual(await dispatchSlashCommand(ctx, "/good"), true);
    assert.strictEqual(await dispatchSlashCommand(ctx, "/bad it deleted my tests"), true);
    const outcomes = rec.ofType("outcome").map((e) => ({ turn: e.turn_id, payload: e.payload }));
    assert.deepStrictEqual(outcomes, [
      { turn: "t2", payload: { kind: "rating", turn_id: "t2", value: "good" } },
      { turn: "t2", payload: { kind: "rating", turn_id: "t2", value: "bad", reason: "it deleted my tests" } },
    ]);
  });

  it("explains itself when there is no turn or tracing is off", async () => {
    const none = ctxWith(createMemoryRecorder("s"), []);
    await dispatchSlashCommand(none.ctx, "/good");
    assert.match(none.infos.join("\n"), /nothing to rate/);
    const off = ctxWith(createNoopRecorder("s"), [{ turnId: "t1", endedAt: 1 }]);
    await dispatchSlashCommand(off.ctx, "/bad");
    assert.match(off.infos.join("\n"), /tracing is off/);
  });
});
