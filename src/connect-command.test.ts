import { describe, it } from "node:test";
import assert from "node:assert";
import type { KimiConfig } from "./config.js";
import type { ConnectOutcome } from "./camouflage-view.js";
import { runConnectCommand, type ConnectDeps, type ConnectScreens } from "./connect-command.js";
import { CONNECT_EXIT, HIDDEN_WITHOUT_GATEWAY, type ConnectState } from "./providers/connect-state.js";

const env = {} as NodeJS.ProcessEnv;

function outcome(over: Partial<ConnectOutcome> = {}): ConnectOutcome {
  return {
    id: "ollama",
    connection: { id: "ollama", source: "none" },
    model: "qwen3:8b",
    cfg: { provider: "ollama", model: "qwen3:8b" } as KimiConfig,
    ...over,
  };
}

/** A renderer whose screens answer from `answers`; records what was asked. */
function harness(answers: { setup?: ConnectOutcome | null; modelOnly?: ConnectOutcome | null; quit?: boolean } = {}) {
  const calls: string[] = [];
  const excludes: (ReadonlySet<string> | undefined)[] = [];
  const written: { path: string; state: ConnectState }[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const screens: ConnectScreens = {
    connectSetup: async (o = {}) => {
      calls.push("connectSetup");
      excludes.push(o.exclude);
      return answers.setup ?? null;
    },
    pickModelOnly: async () => {
      calls.push("pickModelOnly");
      return answers.modelOnly ?? null;
    },
  };
  const deps: ConnectDeps = {
    // A quit renderer closes before the screens answer: `run` never resolves.
    mount: async (run) => {
      if (answers.quit) return;
      await run(screens);
    },
    writeState: async (path, state) => {
      written.push({ path, state });
    },
    env,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
  };
  return { deps, calls, excludes, written, out, err };
}

describe("autopilot connect", () => {
  it("saves the provider and model and exits 0; no state file without --state-file", async () => {
    const h = harness({ setup: outcome() });
    assert.strictEqual(await runConnectCommand({}, h.deps), CONNECT_EXIT.success);
    assert.deepStrictEqual(h.calls, ["connectSetup"]);
    assert.deepStrictEqual(h.excludes, [undefined], "the full provider list without --state-file");
    assert.deepStrictEqual(h.written, []);
    assert.match(h.out[0]!, /Ollama · qwen3:8b — saved to/);
  });

  it("with --state-file: hides gateway-incompatible providers and writes the contract JSON (null key for a keyless provider)", async () => {
    const h = harness({ setup: outcome() });
    assert.strictEqual(await runConnectCommand({ stateFile: "/tmp/x/state.json" }, h.deps), CONNECT_EXIT.success);
    assert.strictEqual(h.excludes[0], HIDDEN_WITHOUT_GATEWAY);
    assert.deepStrictEqual(h.written, [
      {
        path: "/tmp/x/state.json",
        state: {
          provider: "ollama",
          name: "Ollama",
          baseUrl: "http://127.0.0.1:11434/v1",
          apiKey: null,
          apiKeyEnv: "OLLAMA_API_KEY",
          keyRequired: false,
          model: "qwen3:8b",
          authHeader: "authorization",
          authFormat: "Bearer {key}",
        },
      },
    ]);
  });

  it("passes the verified key and custom URL into the state file, and never prints the key", async () => {
    const h = harness({
      setup: outcome({
        id: "custom",
        connection: { id: "custom", source: "key", key: "sk-secret-123", baseUrl: "http://gw:4000/v1" },
        model: "gpt-x",
        cfg: { provider: "custom", baseUrl: "http://gw:4000/v1", apiKey: "sk-secret-123", model: "gpt-x" } as KimiConfig,
      }),
    });
    assert.strictEqual(await runConnectCommand({ stateFile: "s.json" }, h.deps), CONNECT_EXIT.success);
    assert.strictEqual(h.written[0]!.state.apiKey, "sk-secret-123");
    assert.strictEqual(h.written[0]!.state.baseUrl, "http://gw:4000/v1");
    for (const line of [...h.out, ...h.err]) assert.ok(!line.includes("sk-secret-123"), `key leaked: ${line}`);
  });

  it("--model-only runs only the model picker and writes the active provider's details", async () => {
    const h = harness({
      modelOnly: outcome({
        id: "deepseek",
        connection: { id: "deepseek", source: "config", key: "sk-ds" },
        model: "deepseek-v4-pro",
        cfg: { provider: "deepseek", providers: { deepseek: { apiKey: "sk-ds" } }, model: "deepseek-v4-pro" } as KimiConfig,
      }),
    });
    assert.strictEqual(await runConnectCommand({ modelOnly: true, stateFile: "s.json" }, h.deps), CONNECT_EXIT.success);
    assert.deepStrictEqual(h.calls, ["pickModelOnly"]);
    const state = h.written[0]!.state;
    assert.strictEqual(state.provider, "deepseek");
    assert.strictEqual(state.baseUrl, "https://api.deepseek.com");
    assert.strictEqual(state.apiKey, "sk-ds");
    assert.strictEqual(state.model, "deepseek-v4-pro");
  });

  it("exits 1 when the user backs out, and writes nothing", async () => {
    const h = harness({ setup: null });
    assert.strictEqual(await runConnectCommand({ stateFile: "s.json" }, h.deps), CONNECT_EXIT.cancelled);
    assert.deepStrictEqual(h.written, []);
    assert.match(h.err[0]!, /cancelled — nothing was saved/);
    const m = harness({ modelOnly: null });
    assert.strictEqual(await runConnectCommand({ modelOnly: true }, m.deps), CONNECT_EXIT.cancelled);
    assert.match(m.err[0]!, /no model chosen/);
  });

  it("exits 1 when the renderer is quit before anything was saved", async () => {
    const h = harness({ setup: outcome(), quit: true });
    assert.strictEqual(await runConnectCommand({}, h.deps), CONNECT_EXIT.cancelled);
    assert.deepStrictEqual(h.calls, []);
  });

  it("exits 2 on an empty --state-file path or an unwritable state file", async () => {
    const h = harness({ setup: outcome() });
    assert.strictEqual(await runConnectCommand({ stateFile: "  " }, h.deps), CONNECT_EXIT.usage);
    assert.deepStrictEqual(h.calls, [], "usage errors are reported before any screen opens");
    const failing = harness({ setup: outcome() });
    failing.deps.writeState = async () => {
      throw new Error("EACCES");
    };
    assert.strictEqual(await runConnectCommand({ stateFile: "s.json" }, failing.deps), CONNECT_EXIT.usage);
    assert.match(failing.err[0]!, /couldn't write s.json: EACCES/);
  });

  it("exits 1 when the saved provider has no URL to put in the state file", async () => {
    const h = harness({ setup: outcome({ id: "custom", connection: { id: "custom", source: "none" }, cfg: { provider: "custom" } as KimiConfig }) });
    assert.strictEqual(await runConnectCommand({ stateFile: "s.json" }, h.deps), CONNECT_EXIT.cancelled);
    assert.deepStrictEqual(h.written, []);
    assert.match(h.err[0]!, /no base URL/);
  });
});
