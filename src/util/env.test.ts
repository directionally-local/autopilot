import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import {
  envNames,
  hasEnv,
  legacyEnvVarsUsed,
  onLegacyEnvVar,
  readEnv,
  resetLegacyEnvNotices,
  withEnvAliases,
} from "./env.js";

describe("readEnv (#911)", () => {
  beforeEach(() => resetLegacyEnvNotices());

  it("names the new variable first and the legacy one second", () => {
    assert.deepStrictEqual(envNames("TRACE"), ["AUTOPILOT_TRACE", "KIMIFLARE_TRACE"]);
  });

  it("prefers AUTOPILOT_* over KIMIFLARE_*", () => {
    assert.strictEqual(readEnv("X", { AUTOPILOT_X: "new", KIMIFLARE_X: "old" }), "new");
  });

  it("falls back to KIMIFLARE_* when only the old name is set", () => {
    assert.strictEqual(readEnv("X", { KIMIFLARE_X: "old" }), "old");
  });

  it("returns undefined when neither is set", () => {
    assert.strictEqual(readEnv("X", {}), undefined);
    assert.strictEqual(hasEnv("X", {}), false);
  });

  it("treats a set-but-empty new name as set (same as `??`), leaving empty handling to the call site", () => {
    assert.strictEqual(readEnv("X", { AUTOPILOT_X: "", KIMIFLARE_X: "old" }), "");
    assert.strictEqual(readEnv("X", { KIMIFLARE_X: "" }), "");
    assert.strictEqual(hasEnv("X", { AUTOPILOT_X: "  " }), false);
    assert.strictEqual(hasEnv("X", { KIMIFLARE_X: "v" }), true);
  });

  it("reads process.env by default", () => {
    const prev = { a: process.env.AUTOPILOT_ENV_TEST_PROBE, k: process.env.KIMIFLARE_ENV_TEST_PROBE };
    try {
      delete process.env.AUTOPILOT_ENV_TEST_PROBE;
      process.env.KIMIFLARE_ENV_TEST_PROBE = "old";
      assert.strictEqual(readEnv("ENV_TEST_PROBE"), "old");
      process.env.AUTOPILOT_ENV_TEST_PROBE = "new";
      assert.strictEqual(readEnv("ENV_TEST_PROBE"), "new");
    } finally {
      for (const [k, v] of [["AUTOPILOT_ENV_TEST_PROBE", prev.a], ["KIMIFLARE_ENV_TEST_PROBE", prev.k]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe("legacy-name notice", () => {
  beforeEach(() => resetLegacyEnvNotices());
  afterEach(() => onLegacyEnvVar(undefined));

  it("reports each legacy name once, only when the new name is absent", () => {
    const seen: string[] = [];
    onLegacyEnvVar((legacy, current) => seen.push(`${legacy}->${current}`));
    readEnv("A", { KIMIFLARE_A: "1" });
    readEnv("A", { KIMIFLARE_A: "1" });
    readEnv("B", { AUTOPILOT_B: "1", KIMIFLARE_B: "1" });
    readEnv("C", {});
    assert.deepStrictEqual(seen, ["KIMIFLARE_A->AUTOPILOT_A"]);
    assert.deepStrictEqual(legacyEnvVarsUsed(), ["KIMIFLARE_A"]);
  });

  it("replays names read before the listener registered", () => {
    readEnv("EARLY", { KIMIFLARE_EARLY: "1" });
    const seen: string[] = [];
    onLegacyEnvVar((legacy) => seen.push(legacy));
    assert.deepStrictEqual(seen, ["KIMIFLARE_EARLY"]);
  });
});

describe("withEnvAliases", () => {
  it("gives a child env block both spellings of every variable", () => {
    const env = withEnvAliases({ KIMIFLARE_HOOK_TOOL: "write", AUTOPILOT_RUN_ID: "r1", PATH: "/bin" });
    assert.deepStrictEqual(env, {
      KIMIFLARE_HOOK_TOOL: "write",
      AUTOPILOT_HOOK_TOOL: "write",
      AUTOPILOT_RUN_ID: "r1",
      KIMIFLARE_RUN_ID: "r1",
      PATH: "/bin",
    });
  });

  it("never overwrites a name that was given explicitly", () => {
    const env = withEnvAliases({ KIMIFLARE_X: "old", AUTOPILOT_X: "new" });
    assert.deepStrictEqual(env, { KIMIFLARE_X: "old", AUTOPILOT_X: "new" });
  });
});
