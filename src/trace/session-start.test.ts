import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectSessionStart, emitSessionStart } from "./session-start.js";
import { createNoopRecorder, createRecorder } from "./recorder.js";
import { sha256Hex } from "./blobs.js";
import type { ToolDef } from "../agent/messages.js";

let repo: string;
let scratch: string;

const TOOLS: ToolDef[] = [
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object" } } },
];

before(async () => {
  scratch = await mkdtemp(join(tmpdir(), "kimiflare-trace-start-"));
  repo = join(scratch, "repo");
  execFileSync("git", ["init", "-q", repo]);
  execFileSync("git", ["-C", repo, "remote", "add", "origin", "https://example.com/org/repo.git"]);
  await writeFile(join(repo, "a.txt"), "a\n", "utf8");
  execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "add", "."]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "-m", "init"]);
});

after(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("collectSessionStart", () => {
  it("records version, repo identity, hashes, and a redacted config", async () => {
    const blobs: string[] = [];
    const payload = await collectSessionStart(
      {
        cwd: repo,
        model: "moonshotai/kimi-k2.6",
        mode: "print",
        config: { openrouterApiKey: "sk-or-v1-secret", model: "moonshotai/kimi-k2.6", codeMode: true },
        tools: TOOLS,
        systemPrompt: "You are Autopilot.",
      },
      (content) => {
        blobs.push(content);
        return sha256Hex(content);
      },
    );
    assert.match(payload.autopilot_version, /^\d+\.\d+\.\d+/);
    assert.strictEqual(payload.cwd, repo);
    assert.strictEqual(payload.repo_remote, "https://example.com/org/repo.git");
    assert.match(payload.repo_head ?? "", /^[0-9a-f]{40}$/);
    assert.strictEqual(payload.model, "moonshotai/kimi-k2.6");
    assert.strictEqual(payload.mode, "print");
    assert.strictEqual(payload.tool_profile, "full");
    assert.deepStrictEqual(payload.config, { openrouterApiKey: "<redacted>", model: "moonshotai/kimi-k2.6", codeMode: true });
    assert.strictEqual(payload.tool_schemas_sha, sha256Hex(JSON.stringify(TOOLS)));
    assert.strictEqual(payload.tools_blob, payload.tool_schemas_sha);
    assert.deepStrictEqual(blobs, [JSON.stringify(TOOLS)]);
    assert.strictEqual(payload.system_prompt_sha, sha256Hex("You are Autopilot."));
    // harness_commit is a sha when running from a checkout, else null.
    assert.ok(payload.harness_commit === null || /^[0-9a-f]{40}$/.test(payload.harness_commit));
  });

  it("yields nulls outside a git repository", async () => {
    const payload = await collectSessionStart(
      { cwd: scratch, model: "m", mode: "sdk", config: null, tools: [], systemPrompt: "" },
      () => null,
    );
    assert.strictEqual(payload.repo_remote, null);
    assert.strictEqual(payload.repo_head, null);
    assert.deepStrictEqual(payload.config, {});
    assert.strictEqual(payload.tools_blob, "");
  });
});

describe("emitSessionStart", () => {
  it("does nothing on a disabled recorder", async () => {
    const rec = createNoopRecorder("x");
    await emitSessionStart(rec, { cwd: repo, model: "m", mode: "tui", config: null, tools: TOOLS, systemPrompt: "p" });
    assert.strictEqual(rec.dir, null);
  });

  it("writes the event and the tools blob on an enabled recorder", async () => {
    const saved = process.env.KIMIFLARE_TRACE_DIR;
    delete process.env.KIMIFLARE_TRACE_DIR;
    try {
      const rec = createRecorder({ enabled: true, sessionId: "start", root: join(scratch, "traces") });
      await emitSessionStart(rec, { cwd: repo, model: "m", mode: "tui", config: null, tools: TOOLS, systemPrompt: "p" });
      const { readFile } = await import("node:fs/promises");
      const lines = (await readFile(join(rec.dir!, "trace.jsonl"), "utf8")).trim().split("\n");
      assert.strictEqual(lines.length, 1);
      const event = JSON.parse(lines[0]!) as { type: string; payload: { tools_blob: string } };
      assert.strictEqual(event.type, "session_start");
      const blob = await readFile(join(rec.dir!, "blobs", event.payload.tools_blob), "utf8");
      assert.strictEqual(blob, JSON.stringify(TOOLS));
    } finally {
      if (saved !== undefined) process.env.KIMIFLARE_TRACE_DIR = saved;
    }
  });
});
