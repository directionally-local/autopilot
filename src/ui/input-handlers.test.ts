import { describe, it } from "node:test";
import assert from "node:assert";
import {
  interruptTurn,
  interruptOrExit,
  type InterruptDeps,
} from "./input-handlers.js";

// Minimal ref factory — matches the React MutableRefObject shape that
// the helpers care about (just `current`).
function ref<T>(initial: T): { current: T } {
  return { current: initial };
}

interface MockDeps extends InterruptDeps {
  events: string[];
  toolUpdates: Array<{ id: string; patch: unknown }>;
  saveCalls: number;
  clearTaskCalls: number;
  exitCalls: number;
  stopAllCalls: number;
}

function makeDeps(overrides: Partial<{
  busy: boolean;
  hasScope: boolean;
  aborting: boolean;
  permission: boolean;
}> = {}): MockDeps {
  const events: string[] = [];
  const toolUpdates: MockDeps["toolUpdates"] = [];
  let saveCalls = 0;
  let clearTaskCalls = 0;
  let exitCalls = 0;
  let stopAllCalls = 0;

  const activeScope = overrides.hasScope
    ? { abort: (_reason: string) => {} } as unknown
    : null;

  const supervisor = { killTurn: () => {} } as unknown;
  const lspManager = {
    stopAll: () => {
      stopAllCalls += 1;
      return Promise.resolve();
    },
  } as unknown;

  const deps = {
    busyRef: ref(overrides.busy ?? false),
    activeScopeRef: ref(activeScope as never),
    isAbortingRef: ref(overrides.aborting ?? false),
    supervisorRef: ref(supervisor as never),
    hasPendingPermission: () => overrides.permission ?? false,
    denyPendingPermission: () => overrides.permission ?? false,
    pendingToolCallsRef: ref(new Map<string, string>([["t1", "bash"]])),
    messagesRef: ref([
      { role: "assistant", content: null, tool_calls: [{ id: "t1", type: "function", function: { name: "bash", arguments: "{}" } }] },
    ]),
    updateTool: (id: string, patch: unknown) => {
      toolUpdates.push({ id, patch });
    },
    setEvents: ((updater: unknown) => {
      if (typeof updater === "function") {
        // record only info events emitted by the helper
        const out = (updater as (e: unknown[]) => unknown[])([]);
        for (const e of out) {
          const ev = e as { kind: string; text?: string };
          if (ev.kind === "info" && ev.text) events.push(ev.text);
        }
      }
    }) as never,
    mkKey: () => "key",
    saveSessionSafe: () => {
      saveCalls += 1;
    },
    clearTaskTracking: () => {
      clearTaskCalls += 1;
    },
    lspManagerRef: ref(lspManager as never),
    exit: () => {
      exitCalls += 1;
    },
  } as unknown as MockDeps;

  Object.defineProperties(deps, {
    events: { value: events, enumerable: false },
    toolUpdates: { value: toolUpdates, enumerable: false },
    saveCalls: { get: () => saveCalls, enumerable: false },
    clearTaskCalls: { get: () => clearTaskCalls, enumerable: false },
    exitCalls: { get: () => exitCalls, enumerable: false },
    stopAllCalls: { get: () => stopAllCalls, enumerable: false },
  });

  return deps;
}

describe("interruptTurn", () => {
  it("gives in-flight tool calls a (stopped) result before the session is saved", () => {
    const deps = makeDeps({ busy: true, hasScope: true });
    let messagesAtSave = -1;
    deps.saveSessionSafe = () => {
      messagesAtSave = deps.messagesRef.current.length;
    };
    const out = interruptTurn(deps);
    assert.strictEqual(out.didInterruptTurn, true);
    assert.strictEqual(messagesAtSave, 2, "the (stopped) result is in history when the save runs");
    const last = deps.messagesRef.current[1]!;
    assert.deepStrictEqual([last.role, last.tool_call_id, last.content, last.name], ["tool", "t1", "(stopped)", "bash"]);
    assert.strictEqual(deps.pendingToolCallsRef.current.size, 0);
  });

  it("also heals history on the SIGINT path that skips the UI tool cleanup", () => {
    const deps = makeDeps({ busy: true, hasScope: true });
    deps.skipPendingToolCleanup = true;
    interruptTurn(deps);
    assert.strictEqual(deps.messagesRef.current.length, 2);
    assert.strictEqual(deps.toolUpdates.length, 0, "UI tool events are left to the abort handler, as before");
  });

  it("is a no-op when idle (no busy, no perm)", () => {
    const deps = makeDeps();
    const out = interruptTurn(deps);
    assert.deepStrictEqual(out, {
      hadPermission: false,
      didInterruptTurn: false,
    });
    assert.strictEqual(deps.events.length, 0);
    assert.strictEqual(deps.saveCalls, 0);
    assert.strictEqual(deps.clearTaskCalls, 0);
  });

  it("denies a pending permission without killing a turn when not busy", () => {
    const deps = makeDeps({ permission: true });
    const out = interruptTurn(deps);
    assert.strictEqual(out.hadPermission, true);
    assert.strictEqual(out.didInterruptTurn, false);
    assert.strictEqual(deps.saveCalls, 0);
  });

  it("kills the turn when busy, has scope, and not aborting", () => {
    const deps = makeDeps({ busy: true, hasScope: true });
    const out = interruptTurn(deps);
    assert.strictEqual(out.didInterruptTurn, true);
    assert.strictEqual(deps.isAbortingRef.current, true);
    assert.deepStrictEqual(deps.events, ["(interrupted)"]);
    assert.strictEqual(deps.saveCalls, 1);
    assert.strictEqual(deps.clearTaskCalls, 1);
    assert.deepStrictEqual(deps.toolUpdates, [{ id: "t1", patch: { status: "cancelled" } }]);
    assert.strictEqual(deps.pendingToolCallsRef.current.size, 0);
  });

  it("does not double-interrupt when already aborting", () => {
    const deps = makeDeps({ busy: true, hasScope: true, aborting: true });
    const out = interruptTurn(deps);
    assert.strictEqual(out.didInterruptTurn, false);
    assert.strictEqual(deps.saveCalls, 0);
    assert.strictEqual(deps.clearTaskCalls, 0);
  });
});

describe("interruptOrExit", () => {
  it("exits when fully idle", () => {
    const deps = makeDeps();
    interruptOrExit(deps);
    assert.strictEqual(deps.stopAllCalls, 1);
  });

  it("does NOT exit when a turn was interrupted", () => {
    const deps = makeDeps({ busy: true, hasScope: true });
    interruptOrExit(deps);
    assert.strictEqual(deps.stopAllCalls, 0);
  });

  it("does NOT exit when a permission was pending", () => {
    const deps = makeDeps({ permission: true });
    interruptOrExit(deps);
    assert.strictEqual(deps.stopAllCalls, 0);
  });
});
