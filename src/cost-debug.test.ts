import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { comparePromptPrefixes, logTurnDebug, logTurnOutcome, logProviderResolution, type TurnDebugContext } from "./cost-debug.js";
import type { ChatMessage } from "./agent/messages.js";

describe("comparePromptPrefixes", () => {
  it("detects no change when prefixes are identical", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "static" },
      { role: "system", content: "session" },
      { role: "user", content: "hello" },
    ];
    const diag = comparePromptPrefixes(msgs, msgs);
    assert.strictEqual(diag.changedSegment, "none");
    assert.strictEqual(diag.firstDiffByte, null);
  });

  it("detects static prefix change", () => {
    const prev: ChatMessage[] = [
      { role: "system", content: "static A" },
      { role: "system", content: "session" },
    ];
    const curr: ChatMessage[] = [
      { role: "system", content: "static B" },
      { role: "system", content: "session" },
    ];
    const diag = comparePromptPrefixes(prev, curr);
    assert.strictEqual(diag.changedSegment, "static");
    assert.ok(diag.firstDiffByte !== null);
  });

  it("detects session prefix change", () => {
    const prev: ChatMessage[] = [
      { role: "system", content: "static" },
      { role: "system", content: "session A" },
    ];
    const curr: ChatMessage[] = [
      { role: "system", content: "static" },
      { role: "system", content: "session B" },
    ];
    const diag = comparePromptPrefixes(prev, curr);
    assert.strictEqual(diag.changedSegment, "session");
    assert.ok(diag.firstDiffByte !== null);
  });

  it("measures prefix sizes correctly", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "static text" },
      { role: "system", content: "session text" },
      { role: "user", content: "dynamic" },
    ];
    const diag = comparePromptPrefixes(undefined, msgs);
    assert.strictEqual(diag.staticPrefixChars, 11); // "static text"
    assert.strictEqual(diag.sessionPrefixChars, 12);
    assert.strictEqual(diag.dynamicSuffixChars, 7);
  });
});

describe("logTurnDebug", () => {
  const ctx: TurnDebugContext = {
    sessionId: "s1",
    turn: 1,
    messages: [{ role: "user", content: "hi" }],
    toolResults: [],
    usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
  };

  it("never rejects when the debug write fails (callers fire it without awaiting)", async () => {
    const root = mkdtempSync(join(tmpdir(), "cost-debug-"));
    const prev = process.env.XDG_DATA_HOME;
    // A regular file where the data directory should be: mkdir fails with ENOTDIR.
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "x");
    process.env.XDG_DATA_HOME = blocker;
    try {
      await assert.doesNotReject(logTurnDebug(ctx));
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes to the directory resolved when the write started, even if XDG_DATA_HOME changes meanwhile", async () => {
    const root = mkdtempSync(join(tmpdir(), "cost-debug-"));
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = root;
    try {
      const pending = logTurnDebug(ctx);
      process.env.XDG_DATA_HOME = join(root, "elsewhere-never-created");
      await pending;
      const line = readFileSync(join(root, "autopilot", "cost-debug.jsonl"), "utf8").trim();
      assert.strictEqual(JSON.parse(line).sessionId, "s1");
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("turn outcome and provider resolution labels", () => {
  function withDataHome(run: (root: string) => Promise<void>): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "cost-debug-"));
    const prev = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = root;
    return run(root).finally(() => {
      if (prev === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prev;
      rmSync(root, { recursive: true, force: true });
    });
  }

  const readEntries = (root: string): Record<string, unknown>[] =>
    readFileSync(join(root, "autopilot", "cost-debug.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);

  it("logTurnOutcome writes the once-per-turn outcome label", () =>
    withDataHome(async (root) => {
      await logTurnOutcome({ sessionId: "s1", turn: 3, outcome: "completed", durationMs: 1234 });
      await logTurnOutcome({ sessionId: "s1", turn: 4, outcome: "guardrail", detail: "loop_stall" });
      const [completed, guardrail] = readEntries(root);
      assert.equal(completed!.kind, "turn-outcome");
      assert.equal(completed!.outcome, "completed");
      assert.equal(completed!.durationMs, 1234);
      assert.equal(guardrail!.outcome, "guardrail");
      assert.equal(guardrail!.outcomeDetail, "loop_stall");
    }));

  it("logProviderResolution writes a generationId-joined provider row", () =>
    withDataHome(async (root) => {
      await logProviderResolution({ sessionId: "s1", generationId: "gen-123", provider: "PrimeIntellect", costUsd: 0.012, latencyMs: 4200 });
      const [row] = readEntries(root);
      assert.equal(row!.kind, "provider-resolution");
      assert.equal(row!.generationId, "gen-123");
      assert.equal(row!.provider, "PrimeIntellect");
      assert.equal(row!.costUsd, 0.012);
      assert.equal(row!.latencyMs, 4200);
    }));

  it("logTurnDebug carries requestIds so rows join to the request log", () =>
    withDataHome(async (root) => {
      await logTurnDebug({
        sessionId: "s1",
        turn: 1,
        messages: [{ role: "user", content: "hi" }],
        toolResults: [],
        usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        requestIds: ["req-a", "req-b"],
      });
      const [row] = readEntries(root);
      assert.deepEqual(row!.requestIds, ["req-a", "req-b"]);
    }));
});
