import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { assertAsterWorkspacePath, containsLikelyProviderSecret, createAsterTools, findLikelyProviderSecret, redactLikelySecrets } from "./aster-tools.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Aster workspace tool policy", () => {
  it("rejects parent traversal, absolute paths, symlinks outside, and credential paths", async () => {
    const { root, outside } = await fixture();
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(outside, join(root, "linked"));
    await assert.rejects(assertAsterWorkspacePath(root, "../secret.txt"), /workspace_path_forbidden/);
    await assert.rejects(assertAsterWorkspacePath(root, join(outside, "secret.txt")), /workspace_path_forbidden/);
    await assert.rejects(assertAsterWorkspacePath(root, "linked/secret.txt"), /workspace_path_forbidden/);
    await assert.rejects(assertAsterWorkspacePath(root, ".env"), /workspace_sensitive_path_forbidden/);
    await assert.rejects(assertAsterWorkspacePath(root, ".git/config"), /workspace_sensitive_path_forbidden/);
  });

  it("allows new files only below the workspace and wraps only safe file tools", async () => {
    const { root } = await fixture();
    assert.equal(await assertAsterWorkspacePath(root, "src/new.ts", true), join(root, "src", "new.ts"));
    const tools = createAsterTools(root);
    assert.deepEqual(tools.map((tool) => tool.name), ["read", "write", "edit"]);
  });

  it("says where a patch's key is, never what it is", () => {
    const patch = [
      "diff --git a/src/laptop/connect.test.ts b/src/laptop/connect.test.ts",
      "--- a/src/laptop/connect.test.ts",
      "+++ b/src/laptop/connect.test.ts",
      "@@ -10,3 +10,4 @@",
      " const a = 1;",
      '+const apiKey = "sk-deepseek-1234567890abcdefghij";',
      " const b = 2;",
    ].join("\n");
    assert.deepEqual(findLikelyProviderSecret(patch), { file: "src/laptop/connect.test.ts", line: 11, pattern: "provider key (sk-…)" });
    // A context line is already in the repository the server clones: it isn't the user's change.
    assert.equal(findLikelyProviderSecret(patch.replace("+const apiKey", " const apiKey")), undefined);
    // Text that isn't a diff has no location.
    assert.deepEqual(findLikelyProviderSecret("key: ghp_0123456789abcdefghijklmnop"), { pattern: "GitHub token (ghp_…)" });
    assert.equal(findLikelyProviderSecret("nothing to see here"), undefined);
  });

  it("detects and redacts common provider tokens", () => {
    const input = "do not log sk-or-v1-0123456789abcdefghijklmnop and ghp_0123456789abcdefghijklmnop";
    assert.equal(containsLikelyProviderSecret(input), true);
    assert.equal(redactLikelySecrets(input).includes("sk-or-v1-0123456789abcdefghijklmnop"), false);
    assert.equal(redactLikelySecrets(input).includes("ghp_0123456789abcdefghijklmnop"), false);
    for (const key of [
      "sk-or-v1-0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab",
      "sk-proj-AbC123dEf456GhI789jKl012MnO345pQr678",
      "sk-ant-api03-AbCdEf0123456789GhIjKl_mnOpQr",
      "OPENROUTER_API_KEY=whatever",
    ]) {
      assert.equal(containsLikelyProviderSecret(`here: ${key}`), true, key);
    }
    for (const prose of [
      "I want a task-management-dashboard-for-small-teams and a risk-assessment-framework-for-startups.",
      "Can you ask-the-user-before-deploying-anything-to-production please",
      "desk-or-chair-comparison-for-my-home-office",
      "sk-learn-is-a-python-library-for-machine-learning",
    ]) {
      assert.equal(containsLikelyProviderSecret(prose), false, prose);
      assert.equal(redactLikelySecrets(prose), prose);
    }
  });
});

async function fixture(): Promise<{ root: string; outside: string }> {
  const temp = await realpath(await mkdtemp(join(tmpdir(), "autopilot-aster-tools-")));
  roots.push(temp);
  const root = join(temp, "workspace");
  const outside = join(temp, "outside");
  await mkdir(root);
  await mkdir(outside);
  return { root, outside };
}
