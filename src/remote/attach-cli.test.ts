import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ATTACH_EXIT, attachRemote } from "./attach-cli.js";

const MESSAGE = "Your local changes include something that looks like an API key (provider key (sk-…)) at src/laptop/connect.test.ts:12; remove it and retry";

describe("autopilot attach-remote", () => {
  it("exits 3 when the server refuses a patch that holds a key, and prints where", async () => {
    const dir = await mkdtemp(join(tmpdir(), "attach-cli-"));
    try {
      const patchFile = join(dir, "changes.patch");
      await writeFile(patchFile, "diff --git a/x b/x\n");
      const errors: string[] = [];
      let mounted = false;
      const code = await attachRemote(
        { workspace: "default", repo: "me/app", model: "test/model", baseCommit: "b".repeat(40), patchFile },
        {
          env: { AUTOPILOT_REMOTE_URL: "http://127.0.0.1:1", AUTOPILOT_REMOTE_TOKEN: "t" },
          fetch: (async () => Response.json({ error: { code: "patch_contains_secret", message: MESSAGE } }, { status: 400 })) as typeof fetch,
          mount: async () => { mounted = true; },
          err: (text) => { errors.push(text); },
        },
      );
      assert.equal(code, ATTACH_EXIT.patchContainsSecret);
      assert.equal(mounted, false, "the renderer never opens");
      assert.match(errors.join(""), /src\/laptop\/connect\.test\.ts:12/);
      assert.doesNotMatch(errors.join(""), /patch_contains_secret/, "the code doesn't bury the message");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("keeps exit 1 for every other failure", async () => {
    const errors: string[] = [];
    const code = await attachRemote(
      { workspace: "default", repo: "me/app", model: "test/model" },
      {
        env: { AUTOPILOT_REMOTE_URL: "http://127.0.0.1:1", AUTOPILOT_REMOTE_TOKEN: "t" },
        fetch: (async () => Response.json({ error: { code: "model_not_allowed", message: "Select a model from the configured model list" } }, { status: 400 })) as typeof fetch,
        mount: async () => {},
        err: (text) => { errors.push(text); },
      },
    );
    assert.equal(code, ATTACH_EXIT.error);
    assert.match(errors.join(""), /model_not_allowed/);
  });
});
