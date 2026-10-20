import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { endSession, endSessions, noteSessionStart, resetSessionLifecycleForTesting } from "./session-lifecycle.js";
import type { HooksManager } from "./manager.js";
import type { HookEvent, HookPayload } from "./types.js";
import { resetExitForTesting, runShutdownTasks, onShutdown, SHUTDOWN_PHASE } from "../util/exit.js";
import {
  enqueueOtelLog,
  initOtelSink,
  resetOtelSinkForTesting,
  setFetchForTesting,
  shutdownOtelSink,
  getOtelQueueSize,
} from "../util/otel-sink.js";

function slowHooks(delayMs: number) {
  const ended: string[] = [];
  const hooks = {
    hasEnabledHooks: (_e: HookEvent) => true,
    fire: async (event: HookEvent, payload: HookPayload) => {
      if (event === "SessionEnd") {
        // unref: the hung-hook case must not keep the test process alive.
        await new Promise((r) => setTimeout(r, delayMs).unref());
        ended.push(String(payload.session_id));
      }
      return { outcomes: [], vetoed: false, vetoReason: "" };
    },
  } as unknown as HooksManager;
  return { hooks, ended };
}

describe("reliable SessionEnd (#877)", () => {
  beforeEach(() => {
    resetSessionLifecycleForTesting();
    resetExitForTesting();
  });

  it("endSessions waits for a SessionEnd fired without awaiting (SDK dispose, /clear)", async () => {
    const { hooks, ended } = slowHooks(40);
    await noteSessionStart({ hooks, sessionId: "a", cwd: "/r", resumed: false });
    void endSession("a", "exit");
    await endSessions("exit");
    assert.deepEqual(ended, ["a"]);
  });

  it("the process shutdown ends every open session before later phases run", async () => {
    const { hooks, ended } = slowHooks(30);
    await noteSessionStart({ hooks, sessionId: "a", cwd: "/r", resumed: false });
    await noteSessionStart({ hooks, sessionId: "b", cwd: "/r", resumed: true });
    let endedAtFlush: string[] = [];
    onShutdown("flush", () => void (endedAtFlush = [...ended]), SHUTDOWN_PHASE.flush);
    await runShutdownTasks();
    assert.deepEqual([...endedAtFlush].sort(), ["a", "b"]);
  });

  it("a hung SessionEnd hook doesn't hold the shutdown past its deadline", async () => {
    const { hooks } = slowHooks(60_000);
    await noteSessionStart({ hooks, sessionId: "a", cwd: "/r", resumed: false });
    const start = Date.now();
    await runShutdownTasks(200);
    assert.ok(Date.now() - start < 1500);
  });
});

describe("shutdownOtelSink", () => {
  afterEach(() => {
    setFetchForTesting(null);
    resetOtelSinkForTesting();
  });

  it("drains entries enqueued while a flush is in flight", async () => {
    resetOtelSinkForTesting();
    initOtelSink({ endpoint: "http://127.0.0.1:4318" });
    let posts = 0;
    setFetchForTesting(async () => {
      posts++;
      await new Promise((r) => setTimeout(r, 20));
      return new Response("{}", { status: 200 });
    });
    const entry = { ts: new Date().toISOString(), level: "info" as const, event: "x" };
    enqueueOtelLog(entry);
    void shutdownOtelSink();
    enqueueOtelLog(entry);
    await shutdownOtelSink();
    assert.equal(getOtelQueueSize(), 0);
    assert.equal(posts, 2);
  });
});
