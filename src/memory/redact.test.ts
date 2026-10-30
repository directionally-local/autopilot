import { describe, it } from "node:test";
import assert from "node:assert";
import { redactSecrets } from "./redact.js";

describe("redactSecrets", () => {
  it("redacts AWS access keys", () => {
    assert.strictEqual(redactSecrets("key AKIAABCDEFGHIJKLMNOP"), "key [REDACTED_AWS_KEY]");
  });

  it("redacts GitHub tokens", () => {
    const token = "ghp_" + "a".repeat(36);
    assert.strictEqual(redactSecrets(`token ${token}`), "token [REDACTED_GH_TOKEN]");
  });

  it("redacts sk- keys", () => {
    const key = "sk-" + "a".repeat(48);
    assert.strictEqual(redactSecrets(`key ${key}`), "key [REDACTED_SK_KEY]");
  });

  it("redacts long hex strings", () => {
    const hex = "a".repeat(40);
    assert.strictEqual(redactSecrets(`hash ${hex}`), "hash [REDACTED_HEX_KEY]");
  });

  it("leaves ordinary text alone", () => {
    assert.strictEqual(redactSecrets("The build uses tsup."), "The build uses tsup.");
  });
});
