import { describe, it, before, after } from "node:test";
import { createNoopRecorder } from "../trace/recorder.js";
import assert from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { startRpcServer } from "./rpc.js";
import type { createAgentSession } from "./session.js";
import type {
  CreateSessionOptions,
  KimiFlareSession,
  PermissionDecision,
  SessionEvent,
} from "./types.js";

type SessionFactory = typeof createAgentSession;

/**
 * In-memory KimiFlareSession double for exercising the RPC loop without
 * network access. `prompt()` can be made to block until `abort()` or
 * `resolvePermission()` is called — exactly the mid-turn situations the
 * RPC loop must keep servicing.
 */
function makeFakeSession(behavior: {
  sessionId?: string;
  /** prompt() emits a permission.request with this id and blocks until it is resolved. */
  permissionRequestId?: string;
  /** The first prompt() blocks until abort() (or dispose()) is called. */
  blockFirstPromptUntilAbort?: boolean;
} = {}) {
  const listeners = new Set<(event: SessionEvent) => void>();
  const permissionWaiters = new Map<string, (d: PermissionDecision) => void>();
  const state = {
    promptCalls: [] as string[],
    decisions: [] as PermissionDecision[],
    promptCallsAtAbort: -1,
  };
  let abortWaiter: (() => void) | null = null;

  function emit(event: SessionEvent): void {
    for (const listener of listeners) listener(event);
  }

  function unblockAll(): void {
    abortWaiter?.();
    abortWaiter = null;
    for (const resolve of permissionWaiters.values()) resolve("deny");
    permissionWaiters.clear();
  }

  const session: KimiFlareSession = {
    sessionId: behavior.sessionId ?? "fake-session",
    cwd: process.cwd(),
    isStreaming: false,
    messages: [],
    trace: createNoopRecorder(),
    async prompt(text) {
      state.promptCalls.push(text);
      if (state.promptCalls.length === 1 && behavior.permissionRequestId !== undefined) {
        const requestId = behavior.permissionRequestId;
        emit({ type: "permission.request", requestId, toolName: "bash", args: {} });
        const decision = await new Promise<PermissionDecision>((resolve) => {
          permissionWaiters.set(requestId, resolve);
        });
        state.decisions.push(decision);
        emit({ type: "permission.resolved", requestId, decision });
        return;
      }
      if (state.promptCalls.length === 1 && behavior.blockFirstPromptUntilAbort) {
        await new Promise<void>((resolve) => {
          abortWaiter = resolve;
        });
      }
    },
    async steer() {},
    async followUp() {},
    async abort() {
      state.promptCallsAtAbort = state.promptCalls.length;
      unblockAll();
    },
    setModel() {},
    setMode() {},
    setReasoningEffort() {},
    resolvePermission(requestId, decision) {
      const waiter = permissionWaiters.get(requestId);
      if (waiter) {
        permissionWaiters.delete(requestId);
        waiter(decision);
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getUsage: () => ({ totalInputTokens: 0, totalOutputTokens: 0, totalCost: 0, turnCount: 0 }),
    getStatus: () => ({
      isStreaming: false,
      isCompacting: false,
      pendingSteer: [],
      pendingFollowUp: [],
      currentMode: "edit",
    }),
    async save() {},
    dispose() {
      unblockAll();
      listeners.clear();
    },
  };

  return { session, state };
}

async function withRpcServer(
  commands: string[],
  handler: (lines: string[]) => void,
  createSession?: SessionFactory,
): Promise<void> {
  const allCommands = [...commands, JSON.stringify({ type: "dispose" })];
  const input = Readable.from(allCommands.map((c) => c + "\n"));
  const outputLines: string[] = [];
  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputLines.push(chunk.toString().trim());
      callback();
    },
  });

  // Start RPC server; it will process all commands and exit on dispose
  await startRpcServer(input, output, createSession);

  // Filter out the dispose ok response
  const filtered = outputLines.filter((l) => {
    try {
      const parsed = JSON.parse(l);
      // Remove only the dispose ok response (no id, type ok)
      return !(parsed.type === "ok" && parsed.id === undefined);
    } catch {
      return true;
    }
  });

  handler(filtered);
}

describe("SDK RPC", () => {
  const ENV = ["OPENROUTER_API_KEY", "OPENROUTER_BASE_URL", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "KIMIFLARE_BASE_URL"] as const;
  const saved: Record<string, string | undefined> = {};
  let configHome = "";

  before(async () => {
    for (const k of ENV) saved[k] = process.env[k];
    delete process.env.KIMIFLARE_BASE_URL;
    configHome = await mkdtemp(join(tmpdir(), "kimiflare-rpc-"));
    process.env.XDG_CONFIG_HOME = configHome;
    // Keep session files out of the developer's real data directory.
    process.env.XDG_DATA_HOME = join(configHome, "data");
    // Unreachable → the catalog load fails fast and uses the seed list.
    process.env.OPENROUTER_BASE_URL = "http://127.0.0.1:9/api/v1";
    process.env.OPENROUTER_API_KEY = "sk-or-test-rpc";
  });

  after(async () => {
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(configHome, { recursive: true, force: true });
  });

  it("responds to new_session command", async () => {
    await withRpcServer(
      [JSON.stringify({ id: "1", type: "new_session" })],
      (lines) => {
        const response = lines.map((l) => JSON.parse(l)).find((r) => r.id === "1");
        assert.ok(response);
        assert.strictEqual(response.type, "ok");
        assert.ok(response.sessionId);
      },
    );
  });

  it("responds to get_state command", async () => {
    await withRpcServer(
      [
        JSON.stringify({ id: "1", type: "new_session" }),
        JSON.stringify({ id: "2", type: "get_state" }),
      ],
      (lines) => {
        const response = lines.map((l) => JSON.parse(l)).find((r) => r.id === "2");
        assert.ok(response);
        assert.strictEqual(response.type, "state");
        assert.strictEqual(typeof response.isStreaming, "boolean");
      },
    );
  });

  it("responds to set_model command", async () => {
    await withRpcServer(
      [
        JSON.stringify({ id: "1", type: "new_session" }),
        JSON.stringify({ id: "2", type: "set_model", modelId: "@cf/moonshotai/kimi-k2.6" }),
      ],
      (lines) => {
        const response = lines.map((l) => JSON.parse(l)).find((r) => r.id === "2");
        assert.ok(response);
        assert.strictEqual(response.type, "ok");
      },
    );
  });

  it("responds to set_mode command", async () => {
    await withRpcServer(
      [
        JSON.stringify({ id: "1", type: "new_session" }),
        JSON.stringify({ id: "2", type: "set_mode", mode: "auto" }),
      ],
      (lines) => {
        const response = lines.map((l) => JSON.parse(l)).find((r) => r.id === "2");
        assert.ok(response);
        assert.strictEqual(response.type, "ok");
      },
    );
  });

  it("responds with error for unknown command", async () => {
    await withRpcServer(
      [JSON.stringify({ id: "1", type: "unknown_command" })],
      (lines) => {
        const response = lines.map((l) => JSON.parse(l)).find((r) => r.id === "1");
        assert.ok(response);
        assert.strictEqual(response.type, "error");
        assert.ok(response.error.includes("Unknown command"));
      },
    );
  });

  it("responds with error for invalid JSON", async () => {
    await withRpcServer(
      ["not valid json"],
      (lines) => {
        const response = lines.map((l) => JSON.parse(l)).find((r) => r.type === "error");
        assert.ok(response);
        assert.strictEqual(response.error, "Invalid JSON");
      },
    );
  });

  it("processes abort while a prompt turn is running", async () => {
    // The first prompt blocks until abort() is called: with the old
    // blocking loop this test would hang forever, because abort was not
    // read off stdin until the turn ended.
    const fake = makeFakeSession({ blockFirstPromptUntilAbort: true });
    await withRpcServer(
      [
        JSON.stringify({ id: "1", type: "new_session" }),
        JSON.stringify({ id: "2", type: "prompt", message: "block until aborted" }),
        JSON.stringify({ id: "3", type: "abort" }),
      ],
      (lines) => {
        const parsed = lines.map((l) => JSON.parse(l));
        const abortIdx = parsed.findIndex((r) => r.id === "3");
        const promptIdx = parsed.findIndex((r) => r.id === "2");
        assert.ok(abortIdx !== -1, "abort got no response");
        assert.ok(promptIdx !== -1, "prompt got no response");
        assert.strictEqual(parsed[abortIdx].type, "ok");
        assert.strictEqual(parsed[promptIdx].type, "ok");
        // abort was serviced mid-turn: its response lands before the
        // prompt's own response, which only settles because abort ran.
        assert.ok(abortIdx < promptIdx, "abort was not processed mid-turn");
        assert.deepStrictEqual(fake.state.promptCalls, ["block until aborted"]);
      },
      async () => ({ session: fake.session }),
    );
  });

  it("resolve_permission unblocks a turn waiting on permission.request", async () => {
    // The prompt blocks on an emitted permission.request until the
    // client answers it — the deadlock case for the old blocking loop.
    const fake = makeFakeSession({ permissionRequestId: "req_0" });
    await withRpcServer(
      [
        JSON.stringify({ id: "1", type: "new_session" }),
        JSON.stringify({ id: "2", type: "prompt", message: "needs permission" }),
        JSON.stringify({ id: "3", type: "resolve_permission", requestId: "req_0", decision: "allow" }),
      ],
      (lines) => {
        const parsed = lines.map((l) => JSON.parse(l));
        assert.ok(
          parsed.some((r) => r.type === "permission.request" && r.requestId === "req_0"),
          "permission.request event was not forwarded",
        );
        const resolveResponse = parsed.find((r) => r.id === "3");
        assert.ok(resolveResponse);
        assert.strictEqual(resolveResponse.type, "ok");
        const promptResponse = parsed.find((r) => r.id === "2");
        assert.ok(promptResponse, "prompt never settled");
        assert.strictEqual(promptResponse.type, "ok");
        assert.deepStrictEqual(fake.state.decisions, ["allow"]);
      },
      async () => ({ session: fake.session }),
    );
  });

  it("queues a second prompt until the running turn ends", async () => {
    const fake = makeFakeSession({ blockFirstPromptUntilAbort: true });
    await withRpcServer(
      [
        JSON.stringify({ id: "1", type: "new_session" }),
        JSON.stringify({ id: "2", type: "prompt", message: "first" }),
        JSON.stringify({ id: "3", type: "prompt", message: "second" }),
        JSON.stringify({ id: "4", type: "abort" }),
      ],
      (lines) => {
        const parsed = lines.map((l) => JSON.parse(l));
        // Only the first prompt had started when abort was serviced —
        // the second was queued, not run concurrently.
        assert.strictEqual(fake.state.promptCallsAtAbort, 1);
        // Both prompts ran (in order) and got their own ok.
        assert.deepStrictEqual(fake.state.promptCalls, ["first", "second"]);
        const firstIdx = parsed.findIndex((r) => r.id === "2");
        const secondIdx = parsed.findIndex((r) => r.id === "3");
        assert.ok(firstIdx !== -1 && secondIdx !== -1);
        assert.strictEqual(parsed[firstIdx].type, "ok");
        assert.strictEqual(parsed[secondIdx].type, "ok");
        assert.ok(firstIdx < secondIdx, "prompt responses arrived out of order");
      },
      async () => ({ session: fake.session }),
    );
  });

  it("forwards sessionId on new_session for resume", async () => {
    let received: CreateSessionOptions | null = null;
    const factory: SessionFactory = async (opts) => {
      received = opts;
      return { session: makeFakeSession({ sessionId: opts.sessionId ?? "fresh" }).session };
    };
    await withRpcServer(
      [JSON.stringify({ id: "1", type: "new_session", sessionId: "sdk-session-resume-me" })],
      (lines) => {
        const response = lines.map((l) => JSON.parse(l)).find((r) => r.id === "1");
        assert.ok(response);
        assert.strictEqual(response.type, "ok");
        assert.strictEqual(response.sessionId, "sdk-session-resume-me");
        assert.ok(received);
        assert.strictEqual(received.sessionId, "sdk-session-resume-me");
      },
      factory,
    );
  });
});

describe("SDK RPC with a custom endpoint only (no OpenRouter key)", () => {
  // Acceptance path for host apps: a container gets KIMIFLARE_BASE_URL +
  // KIMIFLARE_API_KEY pointed at the host's gateway/broker and nothing else —
  // no OpenRouter key. RPC mode must come up fully.
  // Uses the REAL createAgentSession factory so resolveSdkConfig/loadConfig
  // run for real; env + config file are isolated so a developer's own
  // OpenRouter key can't satisfy the credential check.
  const ENV_KEYS = [
    "OPENROUTER_API_KEY",
    "KIMIFLARE_OPENROUTER_KEY",
    "KIMIFLARE_BASE_URL",
    "KIMIFLARE_API_KEY",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
  ] as const;
  const saved: Record<string, string | undefined> = {};
  let configHome: string;

  before(async () => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
    configHome = await mkdtemp(join(tmpdir(), "kimiflare-rpc-custom-endpoint-"));
    process.env.XDG_CONFIG_HOME = configHome;
    process.env.XDG_DATA_HOME = join(configHome, "data");
    process.env.KIMIFLARE_BASE_URL = "https://aig.example.com/v1";
    process.env.KIMIFLARE_API_KEY = "broker-key";
  });

  after(async () => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(configHome, { recursive: true, force: true });
  });

  it("new_session succeeds with only KIMIFLARE_BASE_URL + KIMIFLARE_API_KEY", async () => {
    await withRpcServer(
      [
        JSON.stringify({ id: "1", type: "new_session" }),
        JSON.stringify({ id: "2", type: "get_state" }),
      ],
      (lines) => {
        const parsed = lines.map((l) => JSON.parse(l));
        const newSession = parsed.find((r) => r.id === "1");
        assert.ok(newSession, "new_session got no response");
        assert.strictEqual(newSession.type, "ok");
        assert.ok(newSession.sessionId);
        const state = parsed.find((r) => r.id === "2");
        assert.ok(state, "get_state got no response");
        assert.strictEqual(state.type, "state");
        assert.strictEqual(typeof state.isStreaming, "boolean");
      },
    );
  });

  it("new_session still fails without the custom endpoint vars (missing credentials)", async () => {
    delete process.env.KIMIFLARE_BASE_URL;
    delete process.env.KIMIFLARE_API_KEY;
    try {
      await withRpcServer(
        [JSON.stringify({ id: "1", type: "new_session" })],
        (lines) => {
          const response = lines.map((l) => JSON.parse(l)).find((r) => r.id === "1");
          assert.ok(response);
          assert.strictEqual(response.type, "error");
          assert.match(response.error, /missing credentials/);
        },
      );
    } finally {
      process.env.KIMIFLARE_BASE_URL = "https://aig.example.com/v1";
      process.env.KIMIFLARE_API_KEY = "broker-key";
    }
  });
});
