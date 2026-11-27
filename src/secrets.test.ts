import { describe, it } from "node:test";
import assert from "node:assert";
import { scrubSecrets } from "./secrets.js";
import { scrubToolResultSecrets } from "./agent/secret-scrubber.js";

describe("scrubSecrets — known key shapes", () => {
  it("masks dl key prefixes and keeps the prefix readable", () => {
    const text = "dlk_fakekey_1234567890 dl_ak_fake_1234567890 dl_sk_fake_1234567890";
    assert.strictEqual(scrubSecrets(text), "dlk_**** dl_ak_**** dl_sk_****");
  });

  it("masks sk- keys, including the Anthropic, OpenRouter and project prefixes", () => {
    const text = [
      "sk-ant-api03-abcdefghijklmnop1234567890",
      "sk-or-v1-abcdefghijklmnop1234567890",
      "sk-proj-abcdefghijklmnop1234567890",
      "sk-abcdefghijklmnopqrstuvwx1234",
    ].join(" ");
    assert.strictEqual(
      scrubSecrets(text),
      "sk-ant-**** sk-or-v1-**** sk-proj-**** sk-****",
    );
  });

  it("masks GitHub tokens and AWS access key ids", () => {
    const text = [
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "gho_abcdefghijklmnopqrstuvwxyz0123456789",
      "ghs_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11FAKE_abcdefghijklmnopqrstuvwxyz",
      "AKIAABCDEFGHIJKLMNOP",
    ].join(" ");
    assert.strictEqual(scrubSecrets(text), "ghp_**** gho_**** ghs_**** github_pat_**** AKIA****");
  });

  it("masks Bearer tokens and Authorization headers but keeps the header", () => {
    assert.strictEqual(
      scrubSecrets("Authorization: Bearer abcdef1234567890"),
      "Authorization: Bearer ****",
    );
    assert.strictEqual(scrubSecrets("Bearer abcdef1234567890"), "Bearer ****");
    assert.strictEqual(
      scrubSecrets(`curl -H 'Authorization: Basic dXNlcjpwYXNz'`),
      "curl -H 'Authorization: Basic ****'",
    );
  });
});

describe("scrubSecrets — JSON/YAML/env credential values", () => {
  it("masks quoted API keys, tokens and keys", () => {
    assert.strictEqual(
      scrubSecrets('{"api_key": "fake_api_key_1234567890"}'),
      '{"api_key": "<redacted>"}',
    );
    assert.strictEqual(
      scrubSecrets('{"token": "aB3xK9mQ2pR7sT4vW8yZ1cD6eF0gH5jL"}'),
      '{"token": "<redacted>"}',
    );
    assert.strictEqual(
      scrubSecrets('{"key": "aB3xK9mQ2pR7sT4vW8yZ1cD6eF0gH5jL"}'),
      '{"key": "<redacted>"}',
    );
  });

  it("masks weak key values that are long random tokens, including on their own line", () => {
    const token = "aB3xK9mQ2pR7sT4vW8yZ1cD6eF0gH5jL";
    assert.strictEqual(scrubSecrets(`{"key": "${token}"}`), '{"key": "<redacted>"}');
    const text = ["{", '  "key":', `    "${token}",`, "}"].join("\n");
    const out = scrubSecrets(text);
    assert.ok(!out.includes(token));
    assert.match(out, /"key":\n {4}"<redacted>",/);
  });

  it("masks env and YAML style values", () => {
    assert.strictEqual(scrubSecrets("apiKey=fake_api_key_1234567890"), "apiKey=<redacted>");
    assert.strictEqual(
      scrubSecrets("API_TOKEN=aB3xK9mQ2pR7sT4vW8yZ1cD6eF0gH5jL"),
      "API_TOKEN=<redacted>",
    );
    assert.strictEqual(
      scrubSecrets("api_key:\n  fake_yaml_value_1234567890\n"),
      "api_key:\n  <redacted>\n",
    );
  });

  it("masks unquoted ALL_CAPS env assignments even for weak names", () => {
    assert.strictEqual(scrubSecrets("TOKEN=abc123def456ghi789"), "TOKEN=<redacted>");
    assert.strictEqual(scrubSecrets("GITHUB_TOKEN=abc123def456ghi789"), "GITHUB_TOKEN=<redacted>");
    assert.strictEqual(scrubSecrets("export SECRET=abcdefghij"), "export SECRET=<redacted>");
    assert.strictEqual(scrubSecrets("TOKEN=$SOME_VAR"), "TOKEN=$SOME_VAR");
  });

  it("does not treat quoted code assignments as env assignments", () => {
    const line = 'const KEY = "autopilot.session.v2";';
    assert.strictEqual(scrubSecrets(line), line);
  });

  it("masks pretty-printed JSON whose value is on its own line", () => {
    const text = [
      "{",
      '  "api_key":',
      '    "fake_multiline_value_1234567890",',
      '  "notes": "task-management"',
      "}",
    ].join("\n");
    const out = scrubSecrets(text);
    assert.ok(!out.includes("fake_multiline_value_1234567890"));
    assert.match(out, /"api_key":\n {4}"<redacted>",/);
    assert.ok(out.includes('"notes": "task-management"'));
  });

  it("sees through the read tool's line-number gutter", () => {
    const text = [
      "1\t{",
      '2\t  "api_key":',
      '3\t    "fake_read_value_1234567890",',
      '4\t  "notes": "task-management"',
      "5\t}",
    ].join("\n");
    const out = scrubSecrets(text);
    assert.ok(!out.includes("fake_read_value_1234567890"));
    assert.match(out, /3\t {4}"<redacted>",/);
    assert.ok(out.includes("task-management"));
  });
});

describe("scrubSecrets — exact runtime credentials", () => {
  it("masks a known runtime value even when it matches no key shape", () => {
    const secret = "customRuntime9xQ2Value";
    const text = `the credential is ${secret} and nothing else`;
    const out = scrubToolResultSecrets(text, [secret]);
    assert.ok(!out.includes(secret));
    assert.ok(out.includes("<redacted:runtime secret>"));
  });

  it("masks the provider key passed in from LlmAuth", () => {
    const secret = "plaintext-provider-key-with-no-shape";
    const out = scrubSecrets(`key: ${secret}`, { exactValues: [secret] });
    assert.ok(!out.includes(secret));
  });
});

describe("scrubSecrets — ordinary code and prose stay intact", () => {
  it("ignores hyphenated words, sk-learn and tokenised names", () => {
    const text = [
      "task-management",
      "sk-learn",
      "const maxTokens = 4096;",
      "prompt_tokens + completion_tokens",
    ].join("\n");
    assert.strictEqual(scrubSecrets(text), text);
  });

  it("ignores variables and types that merely use credential-like names", () => {
    const text = [
      "const token = getToken();",
      "const token = value;",
      "const apiKey = process.env.API_KEY;",
      "apiKey: string;",
      '"token": null',
    ].join("\n");
    assert.strictEqual(scrubSecrets(text), text);
  });

  it("leaves React keys, i18n strings, editor grammars and k8s labels alone", () => {
    const text = [
      '<li key="list-item-header">',
      '{ "key": "settings.title" }',
      '"token": "punctuation.definition.string"',
      'keys: "ctrl+shift+p"',
      'const KEY = "autopilot.session.v2";',
      'secret: "my-secret-name-in-k8s"',
    ].join("\n");
    assert.strictEqual(scrubSecrets(text), text);
  });
});
