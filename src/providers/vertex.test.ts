import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { generateKeyPairSync, createVerify } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetVertexToken, vertexAccessToken, vertexBase, vertexHost, vertexTarget } from "./vertex.js";
import { isProviderUsable, resolveActiveProvider } from "./resolve.js";
import { runKimi } from "../agent/client.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { registerProviderModels } from "../models/registry.js";
import { mapModelsDevProvider } from "../models/provider-catalog.js";
import { MODELS_DEV_SNAPSHOT } from "../models/models-dev-snapshot.js";

const ENV = ["GOOGLE_VERTEX_PROJECT", "GOOGLE_CLOUD_PROJECT", "GCP_PROJECT", "GCLOUD_PROJECT", "GOOGLE_VERTEX_LOCATION", "GOOGLE_CLOUD_LOCATION", "VERTEX_LOCATION", "GOOGLE_APPLICATION_CREDENTIALS", "GOOGLE_VERTEX_ACCESS_TOKEN", "CLOUDSDK_CONFIG", "AUTOPILOT_PROVIDER"];

describe("Vertex endpoints", () => {
  it("picks hosts and routes Claude to Anthropic's Messages API, everything else to the OpenAI-compatible endpoint", () => {
    assert.strictEqual(vertexHost("global"), "aiplatform.googleapis.com");
    assert.strictEqual(vertexHost("us-east5"), "us-east5-aiplatform.googleapis.com");
    assert.strictEqual(vertexHost("eu"), "aiplatform.eu.rep.googleapis.com");
    const base = vertexBase("proj", "global");
    assert.deepStrictEqual(vertexTarget(base, "claude-sonnet-5-5@default"), {
      url: "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/publishers/anthropic/models/claude-sonnet-5-5@default:streamRawPredict",
      protocol: "anthropic-messages",
    });
    assert.deepStrictEqual(vertexTarget(base, "gemini-3.8-flash"), {
      url: "https://aiplatform.googleapis.com/v1/projects/proj/locations/global/endpoints/openapi/chat/completions",
      protocol: "openai-chat",
      bodyModel: "google/gemini-3.8-flash",
    });
    assert.strictEqual(vertexTarget(base, "xai/grok-4.7").bodyModel, "xai/grok-4.7");
  });
});

describe("Vertex credentials and requests", () => {
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  const originalFetch = globalThis.fetch;
  let dir: string;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "vertex-test-"));
  });
  beforeEach(() => {
    for (const k of ENV) delete process.env[k];
    process.env.CLOUDSDK_CONFIG = join(dir, "no-gcloud");
    resetVertexToken();
  });
  after(async () => {
    globalThis.fetch = originalFetch;
    registerProviderModels("openrouter", []);
    resetVertexToken();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    await rm(dir, { recursive: true, force: true });
  });

  it("needs a project; location defaults to global", () => {
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "vertex" }, { CLOUDSDK_CONFIG: join(dir, "none") })), false);
    const p = resolveActiveProvider({ provider: "vertex", providers: { vertex: { project: "my-proj" } } }, { CLOUDSDK_CONFIG: join(dir, "none") });
    assert.strictEqual(p.baseUrl, "https://aiplatform.googleapis.com/v1/projects/my-proj/locations/global");
    assert.ok(isProviderUsable(p));
  });

  it("exchanges a signed service-account JWT for a token and caches it", async () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const keyFile = join(dir, "sa.json");
    await writeFile(keyFile, JSON.stringify({ type: "service_account", client_email: "bot@proj.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }), token_uri: "https://oauth2.googleapis.com/token", project_id: "proj" }));
    let assertion = "";
    let calls = 0;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      calls++;
      assertion = new URLSearchParams(String(init?.body)).get("assertion") ?? "";
      return new Response(JSON.stringify({ access_token: "ya29.token", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const env = { GOOGLE_APPLICATION_CREDENTIALS: keyFile };
    assert.strictEqual(await vertexAccessToken(fetchImpl, env), "ya29.token");
    assert.strictEqual(await vertexAccessToken(fetchImpl, env), "ya29.token");
    assert.strictEqual(calls, 1, "cached");
    const [h, p, sig] = assertion.split(".");
    assert.ok(createVerify("RSA-SHA256").update(`${h}.${p}`).verify(publicKey, Buffer.from(sig!, "base64url")), "RS256 signature verifies");
    const claims = JSON.parse(Buffer.from(p!, "base64url").toString());
    assert.strictEqual(claims.iss, "bot@proj.iam.gserviceaccount.com");
    assert.strictEqual(claims.scope, "https://www.googleapis.com/auth/cloud-platform");
  });

  it("uses a gcloud authorized_user refresh token", async () => {
    const file = join(dir, "adc.json");
    await writeFile(file, JSON.stringify({ type: "authorized_user", client_id: "cid", client_secret: "sec", refresh_token: "1//rt" }));
    let body = "";
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      body = String(init?.body);
      return new Response(JSON.stringify({ access_token: "ya29.user", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    assert.strictEqual(await vertexAccessToken(fetchImpl, { GOOGLE_APPLICATION_CREDENTIALS: file }), "ya29.user");
    assert.match(body, /grant_type=refresh_token/);
    assert.match(body, /refresh_token=1%2F%2Frt/);
  });

  it("sends Gemini to the OpenAI-compatible endpoint and Claude to streamRawPredict with a Vertex Messages body", async () => {
    process.env.GOOGLE_VERTEX_ACCESS_TOKEN = "ya29.env";
    registerProviderModels("vertex", mapModelsDevProvider(MODELS_DEV_SNAPSHOT["google-vertex"]!));
    const seen: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return new Response("data: [DONE]\n\n", { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const auth = llmAuthFromConfig({ provider: "vertex", providers: { vertex: { project: "proj", location: "us-east5" } } });
    for (const model of ["gemini-3.8-flash", "claude-sonnet-5-5@default"]) {
      for await (const _ of runKimi({ ...auth, model, messages: [{ role: "system", content: "s" }, { role: "user", content: "hi" }] })) {
        /* drain */
      }
    }
    assert.strictEqual(seen[0]!.url, "https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5/endpoints/openapi/chat/completions");
    assert.strictEqual(seen[0]!.body.model, "google/gemini-3.8-flash");
    assert.strictEqual(seen[1]!.url, "https://us-east5-aiplatform.googleapis.com/v1/projects/proj/locations/us-east5/publishers/anthropic/models/claude-sonnet-5-5@default:streamRawPredict");
    assert.ok(!("model" in seen[1]!.body));
    assert.strictEqual(seen[1]!.body.anthropic_version, "vertex-2023-10-16");
    assert.ok(Array.isArray(seen[1]!.body.system), "Anthropic Messages body");
    for (const s of seen) assert.strictEqual(s.headers.get("authorization"), "Bearer ya29.env");
  });
});
