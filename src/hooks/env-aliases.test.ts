import { describe, it } from "node:test";
import assert from "node:assert";
import { buildHookEnv, runHooks, HOOK_ENV_PAYLOAD_MAX_BYTES } from "./runner.js";
import type { HookPayload } from "./types.js";

const post: HookPayload = {
  event: "PostToolUse",
  session_id: "sess_1",
  cwd: "/tmp/proj",
  tool: "write",
  args: { path: "a.ts", content: "x" },
  tier: "light",
  result: { ok: false, content: "boom", errorCode: "unknown" },
};

describe("AUTOPILOT_HOOK_* env aliases (#887)", () => {
  it("sets every KIMIFLARE_HOOK_* var under AUTOPILOT_HOOK_* with the same value", () => {
    const env = buildHookEnv(post);
    const legacy = Object.keys(env).filter((k) => k.startsWith("KIMIFLARE_HOOK_"));
    assert.ok(legacy.length >= 9, legacy.join(","));
    for (const k of legacy) {
      const alias = `AUTOPILOT_HOOK_${k.slice("KIMIFLARE_HOOK_".length)}`;
      assert.strictEqual(env[alias], env[k], alias);
    }
    assert.strictEqual(env.AUTOPILOT_HOOK_TOOL, "write");
    assert.strictEqual(env.AUTOPILOT_HOOK_PATH, "a.ts");
    assert.strictEqual(env.AUTOPILOT_HOOK_RESULT_OK, "false");
    assert.strictEqual(env.AUTOPILOT_HOOK_RESULT_ERROR_CODE, "unknown");
    assert.strictEqual(env.AUTOPILOT_HOOK_TIER, "light");
    assert.strictEqual(env.AUTOPILOT_HOOK_SESSION_ID, "sess_1");
    assert.ok(env.AUTOPILOT_HOOK_PAYLOAD);
  });

  it("mirrors the omitted-payload marker for large payloads", () => {
    const big: HookPayload = { ...post, args: { path: "a.ts", content: "x".repeat(HOOK_ENV_PAYLOAD_MAX_BYTES + 1) } };
    const env = buildHookEnv(big);
    assert.strictEqual(env.AUTOPILOT_HOOK_PAYLOAD, undefined);
    assert.strictEqual(env.AUTOPILOT_HOOK_PAYLOAD_OMITTED, "1");
    assert.strictEqual(env.AUTOPILOT_HOOK_PAYLOAD_BYTES, env.KIMIFLARE_HOOK_PAYLOAD_BYTES);
  });

  it("a real shell hook sees both names", async () => {
    const outcome = await runHooks(
      "PostToolUse",
      [{ id: "env", command: 'printf "%s|%s" "$AUTOPILOT_HOOK_TOOL" "$KIMIFLARE_HOOK_TOOL"' }],
      { ...post, cwd: process.cwd() },
      "write",
    );
    assert.strictEqual(outcome.outcomes[0]?.stdout, "write|write");
  });
});
