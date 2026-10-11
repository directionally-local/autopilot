import { describe, it } from "node:test";
import assert from "node:assert";
import { isSecretConfigKey, redactConfig, redactDeep, redactLight } from "./redact.js";

describe("redactLight", () => {
  it("keeps the key name and masks the value for key=value and key: value", () => {
    assert.strictEqual(redactLight("API_KEY=abc123"), "API_KEY=<redacted>");
    assert.strictEqual(redactLight("api-key: hunter2"), "api-key: <redacted>");
    assert.strictEqual(redactLight("password = s3cret!"), "password = <redacted>");
    assert.strictEqual(redactLight("secret:topsecret"), "secret:<redacted>");
    assert.strictEqual(redactLight("Authorization: Basic Zm9v"), "Authorization: <redacted>");
    assert.strictEqual(redactLight("export TOKEN=xyz && echo ok"), "export TOKEN=<redacted> && echo ok");
    assert.strictEqual(redactLight("MY_SECRET=foo GITHUB_TOKEN=bar"), "MY_SECRET=<redacted> GITHUB_TOKEN=<redacted>");
  });

  it("handles JSON-quoted keys", () => {
    assert.strictEqual(redactLight('{"api_key": "sk-123", "model": "m"}'), '{"api_key": "<redacted>", "model": "m"}');
  });

  it("masks PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----";
    assert.strictEqual(redactLight(`before\n${pem}\nafter`), "before\n<redacted-key>\nafter");
    const plain = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    assert.strictEqual(redactLight(plain), "<redacted-key>");
  });

  it("masks OpenRouter keys, GitHub tokens, and bearer headers", () => {
    assert.strictEqual(redactLight("key sk-or-v1-abcDEF0123456789 here"), "key <redacted> here");
    assert.strictEqual(redactLight("ghp_ABCdef0123456789"), "<redacted>");
    assert.strictEqual(redactLight("github_pat_11ABC_def0123"), "<redacted>");
    assert.strictEqual(redactLight("Bearer eyJhbGciOi.JIUzI1NiJ9.sig-nature_x"), "<redacted>");
    assert.strictEqual(redactLight("curl -H 'Authorization: Basic dXNlcjpwYXNz'"), "curl -H 'Authorization: <redacted>'");
  });

  it("leaves ordinary code and prose untouched", () => {
    const code = [
      "export function sum(a: number, b: number): number {",
      "  return a + b;",
      "}",
      "const total_tokens = usage.prompt_tokens + usage.completion_tokens;",
      "const maxTokens = 4096;",
      "// see https://example.com/docs?page=2",
      "git commit -m \"feat: add thing\"",
    ].join("\n");
    assert.strictEqual(redactLight(code), code);
    assert.strictEqual(redactLight(""), "");
  });
});

describe("redactConfig", () => {
  it("replaces credential-bearing keys at any depth and keeps the rest", () => {
    const cfg = {
      openrouterApiKey: "sk-or-v1-abc",
      requestyApiKey: "rq",
      apiKey: "broker",
      apiToken: "cf",
      accountId: "acct",
      model: "moonshotai/kimi-k2.6",
      permissions: { bash: { "*": "allow" } },
      mcpServers: { gh: { env: { GITHUB_TOKEN: "ghp_x", PATH: "/usr/bin" } } },
      emptyToken: "",
      nullSecret: null,
    };
    const out = redactConfig(cfg) as Record<string, unknown>;
    assert.strictEqual(out.openrouterApiKey, "<redacted>");
    assert.strictEqual(out.requestyApiKey, "<redacted>");
    assert.strictEqual(out.apiKey, "<redacted>");
    assert.strictEqual(out.apiToken, "<redacted>");
    assert.strictEqual(out.accountId, "acct");
    assert.strictEqual(out.model, "moonshotai/kimi-k2.6");
    assert.deepStrictEqual(out.permissions, { bash: { "*": "allow" } });
    assert.deepStrictEqual(out.mcpServers, { gh: { env: { GITHUB_TOKEN: "<redacted>", PATH: "/usr/bin" } } });
    assert.strictEqual(out.emptyToken, "");
    assert.strictEqual(out.nullSecret, null);
    // The input is not mutated.
    assert.strictEqual(cfg.openrouterApiKey, "sk-or-v1-abc");
  });

  it("isSecretConfigKey matches by case-insensitive suffix", () => {
    assert.ok(isSecretConfigKey("openrouterApiKey"));
    assert.ok(isSecretConfigKey("apiKey"));
    assert.ok(isSecretConfigKey("apiToken"));
    assert.ok(isSecretConfigKey("GITHUB_TOKEN"));
    assert.ok(!isSecretConfigKey("model"));
    assert.ok(!isSecretConfigKey("maxTokens"));
  });
});

describe("redactDeep", () => {
  it("applies redactLight to string leaves without touching keys or structure", () => {
    const out = redactDeep({
      token: "keep-the-key",
      text: "Authorization: Bearer abc.def",
      nested: ["ghp_xyz", 42, null, { api_key: "x", note: "api_key=y" }],
    });
    assert.deepStrictEqual(out, {
      token: "keep-the-key",
      text: "Authorization: <redacted>",
      nested: ["<redacted>", 42, null, { api_key: "x", note: "api_key=<redacted>" }],
    });
  });
});
