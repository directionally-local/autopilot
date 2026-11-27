import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALL_TOOLS, ToolExecutor, type PermissionAsker } from "./executor.js";

const SECRET = "fake_credential_value_1234567890";
let dir: string;
let file: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "autopilot-secret-scrub-"));
  file = join(dir, "credentials.json");
  writeFileSync(
    file,
    [
      "{",
      '  "api_key":',
      `    "${SECRET}",`,
      '  "notes": "task-management"',
      "}",
      "",
    ].join("\n"),
  );
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const allowAll: PermissionAsker = async () => "allow";

function executor(): ToolExecutor {
  return new ToolExecutor(ALL_TOOLS.filter((tool) => tool.name === "bash" || tool.name === "read"));
}

describe("tool-result secret scrubbing", () => {
  it("scrubs a pretty-printed credentials file printed by bash", async () => {
    const res = await executor().run(
      { id: "b1", name: "bash", arguments: JSON.stringify({ command: `cat ${JSON.stringify(file)}` }) },
      allowAll,
      { cwd: dir },
    );
    assert.strictEqual(res.ok, true);
    assert.ok(!res.content.includes(SECRET), res.content);
    assert.match(res.content, /<redacted>/);
    assert.ok(res.content.includes("task-management"));
  });

  it("scrubs the same file when the read tool adds line numbers", async () => {
    const res = await executor().run(
      { id: "r1", name: "read", arguments: JSON.stringify({ path: file, offset: 1, limit: 20 }) },
      allowAll,
      { cwd: dir },
    );
    assert.strictEqual(res.ok, true);
    assert.ok(!res.content.includes(SECRET), res.content);
    assert.match(res.content, /<redacted>/);
    assert.ok(res.content.includes("task-management"));
  });

  it("masks a provider key the executor was configured with even without a known shape", async () => {
    const runtimeKey = "plainruntimecredentialwithoutshape";
    const res = await executor().run(
      { id: "b2", name: "bash", arguments: JSON.stringify({ command: `printf '%s\\n' ${JSON.stringify(runtimeKey)}` }) },
      allowAll,
      { cwd: dir, llmAuth: { providerId: "custom", customEndpoint: { baseUrl: "https://example.test", apiKey: runtimeKey } } },
    );
    assert.strictEqual(res.ok, true);
    assert.ok(!res.content.includes(runtimeKey), res.content);
    assert.match(res.content, /<redacted:runtime secret>/);
  });
});
