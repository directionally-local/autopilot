import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { checkCopilotAccess, copilotProtocol, copilotRequestHeaders, mapCopilotModels, pollDeviceFlow, startDeviceFlow } from "./copilot.js";
import { runKimi } from "../agent/client.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { registerProviderModels } from "../models/registry.js";
import { costNote } from "../usage-tracker.js";
import { PROVIDER_PRESETS } from "./presets.js";

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const MODELS = [
  { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5", supported_endpoints: ["/v1/messages", "/chat/completions"], capabilities: { limits: { max_context_window_tokens: 200000, max_prompt_tokens: 160000, max_output_tokens: 32000 }, supports: { tool_calls: true, vision: true, max_thinking_budget: 32000 } } },
  { id: "gpt-6.1-sol", supported_endpoints: ["/responses"], capabilities: { limits: { max_prompt_tokens: 400000, max_output_tokens: 128000 }, supports: { tool_calls: true, reasoning_effort: ["low", "medium", "high"] } } },
  { id: "gemini-3.8-flash", supported_endpoints: ["/chat/completions"], capabilities: { limits: { max_prompt_tokens: 1000000, max_output_tokens: 64000 }, supports: { tool_calls: true } } },
  { id: "gpt-5-chat-latest", supported_endpoints: ["/chat/completions"], capabilities: { limits: { max_prompt_tokens: 1, max_output_tokens: 1 }, supports: { tool_calls: true } } },
  { id: "disabled-model", policy: { state: "disabled" }, capabilities: { limits: { max_prompt_tokens: 1, max_output_tokens: 1 }, supports: { tool_calls: true } } },
];

describe("Copilot model list", () => {
  it("picks each model's endpoint and drops disabled models and the chat-only GPT-5 alias", () => {
    const models = mapCopilotModels(MODELS);
    assert.deepStrictEqual(models.map((m) => [m.id, m.protocol]), [
      ["claude-sonnet-5-5", "anthropic-messages"],
      ["gpt-6.1-sol", "openai-responses"],
      ["gemini-3.8-flash", "openai-chat"],
    ]);
    assert.strictEqual(models[0]!.contextWindow, 200000);
    assert.strictEqual(models[0]!.reasoningBudget, true);
    assert.deepStrictEqual(models[1]!.reasoningEfforts, ["low", "medium", "high"]);
    assert.ok(models.every((m) => m.pricing.inputPerMtok === 0), "subscription: no per-token price");
    assert.strictEqual(copilotProtocol(undefined), "openai-chat");
  });
});

describe("copilotRequestHeaders", () => {
  it("marks user-started requests as user and tool-loop follow-ups as agent, and flags images", () => {
    const user = copilotRequestHeaders("tok", { messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "x" } }] }] }, "openai-chat");
    assert.deepStrictEqual(user, {
      Authorization: "Bearer tok",
      "Openai-Intent": "conversation-edits",
      "X-GitHub-Api-Version": "2026-08-01",
      "x-initiator": "user",
      "Copilot-Vision-Request": "true",
    });
    assert.strictEqual(copilotRequestHeaders("tok", { messages: [{ role: "tool", content: "r" }] }, "openai-chat")["x-initiator"], "agent");
    const toolResultOnly = { messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "a", content: "r" }] }] };
    assert.strictEqual(copilotRequestHeaders("tok", toolResultOnly, "anthropic-messages")["x-initiator"], "agent");
    assert.strictEqual(copilotRequestHeaders("tok", { input: [{ role: "user", content: [{ type: "input_text", text: "hi" }] }] }, "openai-responses")["x-initiator"], "user");
  });
});

describe("GitHub device login", () => {
  it("waits through authorization_pending and slow_down, then returns the token", async () => {
    const replies = [json(200, { error: "authorization_pending" }), json(200, { error: "slow_down", interval: 0.001 }), json(200, { access_token: "gho_token" })];
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, body: JSON.parse(String(init?.body)) });
      return url.endsWith("/login/device/code")
        ? json(200, { device_code: "dev-1", user_code: "ABCD-1234", verification_uri: "https://github.com/login/device", interval: 0.001, expires_in: 60 })
        : replies.shift()!;
    }) as unknown as typeof fetch;
    const code = await startDeviceFlow(undefined, fetchImpl);
    assert.strictEqual(code.userCode, "ABCD-1234");
    assert.strictEqual(await pollDeviceFlow(code, undefined, { fetchImpl }), "gho_token");
    assert.strictEqual(calls[0]!.body.scope, "read:user");
    assert.strictEqual(calls.at(-1)!.body.grant_type, "urn:ietf:params:oauth:grant-type:device_code");
  });

  it("uses Enterprise URLs and reports accounts without Copilot chat", async () => {
    let seen = "";
    const noChat = (async (url: string) => {
      seen = url;
      return json(200, { chat_enabled: false });
    }) as unknown as typeof fetch;
    await assert.rejects(checkCopilotAccess("t", "company.ghe.com", noChat), /no GitHub Copilot chat access/);
    assert.strictEqual(seen, "https://api.company.ghe.com/copilot_internal/user");
    const ok = (async () => json(200, { chat_enabled: true, copilot_plan: "business", endpoints: { api: "https://api.business.githubcopilot.com/" } })) as unknown as typeof fetch;
    assert.deepStrictEqual(await checkCopilotAccess("t", undefined, ok), { apiBase: "https://api.business.githubcopilot.com", plan: "business" });
  });
});

describe("Copilot requests", () => {
  const originalFetch = globalThis.fetch;
  const saved = process.env.GITHUB_COPILOT_TOKEN;
  const seen: Array<{ url: string; headers: Headers }> = [];

  before(() => {
    delete process.env.GITHUB_COPILOT_TOKEN;
    registerProviderModels("copilot", mapCopilotModels(MODELS));
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
  });
  after(() => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    if (saved === undefined) delete process.env.GITHUB_COPILOT_TOKEN;
    else process.env.GITHUB_COPILOT_TOKEN = saved;
  });

  it("routes each model to its endpoint with Copilot's headers and the account's API base", async () => {
    const auth = llmAuthFromConfig({ provider: "copilot", providers: { copilot: { apiKey: "gho_token", baseUrl: "https://api.business.githubcopilot.com" } } });
    for (const model of ["claude-sonnet-5-5", "gpt-6.1-sol", "gemini-3.8-flash"]) {
      for await (const _ of runKimi({ ...auth, model, messages: [{ role: "user", content: "hi" }] })) {
        /* drain */
      }
    }
    assert.deepStrictEqual(seen.map((s) => s.url), [
      "https://api.business.githubcopilot.com/v1/messages",
      "https://api.business.githubcopilot.com/responses",
      "https://api.business.githubcopilot.com/chat/completions",
    ]);
    for (const s of seen) {
      assert.strictEqual(s.headers.get("authorization"), "Bearer gho_token");
      assert.strictEqual(s.headers.get("x-initiator"), "user");
      assert.strictEqual(s.headers.get("openai-intent"), "conversation-edits");
      assert.ok(!s.headers.get("x-api-key"));
    }
    assert.strictEqual(seen[0]!.headers.get("anthropic-version"), "2023-06-01");
  });

  it("explains that Copilot is billed by plan", () => {
    assert.match(costNote(PROVIDER_PRESETS.copilot)!, /billed by your plan/);
  });
});
