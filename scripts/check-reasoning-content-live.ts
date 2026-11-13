/** Opt-in MR-9 canary; never run by npm test. No tokens or response text are logged.
 * AUTOPILOT_DL_FREE_TOKEN='<access token>' npx tsx scripts/check-reasoning-content-live.ts
 */
import assert from "node:assert/strict";
import { stripReasoningEcho } from "../src/agent/client.js";
import type { ChatMessage } from "../src/agent/messages.js";
import { PROVIDER_PRESETS } from "../src/providers/presets.js";
import { dlApiBase } from "../src/providers/dl-endpoint.js";

const token = process.env.AUTOPILOT_DL_FREE_TOKEN?.trim();
if (!token) {
  console.error("BLOCKED: AUTOPILOT_DL_FREE_TOKEN is not set; no authenticated free-tier request was made. Run: AUTOPILOT_DL_FREE_TOKEN='<access token>' npx tsx scripts/check-reasoning-content-live.ts");
  process.exitCode = 2;
} else {
  const model = "deepseek/deepseek-v4.1-flash-1017";
  const endpoint = `${dlApiBase()}/chat/completions`;
  // Do not send a credential to a public plaintext endpoint.
  if (new URL(endpoint).protocol !== "https:") throw new Error("Live probe requires an HTTPS free-tier endpoint.");
  const tools = [{ type: "function", function: {
    name: "probe", description: "Return a fixed probe result", parameters: { type: "object", properties: {}, additionalProperties: false },
  } }];
  const user: ChatMessage = { role: "user", content: "Call probe exactly once, then after its result reply OK." };
  async function request(messages: ChatMessage[], toolChoice: "required" | "none") {
    const response = await fetch(endpoint, {
      method: "POST", signal: AbortSignal.timeout(120_000),
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ model, messages, tools, tool_choice: toolChoice, max_tokens: 4096, stream: false }),
    });
    console.log(JSON.stringify({ phase: toolChoice === "required" ? "capture" : "replay", httpStatus: response.status, model, endpoint }));
    if (!response.ok) throw new Error(`Free-tier request returned HTTP ${response.status}; response body withheld to avoid leaking data.`);
    return await response.json() as { choices?: Array<{ message?: ChatMessage }> };
  }
  try {
    const captured = (await request([user], "required")).choices?.[0]?.message;
    assert.ok(captured?.role === "assistant" && captured.tool_calls?.length, "capture must contain a real assistant tool call");
    const details = captured.reasoning_details;
    const encrypted = details?.some((d) => d.type === "reasoning.encrypted") === true;
    const textless = !details?.some((d) => (typeof d.text === "string" && d.text.length > 0) || (typeof d.summary === "string" && d.summary.length > 0));
    console.log(JSON.stringify({ phase: "capture-shape", encrypted, textless, detailTypes: details?.map((d) => d.type) ?? [], hasReasoningContent: captured.reasoning_content != null }));
    if (!encrypted || !textless) {
      console.error("INCONCLUSIVE: the real tool-call response did not carry encrypted/text-less reasoning_details. No details were fabricated; MR-9 still needs a matching capture.");
      process.exitCode = 2;
    } else {
      // Reproduce details-only persisted history, keeping the actual encrypted blocks.
      // Explicitly report this normalization; it is not evidence of a details-only stream.
      const { reasoning_content: _removed, ...detailsOnly } = captured;
      const replay = stripReasoningEcho([detailsOnly], PROVIDER_PRESETS["directionally-local"].compat)[0]!;
      assert.equal(replay.reasoning_content, "");
      console.log(JSON.stringify({ phase: "replay-shape", reasoningContent: "", encryptedDetailsPreserved: true, removedCapturedReasoningContent: captured.reasoning_content != null }));
      const result = await request([user, replay, ...captured.tool_calls.map((call): ChatMessage => ({ role: "tool", tool_call_id: call.id, content: "probe succeeded" }))], "none");
      assert.equal(result.choices?.[0]?.message?.role, "assistant", "replay must produce an assistant response");
      console.log("PASS: live free-tier DeepSeek accepted empty reasoning_content with a real encrypted tool-call turn.");
    }
  } catch (error) {
    // Never print arbitrary fetch/provider errors, which can contain credentials.
    console.error(error instanceof assert.AssertionError ? `FAIL: ${error.message}` : "FAIL: live free-tier request failed; inspect connectivity, authentication, quota, and HTTP status above. No acceptance claim.");
    process.exitCode = 1;
  }
}
