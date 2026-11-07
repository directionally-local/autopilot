import test from "node:test";
import assert from "node:assert/strict";
import { prepareTurn } from "./pre-turn.js";
import type { AgentTurnOpts } from "./loop.js";
import type { MemoryManager } from "../memory/manager.js";
import type { HybridResult } from "../memory/schema.js";
import { RECALLED_MEMORY_HEADER } from "../memory/recall-inject.js";

function makeOpts(overrides: Partial<AgentTurnOpts> = {}): AgentTurnOpts {
  return {
    model: "gpt-6",
    messages: [
      { role: "system", content: "system prefix" },
      { role: "user", content: "fix the failing login test in src/auth" },
    ],
    tools: [],
    executor: {} as unknown as AgentTurnOpts["executor"],
    cwd: "/tmp/project",
    signal: new AbortController().signal,
    callbacks: {},
    ...overrides,
  } as AgentTurnOpts;
}

function memoryManager(synthesize: (results: HybridResult[]) => Promise<string>): MemoryManager {
  return { synthesizeRecalled: synthesize } as unknown as MemoryManager;
}

const oneResult = [{ content: "db fact" }] as unknown as HybridResult[];

test("recall gate: disabled when no recall or memory manager is configured", async () => {
  const opts = makeOpts();
  const pre = await prepareTurn(opts);
  assert.equal(pre.memoryRecallDebug.attempted, false);
  assert.equal(pre.memoryRecallDebug.injected, false);
  assert.equal(pre.memoryRecallDebug.reason, "disabled");
  assert.equal(pre.memoryRecalledCount, 0);
});

test("recall gate: already-present when a recalled block exists", async () => {
  const opts = makeOpts({
    sessionStartRecall: async () => oneResult,
    memoryManager: memoryManager(async () => "facts"),
  });
  opts.messages.splice(1, 0, { role: "system", content: `${RECALLED_MEMORY_HEADER}\nold` });
  const pre = await prepareTurn(opts);
  assert.equal(pre.memoryRecallDebug.reason, "already-present");
  assert.equal(pre.memoryRecallDebug.attempted, false);
});

test("recall injects once with count and callback", async () => {
  let recalled: number | undefined;
  const opts = makeOpts({
    sessionStartRecall: async () => oneResult,
    memoryManager: memoryManager(async () => "project facts"),
    callbacks: { onMemoryRecalled: (n: number) => (recalled = n) } as unknown as AgentTurnOpts["callbacks"],
  });
  const pre = await prepareTurn(opts);
  assert.equal(pre.memoryRecallDebug.injected, true);
  assert.equal(pre.memoryRecallDebug.reason, undefined);
  assert.equal(pre.memoryRecallDebug.candidates, 1);
  assert.equal(pre.memoryRecalledCount, 1);
  assert.equal(recalled, 1);
  assert.equal(
    opts.messages.filter(
      (m) => m.role === "system" && typeof m.content === "string" && m.content.startsWith(RECALLED_MEMORY_HEADER),
    ).length,
    1,
  );
});

test("recall gate: no-results and synthesis-empty", async () => {
  const noResults = await prepareTurn(
    makeOpts({ sessionStartRecall: async () => [], memoryManager: memoryManager(async () => "x") }),
  );
  assert.equal(noResults.memoryRecallDebug.reason, "no-results");

  const empty = await prepareTurn(
    makeOpts({ sessionStartRecall: async () => oneResult, memoryManager: memoryManager(async () => "") }),
  );
  assert.equal(empty.memoryRecallDebug.reason, "synthesis-empty");
});

test("recall errors are swallowed and recorded as error", async () => {
  const opts = makeOpts({
    sessionStartRecall: async () => {
      throw new Error("sqlite gone");
    },
    memoryManager: memoryManager(async () => "x"),
  });
  const pre = await prepareTurn(opts);
  assert.equal(pre.memoryRecallDebug.reason, "error");
  assert.equal(pre.memoryRecallDebug.injected, false);
});

test("skill routing is skipped for light tier with a short prompt", async () => {
  const skillsDb = new Proxy(
    {},
    {
      get() {
        throw new Error("skillsDb must not be touched");
      },
    },
  );
  const opts = makeOpts({
    messages: [
      { role: "system", content: "p" },
      { role: "user", content: "hi" },
    ],
    intentClassification: { intent: "chat", tier: "light", rawScore: 0, confidence: 1 },
    skillsDb: skillsDb as unknown as AgentTurnOpts["skillsDb"],
    skillRoutingConfig: {},
  });
  const pre = await prepareTurn(opts);
  assert.equal(pre.skillResult, undefined);
});

test("delegationDirective resolves through a promise", async () => {
  const pre = await prepareTurn(makeOpts({ delegationDirective: Promise.resolve("delegate to a worker") }));
  assert.equal(pre.delegationDirective, "delegate to a worker");
});

test("abort propagates out of pre-turn work", async () => {
  const controller = new AbortController();
  const opts = makeOpts({
    signal: controller.signal,
    sessionStartRecall: async () => {
      controller.abort();
      return oneResult;
    },
    memoryManager: memoryManager(async () => {
      await new Promise((r) => setTimeout(r, 50));
      return "facts";
    }),
  });
  await assert.rejects(prepareTurn(opts), (err: unknown) => err instanceof DOMException && err.name === "AbortError");
});

test("lastUserPrompt extracts plain and multipart text", async () => {
  const plain = await prepareTurn(makeOpts());
  assert.equal(plain.lastUserPrompt, "fix the failing login test in src/auth");

  const multipart = await prepareTurn(
    makeOpts({
      messages: [
        { role: "system", content: "p" },
        {
          role: "user",
          content: [
            { type: "text", text: "first" },
            { type: "image_url", image_url: { url: "data:..." } },
            { type: "text", text: "second" },
          ] as never,
        },
      ],
    }),
  );
  assert.equal(multipart.lastUserPrompt, "first second");
});

test("onMetaBanner fires with tier, skills and memory flags", async () => {
  let banner: { intentTier: string; skillsActive: number; memoryRecalled: boolean } | undefined;
  await prepareTurn(
    makeOpts({
      callbacks: { onMetaBanner: (b: { intentTier: string; skillsActive: number; memoryRecalled: boolean }) => (banner = b) } as unknown as AgentTurnOpts["callbacks"],
      sessionStartRecall: async () => oneResult,
      memoryManager: memoryManager(async () => "facts"),
    }),
  );
  assert.deepEqual(banner, { intentTier: "medium", skillsActive: 0, memoryRecalled: true });
});
