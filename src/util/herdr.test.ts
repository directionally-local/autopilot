import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  HerdrReporter,
  cliArgs,
  cliSend,
  detectHerdr,
  getHerdrReporter,
  resetHerdrForTesting,
  resumeArgv,
  socketSend,
  summaryToken,
  syncHerdrFromTui,
  type HerdrSend,
  type HerdrTuiSnapshot,
} from "./herdr.js";
import { resetExitForTesting, runShutdownTasks } from "./exit.js";

interface Req {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

/** A fake herdr server: records each newline-delimited request and answers ok. */
async function fakeHerdrSocket(dir: string): Promise<{ path: string; requests: Req[]; close: () => Promise<void> }> {
  const path = join(dir, "herdr.sock");
  const requests: Req[] = [];
  const server: Server = createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const req = JSON.parse(buf.slice(0, nl)) as Req;
        buf = buf.slice(nl + 1);
        requests.push(req);
        conn.write(`${JSON.stringify({ id: req.id, result: { type: "ok" } })}\n`);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return { path, requests, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const HERDR_VARS = ["HERDR_ENV", "HERDR_PANE_ID", "HERDR_SOCKET_PATH", "HERDR_BIN_PATH", "AUTOPILOT_HERDR_PANE"] as const;

function snapshot(over: Partial<HerdrTuiSnapshot> = {}): HerdrTuiSnapshot {
  return { turnRunning: false, sessionId: null, permissionTool: null, awaitingChoice: false, currentTask: () => undefined, ...over };
}

describe("herdr reporting", () => {
  let dir: string;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ap-herdr-"));
    for (const k of HERDR_VARS) saved[k] = process.env[k];
    for (const k of HERDR_VARS) delete process.env[k];
    resetHerdrForTesting();
    resetExitForTesting();
  });

  afterEach(() => {
    for (const k of HERDR_VARS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    resetHerdrForTesting();
    resetExitForTesting();
    rmSync(dir, { recursive: true, force: true });
  });

  it("does nothing outside herdr", async () => {
    assert.equal(detectHerdr({}), null);
    assert.equal(detectHerdr({ HERDR_PANE_ID: "w1:p1" }), null, "needs a socket or binary");
    assert.equal(detectHerdr({ HERDR_SOCKET_PATH: "/x.sock" }), null, "needs a pane");
    assert.equal(detectHerdr({ HERDR_ENV: "0", HERDR_PANE_ID: "w1:p1", HERDR_SOCKET_PATH: "/x.sock" }), null);
    assert.deepEqual(detectHerdr({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_BIN_PATH: "/bin/herdr" }), {
      paneId: "w1:p1",
      socketPath: undefined,
      binPath: "/bin/herdr",
    });

    assert.equal(getHerdrReporter(), null);
    // A TUI render outside herdr touches nothing and registers no shutdown work.
    let read = false;
    syncHerdrFromTui(snapshot({ turnRunning: true, currentTask: () => ((read = true), "task") }));
    assert.equal(read, false);
    await runShutdownTasks();
  });

  it("reports each TUI transition over the socket with rising seq and the resume command", async () => {
    const sock = await fakeHerdrSocket(dir);
    try {
      let clock = 1_000;
      const reporter = new HerdrReporter({ env: { paneId: "w1:p2", socketPath: sock.path }, send: socketSend(sock.path, 2000), now: () => clock });
      const step = async (s: Partial<HerdrTuiSnapshot>) => {
        syncHerdrFromTui(snapshot(s), reporter);
        await reporter.idle();
      };

      await step({}); // startup, ready
      await step({}); // re-render: no duplicate report
      await step({ turnRunning: true, sessionId: "abc-123", currentTask: () => "Fix the login bug\nmore detail" });
      await step({ turnRunning: true, sessionId: "abc-123", permissionTool: "bash" });
      await step({ turnRunning: true, sessionId: "abc-123" });
      await step({ turnRunning: false, sessionId: "abc-123", awaitingChoice: true });
      clock = 500; // a clock step back must not lower seq
      await step({ turnRunning: false, sessionId: "abc-123" });
      await reporter.release();

      const states = sock.requests.filter((r) => r.method === "pane.report_agent").map((r) => [r.params.state, r.params.message ?? null]);
      assert.deepEqual(states, [
        ["idle", null],
        ["working", null],
        ["blocked", "Waiting for permission: bash"],
        ["working", null],
        ["blocked", "Waiting for a choice"],
        ["idle", null],
      ]);

      for (const r of sock.requests) {
        assert.equal(r.params.pane_id, "w1:p2");
        assert.equal(r.params.source, "autopilot");
      }
      const seqs = sock.requests.map((r) => r.params.seq as number);
      assert.equal(seqs[0], 1_000_000);
      for (let i = 1; i < seqs.length; i++) assert.ok(seqs[i]! > seqs[i - 1]!, `seq rises: ${seqs.join(",")}`);

      const first = sock.requests[0]!;
      assert.equal(first.params.agent, "autopilot");
      assert.deepEqual(first.params.resume_argv, ["autopilot", "--continue"]);
      assert.equal(first.params.agent_session_id, undefined);
      const working = sock.requests.find((r) => r.params.state === "working")!;
      assert.deepEqual(working.params.resume_argv, ["autopilot", "--session", "abc-123"]);
      assert.equal(working.params.agent_session_id, "abc-123");

      const meta = sock.requests.filter((r) => r.method === "pane.report_metadata").map((r) => r.params.tokens);
      assert.deepEqual(meta, [{ summary: "Fix the login bug" }, { summary: null }]);

      const last = sock.requests.at(-1)!;
      assert.equal(last.method, "pane.release_agent");
      assert.equal(last.params.agent, "autopilot");

      // Nothing after release.
      const count = sock.requests.length;
      reporter.report("working");
      await reporter.idle();
      assert.equal(sock.requests.length, count);
    } finally {
      await sock.close();
    }
  });

  it("releases the pane on exit through the shutdown tasks", async () => {
    const sock = await fakeHerdrSocket(dir);
    try {
      process.env.HERDR_ENV = "1";
      process.env.HERDR_PANE_ID = "w2:p1";
      process.env.HERDR_SOCKET_PATH = sock.path;
      const reporter = getHerdrReporter();
      assert.ok(reporter);
      reporter.report("working", { sessionId: "s1" });
      assert.equal(process.env.AUTOPILOT_HERDR_PANE, "w2:p1", "children inherit the claim");
      await runShutdownTasks();
      assert.deepEqual(
        sock.requests.map((r) => r.method),
        ["pane.report_agent", "pane.release_agent"],
      );

      // An Autopilot started inside this one (same pane) stays silent.
      resetHerdrForTesting();
      assert.equal(getHerdrReporter(), null);
    } finally {
      await sock.close();
    }
  });

  it("falls back to the herdr CLI when there is no socket", async () => {
    const log = join(dir, "argv.log");
    const bin = join(dir, "herdr");
    writeFileSync(bin, `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + "\\n");\n`);
    chmodSync(bin, 0o755);

    const reporter = new HerdrReporter({ env: { paneId: "w1:p3", binPath: bin }, send: cliSend(bin, 5000), now: () => 2 });
    reporter.setSummary("Ship the release");
    await reporter.idle();
    reporter.report("working", { sessionId: "s-9" });
    await reporter.idle();
    reporter.report("blocked", { sessionId: "s-9", message: "Waiting for permission: edit" });
    await reporter.idle();
    await reporter.release();

    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    assert.deepEqual(calls, [
      ["pane", "report-metadata", "w1:p3", "--source", "autopilot", "--seq", "2000", "--token", "summary=Ship the release"],
      ["pane", "report-agent", "w1:p3", "--source", "autopilot", "--agent", "autopilot", "--state", "working", "--seq", "2001", "--agent-session-id", "s-9", "--", "autopilot", "--session", "s-9"],
      ["pane", "report-agent", "w1:p3", "--source", "autopilot", "--agent", "autopilot", "--state", "blocked", "--seq", "2002", "--message", "Waiting for permission: edit", "--agent-session-id", "s-9", "--", "autopilot", "--session", "s-9"],
      ["pane", "report-metadata", "w1:p3", "--source", "autopilot", "--seq", "2003", "--clear-token", "summary"],
      ["pane", "release-agent", "w1:p3", "--source", "autopilot", "--agent", "autopilot", "--seq", "2004"],
    ]);
  });

  it("sends only the latest state when reports pile up behind a slow call", async () => {
    const sent: string[] = [];
    let unblock!: () => void;
    const gate = new Promise<void>((r) => (unblock = r));
    const send: HerdrSend = async (method, params) => {
      sent.push(`${method}:${String(params.state ?? "")}`);
      if (sent.length === 1) await gate;
    };
    const reporter = new HerdrReporter({ env: { paneId: "w1:p1", socketPath: "/unused" }, send });
    reporter.report("working");
    reporter.report("blocked", { message: "x" });
    reporter.report("working");
    reporter.report("idle");
    unblock();
    await reporter.idle();
    assert.deepEqual(sent, ["pane.report_agent:working", "pane.report_agent:idle"]);
  });

  it("never throws or blocks when herdr is unreachable", async () => {
    const missing = join(dir, "nope.sock");
    assert.equal(existsSync(missing), false);
    const reporter = new HerdrReporter({ env: { paneId: "w1:p1", socketPath: missing } });
    const started = Date.now();
    reporter.report("working");
    reporter.report("idle");
    await reporter.release();
    assert.ok(Date.now() - started < 2000);

    const failing: HerdrSend = (method) => (method ? Promise.reject(new Error("boom")) : Promise.resolve());
    const r2 = new HerdrReporter({ env: { paneId: "w1:p1", binPath: "/nonexistent/herdr" }, send: failing });
    assert.doesNotThrow(() => r2.report("working"));
    await r2.release();
  });

  it("builds a valid resume command and summary token", () => {
    assert.deepEqual(resumeArgv(undefined), ["autopilot", "--continue"]);
    assert.deepEqual(resumeArgv("2026-11-02_abc"), ["autopilot", "--session", "2026-11-02_abc"]);
    assert.deepEqual(resumeArgv("it's bad"), ["autopilot", "--continue"], "herdr rejects apostrophes");
    assert.equal(summaryToken("\n  first\tline  \nsecond"), "first line");
    assert.equal(summaryToken("x".repeat(200)).length, 80);
    assert.throws(() => cliArgs("pane.unknown", {}));
  });
});
