import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { join } from "node:path";
import { blobsDir, defaultTraceRoot, safeSessionSegment, sessionTraceDir, traceFilePath, traceRoot } from "./paths.js";

describe("trace paths", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of ["KIMIFLARE_TRACE_DIR", "XDG_DATA_HOME"]) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("defaults to XDG_DATA_HOME/kimiflare/traces", () => {
    process.env.XDG_DATA_HOME = "/data";
    assert.strictEqual(defaultTraceRoot(), join("/data", "kimiflare", "traces"));
    assert.strictEqual(traceRoot(), join("/data", "kimiflare", "traces"));
  });

  it("prefers the env override, then the configured root", () => {
    process.env.XDG_DATA_HOME = "/data";
    assert.strictEqual(traceRoot("/cfg/root"), "/cfg/root");
    process.env.KIMIFLARE_TRACE_DIR = "/env/root";
    assert.strictEqual(traceRoot("/cfg/root"), "/env/root");
    assert.strictEqual(traceRoot(), "/env/root");
  });

  it("lays out session dir, trace file, and blobs dir", () => {
    const dir = sessionTraceDir("2026-10-11T00-00-00-000Z_say-hi", "/r");
    assert.strictEqual(dir, join("/r", "2026-10-11T00-00-00-000Z_say-hi"));
    assert.strictEqual(traceFilePath(dir), join(dir, "trace.jsonl"));
    assert.strictEqual(blobsDir(dir), join(dir, "blobs"));
  });

  it("keeps a session id to one path segment", () => {
    assert.strictEqual(safeSessionSegment("a/b\\c"), "a_b_c");
    assert.strictEqual(safeSessionSegment(".."), "_");
    assert.strictEqual(safeSessionSegment(""), "session");
  });
});
