import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bedrockAuth, converseUrl, parseConverseStream, signSigV4, toConverseRequest } from "./bedrock.js";
import { isProviderUsable, resolveActiveProvider } from "./resolve.js";
import { runKimi, type KimiEvent } from "../agent/client.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import type { ChatMessage, ReasoningDetail } from "../agent/messages.js";
import { registerProviderModels } from "../models/registry.js";
import { mapModelsDevProvider } from "../models/provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "../models/models-dev-snapshot.js";

/** Encode one AWS event-stream frame (CRCs zeroed; the parser relies on TLS). */
function frame(headers: Record<string, string>, payload: unknown): Uint8Array {
  const enc = new TextEncoder();
  const hparts: number[] = [];
  for (const [k, v] of Object.entries(headers)) {
    const kb = enc.encode(k);
    const vb = enc.encode(v);
    hparts.push(kb.length, ...kb, 7, (vb.length >> 8) & 255, vb.length & 255, ...vb);
  }
  const body = enc.encode(JSON.stringify(payload));
  const total = 12 + hparts.length + body.length + 4;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, total);
  view.setUint32(4, hparts.length);
  out.set(hparts, 12);
  out.set(body, 12 + hparts.length);
  return out;
}
const ev = (type: string, payload: unknown) => frame({ ":message-type": "event", ":event-type": type, ":content-type": "application/json" }, payload);
function stream(frames: Uint8Array[], chunk = 7): ReadableStream<Uint8Array> {
  const all = new Uint8Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) {
    all.set(f, o);
    o += f.length;
  }
  return new ReadableStream({
    start(c) {
      for (let i = 0; i < all.length; i += chunk) c.enqueue(all.slice(i, i + chunk));
      c.close();
    },
  });
}

const FRAMES = [
  ev("messageStart", { role: "assistant" }),
  ev("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { text: "check the file" } } }),
  ev("contentBlockDelta", { contentBlockIndex: 0, delta: { reasoningContent: { signature: "sig-bedrock" } } }),
  ev("contentBlockStop", { contentBlockIndex: 0 }),
  ev("contentBlockDelta", { contentBlockIndex: 1, delta: { text: "Reading." } }),
  ev("contentBlockStart", { contentBlockIndex: 2, start: { toolUse: { toolUseId: "tooluse_1", name: "read" } } }),
  ev("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '{"path":' } } }),
  ev("contentBlockDelta", { contentBlockIndex: 2, delta: { toolUse: { input: '"a"}' } } }),
  ev("contentBlockStop", { contentBlockIndex: 2 }),
  ev("messageStop", { stopReason: "tool_use" }),
  ev("metadata", { usage: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 800, cacheWriteInputTokens: 50 } }),
];

describe("ConverseStream parsing", () => {
  it("decodes event-stream frames split across chunks into text, signed reasoning, tool calls and usage", async () => {
    const events: KimiEvent[] = [];
    for await (const e of parseConverseStream(stream(FRAMES))) events.push(e);
    assert.strictEqual(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""), "Reading.");
    assert.strictEqual(events.filter((e) => e.type === "reasoning").map((e) => (e as { delta: string }).delta).join(""), "check the file");
    const details = events.filter((e) => e.type === "reasoning_details").flatMap((e) => (e as { details: ReasoningDetail[] }).details);
    assert.deepStrictEqual(details, [{ type: "bedrock.reasoning", index: 0, text: "check the file", signature: "sig-bedrock" }]);
    const call = events.find((e) => e.type === "tool_call_complete") as Extract<KimiEvent, { type: "tool_call_complete" }>;
    assert.deepStrictEqual([call.id, call.name, call.arguments, call.finishReason], ["tooluse_1", "read", '{"path":"a"}', "tool_calls"]);
    assert.deepStrictEqual((events.at(-1) as Extract<KimiEvent, { type: "done" }>).usage, {
      prompt_tokens: 950,
      completion_tokens: 20,
      total_tokens: 970,
      prompt_tokens_details: { cached_tokens: 800, cache_write_tokens: 50 },
    });
  });

  it("turns exceptions into API errors (throttling as 429)", async () => {
    const exc = frame({ ":message-type": "exception", ":exception-type": "throttlingException" }, { message: "Too many requests" });
    await assert.rejects(async () => {
      for await (const _ of parseConverseStream(stream([exc]))) {
        /* drain */
      }
    }, (e: Error & { httpStatus?: number }) => /throttlingException: Too many requests/.test(e.message) && e.httpStatus === 429);
  });
});

describe("Converse requests", () => {
  const history: ChatMessage[] = [
    { role: "system", content: "rules" },
    { role: "user", content: "read a" },
    {
      role: "assistant",
      content: "",
      reasoning_details: [{ type: "bedrock.reasoning", index: 0, text: "check", signature: "sig" }],
      tool_calls: [{ id: "call:1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", tool_call_id: "call:1", content: "contents" },
  ];
  const tools = [{ type: "function" as const, function: { name: "read", description: "Read", parameters: { type: "object" } } }];

  it("maps history, tools, thinking and cache points for Claude", () => {
    const body = toConverseRequest({ model: "global.anthropic.claude-sonnet-5-5", messages: history, tools, maxTokens: 4000, reasoningEffort: "medium", supportsReasoning: true, supportsTemperature: true });
    assert.deepStrictEqual(body.system, [{ text: "rules" }, { cachePoint: { type: "default" } }]);
    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    assert.deepStrictEqual(msgs[1]!.content, [
      { reasoningContent: { reasoningText: { text: "check", signature: "sig" } } },
      { toolUse: { toolUseId: "call_1", name: "read", input: { path: "a" } } },
    ]);
    assert.deepStrictEqual(msgs[2]!.content, [{ toolResult: { toolUseId: "call_1", content: [{ text: "contents" }] } }, { cachePoint: { type: "default" } }]);
    assert.deepStrictEqual(body.additionalModelRequestFields, { thinking: { type: "enabled", budget_tokens: 16_000 } });
    assert.ok((body.inferenceConfig as { maxTokens: number }).maxTokens > 16_000);
    assert.ok(!("temperature" in (body.inferenceConfig as object)));
    const toolConfig = body.toolConfig as { tools: unknown[]; toolChoice: unknown };
    assert.deepStrictEqual(toolConfig.tools[0], { toolSpec: { name: "read", description: "Read", inputSchema: { json: { type: "object" } } } });
  });

  it("adds no cache points for non-Anthropic models", () => {
    const body = toConverseRequest({ model: "amazon.nova-2-lite-v1:0", messages: history, maxTokens: 100, supportsReasoning: false, supportsTemperature: true });
    assert.deepStrictEqual(body.system, [{ text: "rules" }]);
    assert.strictEqual((body.inferenceConfig as { temperature: number }).temperature, 0.2);
  });

  it("encodes the model id in the path and signs the double-encoded canonical URI", () => {
    const url = converseUrl("https://bedrock-runtime.us-west-2.amazonaws.com", "amazon.nova-2-lite-v1:0");
    assert.strictEqual(url, "https://bedrock-runtime.us-west-2.amazonaws.com/model/amazon.nova-2-lite-v1%3A0/converse-stream");
    const creds = { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY", sessionToken: "tok" };
    const now = new Date("2026-10-20T12:00:00Z");
    const a = signSigV4({ method: "POST", url, body: "{}", region: "us-west-2", credentials: creds, now });
    const b = signSigV4({ method: "POST", url, body: "{}", region: "us-west-2", credentials: creds, now });
    assert.deepStrictEqual(a, b, "deterministic");
    assert.match(a.Authorization!, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261020\/us-west-2\/bedrock\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/);
    assert.strictEqual(a["x-amz-date"], "20261020T120000Z");
    assert.strictEqual(a["x-amz-security-token"], "tok");
    const changed = signSigV4({ method: "POST", url, body: "{ }", region: "us-west-2", credentials: creds, now });
    assert.notStrictEqual(changed.Authorization, a.Authorization, "the body is signed");
  });
});

describe("Bedrock credentials and requests", () => {
  const ENV = ["AWS_BEARER_TOKEN_BEDROCK", "AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN", "AWS_PROFILE", "AWS_SHARED_CREDENTIALS_FILE", "AWS_REGION", "AWS_DEFAULT_REGION", "AUTOPILOT_PROVIDER"];
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  let dir: string;
  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "bedrock-test-"));
  });
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
    process.env.AWS_SHARED_CREDENTIALS_FILE = join(dir, "none");
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("finds a Bedrock API key, env keys, or a profile in the shared credentials file", async () => {
    assert.strictEqual(bedrockAuth({ AWS_SHARED_CREDENTIALS_FILE: join(dir, "none") }), undefined);
    assert.deepStrictEqual(bedrockAuth({ AWS_BEARER_TOKEN_BEDROCK: "bk" }), { bearer: "bk" });
    const file = join(dir, "credentials");
    await writeFile(file, "[default]\naws_access_key_id = AKIA1\naws_secret_access_key = s1\n\n[work]\naws_access_key_id=AKIA2\naws_secret_access_key=s2\naws_session_token=t2\n");
    assert.deepStrictEqual(bedrockAuth({ AWS_SHARED_CREDENTIALS_FILE: file, AWS_PROFILE: "work" }), { credentials: { accessKeyId: "AKIA2", secretAccessKey: "s2", sessionToken: "t2" } });
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "bedrock" }, {})), false);
  });

  it("streams a turn from the region's endpoint with SigV4 headers", async () => {
    process.env.AWS_ACCESS_KEY_ID = "AKIA1";
    process.env.AWS_SECRET_ACCESS_KEY = "secret";
    registerProviderModels("bedrock", mapModelsDevProvider(MODELS_DEV_SNAPSHOT["amazon-bedrock"]!));
    let seen: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return new Response(stream([ev("contentBlockDelta", { contentBlockIndex: 0, delta: { text: "Hi" } }), ev("messageStop", { stopReason: "end_turn" })]), {
        status: 200,
        headers: { "content-type": "application/vnd.amazon.eventstream" },
      });
    }) as typeof fetch;
    const auth = llmAuthFromConfig({ provider: "bedrock", providers: { bedrock: { region: "eu-west-1" } } });
    const events: KimiEvent[] = [];
    for await (const e of runKimi({ ...auth, model: "global.anthropic.claude-sonnet-5-5", messages: [{ role: "user", content: "hi" }] })) events.push(e);
    assert.strictEqual(seen!.url, "https://bedrock-runtime.eu-west-1.amazonaws.com/model/global.anthropic.claude-sonnet-5-5/converse-stream");
    assert.match(seen!.headers.get("authorization")!, /^AWS4-HMAC-SHA256 Credential=AKIA1\/\d{8}\/eu-west-1\/bedrock\/aws4_request/);
    assert.ok(seen!.headers.get("x-amz-content-sha256"));
    assert.ok(!("model" in seen!.body) && Array.isArray(seen!.body.messages));
    assert.strictEqual(events.filter((e) => e.type === "text").map((e) => (e as { delta: string }).delta).join(""), "Hi");
  });
});

describe("SigV4 against AWS's published test vector", () => {
  it("get-vanilla", () => {
    const h = signSigV4({
      method: "GET",
      url: "https://example.amazonaws.com/",
      body: "",
      region: "us-east-1",
      service: "service",
      credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" },
      now: new Date("2015-08-30T12:36:00Z"),
      contentSha: false,
    });
    assert.strictEqual(
      h.Authorization,
      "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa31553b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31",
    );
  });
});
