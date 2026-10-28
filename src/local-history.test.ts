import { describe, it, before, after } from "node:test";
import assert from "node:assert";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatHistoryUsage, historyHint, localHistoryUsage } from "./local-history.js";

let root: string;
const savedXdg = process.env.XDG_DATA_HOME;
const savedTraceDir = process.env.KIMIFLARE_TRACE_DIR;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "kimiflare-local-history-"));
  process.env.XDG_DATA_HOME = root;
  delete process.env.KIMIFLARE_TRACE_DIR;
});

after(async () => {
  await rm(root, { recursive: true, force: true });
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  if (savedTraceDir !== undefined) process.env.KIMIFLARE_TRACE_DIR = savedTraceDir;
});

describe("localHistoryUsage", () => {
  it("is empty when nothing has been saved", async () => {
    const usage = await localHistoryUsage();
    assert.strictEqual(usage.totalBytes, 0);
    assert.strictEqual(usage.oldest, null);
    assert.strictEqual(historyHint(usage), null);
  });

  it("counts sessions and traces and hints once over the threshold", async () => {
    const sessions = join(root, "kimiflare", "sessions");
    await mkdir(sessions, { recursive: true });
    await writeFile(join(sessions, "a.json"), "x".repeat(100), "utf8");
    await writeFile(join(sessions, "a.jsonl"), "x".repeat(50), "utf8");
    const trace = join(root, "kimiflare", "traces", "s1");
    await mkdir(join(trace, "blobs"), { recursive: true });
    await writeFile(join(trace, "trace.jsonl"), "y".repeat(200), "utf8");

    const usage = await localHistoryUsage();
    assert.strictEqual(usage.sessionCount, 1);
    assert.strictEqual(usage.sessionBytes, 150);
    assert.strictEqual(usage.traceCount, 1);
    assert.strictEqual(usage.traceBytes, 200);
    assert.strictEqual(usage.totalBytes, 350);
    assert.ok(usage.oldest instanceof Date);

    assert.strictEqual(historyHint(usage, 351), null);
    const hint = historyHint(usage, 350);
    assert.ok(hint?.includes("autopilot history prune --older-than"));
    assert.match(formatHistoryUsage(usage), /total\s+350 B/);
  });
});
