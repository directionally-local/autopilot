import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNoopRecorder, createRecorder } from "./recorder.js";
import { sha256Hex } from "./blobs.js";
import { clearRecentLogs, getRecentLogs } from "../util/logger.js";
import { setLogTurnId } from "../util/log-sink.js";
import type { TraceEvent } from "./types.js";

let root: string;
const savedEnv = process.env.KIMIFLARE_TRACE_DIR;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "kimiflare-trace-recorder-"));
  // The env override would win over the explicit root passed below.
  delete process.env.KIMIFLARE_TRACE_DIR;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  if (savedEnv !== undefined) process.env.KIMIFLARE_TRACE_DIR = savedEnv;
  setLogTurnId(null);
});

beforeEach(() => {
  clearRecentLogs();
  setLogTurnId(null);
});

async function readEvents(dir: string): Promise<TraceEvent[]> {
  const raw = await readFile(join(dir, "trace.jsonl"), "utf8");
  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TraceEvent);
}

describe("createRecorder (enabled)", () => {
  it("appends events in order with increasing seq and the schema fields", async () => {
    const rec = createRecorder({ enabled: true, sessionId: "s1", root });
    assert.strictEqual(rec.enabled, true);
    assert.strictEqual(rec.dir, join(root, "s1"));
    assert.ok(!existsSync(rec.dir!), "nothing on disk before the first emit");

    rec.emit("guardrail", { kind: "loop_recovery", message: "first" }, "turn-1");
    setLogTurnId("ambient-turn");
    rec.emit("completion_check", { probability: 0.2, nudged: false });
    rec.emit("session_end", { reason: "exit" }, null);
    await rec.flush();

    const events = await readEvents(rec.dir!);
    assert.deepStrictEqual(
      events.map((e) => e.seq),
      [0, 1, 2],
    );
    assert.deepStrictEqual(
      events.map((e) => e.type),
      ["guardrail", "completion_check", "session_end"],
    );
    for (const e of events) {
      assert.strictEqual(e.v, 1);
      assert.strictEqual(e.session_id, "s1");
      assert.ok(!Number.isNaN(Date.parse(e.ts)));
    }
    assert.strictEqual(events[0]!.turn_id, "turn-1");
    assert.strictEqual(events[1]!.turn_id, "ambient-turn");
    assert.strictEqual(events[2]!.turn_id, null);
    assert.deepStrictEqual(events[0]!.payload, { kind: "loop_recovery", message: "first" });
  });

  it("stores blobs under blobs/<sha> and redacts secrets in blobs and payloads", async () => {
    const rec = createRecorder({ enabled: true, sessionId: "s2", root });
    const sha = rec.blob("OPENROUTER_API_KEY=sk-or-v1-abc\nplain line");
    assert.ok(sha);
    const stored = await readFile(join(rec.dir!, "blobs", sha!), "utf8");
    assert.strictEqual(stored, "OPENROUTER_API_KEY=<redacted>\nplain line");
    assert.strictEqual(sha, sha256Hex(stored));

    rec.emit("guardrail", { kind: "limit_ceiling", message: "token: abc123 reached" }, null);
    const [event] = await readEvents(rec.dir!);
    assert.deepStrictEqual(event!.payload, { kind: "limit_ceiling", message: "token: <redacted> reached" });
    assert.deepStrictEqual(await readdir(join(rec.dir!, "blobs")), [sha]);
  });

  it("never throws: on a disk error it warns once and disables itself", async () => {
    // Make the session dir path a regular file so mkdir/append fail.
    const blockedRoot = join(root, "blocked");
    await rm(blockedRoot, { recursive: true, force: true });
    await writeFile(blockedRoot, "not a directory", "utf8");
    const rec = createRecorder({ enabled: true, sessionId: "s3", root: blockedRoot });
    assert.doesNotThrow(() => rec.emit("guardrail", { kind: "loop_stopped", message: "x" }, null));
    assert.strictEqual(rec.enabled, false);
    assert.strictEqual(rec.blob("after failure"), null);
    rec.emit("session_end", { reason: "exit" }, null);
    const warnings = getRecentLogs().filter((l) => l.event === "trace:write_failed");
    assert.strictEqual(warnings.length, 1);
  });

  it("stops recording once the session byte cap is reached", async () => {
    const rec = createRecorder({ enabled: true, sessionId: "s4", root, maxSessionBytes: 400 });
    for (let i = 0; i < 10; i++) rec.emit("guardrail", { kind: "loop_recovery", message: `event ${i}` }, null);
    assert.strictEqual(rec.enabled, false);
    const events = await readEvents(rec.dir!);
    assert.ok(events.length >= 1 && events.length < 10, `wrote ${events.length} events`);
    assert.strictEqual(getRecentLogs().filter((l) => l.event === "trace:session_cap").length, 1);
  });
});

describe("createRecorder (disabled)", () => {
  it("writes nothing, creates no directory, and blob() returns null", async () => {
    const rec = createRecorder({ enabled: false, sessionId: "off", root });
    assert.strictEqual(rec.enabled, false);
    assert.strictEqual(rec.dir, null);
    rec.emit("session_start", {
      autopilot_version: "0",
      harness_commit: null,
      cwd: "/",
      model: "m",
      mode: "print",
      config: {},
      tool_profile: "full",
      tool_schemas_sha: "",
      tools_blob: "",
      system_prompt_sha: "",
    });
    assert.strictEqual(rec.blob("anything"), null);
    await rec.flush();
    assert.ok(!existsSync(join(root, "off")));
    assert.strictEqual(createNoopRecorder("x").enabled, false);
  });
});
