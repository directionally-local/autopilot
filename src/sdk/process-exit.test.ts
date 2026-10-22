import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

// #893: SDK sessions end (SessionEnd hook) when the host process exits
// without dispose(), without changing whether or how the process exits.

const sessionModule = fileURLToPath(new URL("./session.ts", import.meta.url));
// The child resolves `--import tsx` from its cwd, so it runs from the repo root.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const signalExitModule = createRequire(import.meta.url).resolve("signal-exit");

interface ChildResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
}

describe("SDK process-exit handling (child process)", () => {
  let home = "";
  let cwd = "";
  let marker = "";
  let n = 0;

  before(async () => {
    home = await mkdtemp(join(tmpdir(), "autopilot-sdk-exit-"));
  });

  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  /** A project whose SessionEnd hook appends one line per run to `marker`. */
  async function project(): Promise<void> {
    cwd = join(home, `p${n++}`);
    marker = join(cwd, "session-end.log");
    await mkdir(join(cwd, ".kimiflare"), { recursive: true });
    const hooks = { hooks: { SessionEnd: [{ command: `echo end >> ${JSON.stringify(marker)}` }] } };
    await writeFile(join(cwd, ".kimiflare", "settings.json"), JSON.stringify(hooks));
  }

  const sessionEnds = () => (existsSync(marker) ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length : 0);

  /**
   * Run a host script: it creates a session (`opts` are extra
   * createAgentSession options), runs one turn against a stubbed model,
   * prints "ready", then runs `body`. `onReady` runs in the test once the
   * child is ready (e.g. to signal it).
   */
  function host(opts: string, body: string, onReady?: (pid: number) => void, prelude = ""): Promise<ChildResult> {
    const script = `
      ${prelude}
      import { createAgentSession } from ${JSON.stringify(sessionModule)};
      const { session } = await createAgentSession({
        cwd: ${JSON.stringify(cwd)},
        enableHooks: true,
        config: { completionCheck: false, subagentPolicy: "off" },
        ${opts}
      });
      globalThis.fetch = async () => {
        const events = [
          { choices: [{ delta: { content: "ok" } }] },
          { choices: [{ finish_reason: "stop" }] },
          { choices: [], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
        ];
        const text = events.map((e) => "data: " + JSON.stringify(e) + "\\n\\n").join("") + "data: [DONE]\\n\\n";
        return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
      };
      await session.prompt("hello");
      process.stdout.write("ready\\n");
      ${body}
    `;
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      XDG_CONFIG_HOME: join(home, "config"),
      XDG_DATA_HOME: join(home, "data"),
      // The SessionEnd hook under test lives in the project's settings.
      AUTOPILOT_TRUST_PROJECT: "1",
      OPENROUTER_BASE_URL: "http://127.0.0.1:9/api/v1",
      OPENROUTER_API_KEY: "sk-or-test-exit",
      KIMI_MODEL: "moonshotai/kimi-k2.6",
    };
    delete env.KIMIFLARE_BASE_URL;
    delete env.KIMIFLARE_OTEL_ENDPOINT;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let ready = false;
      const killer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`host did not exit in time (ready: ${ready})\nstdout: ${stdout}\nstderr: ${stderr}`));
      }, 90_000);
      child.stdout.setEncoding("utf8").on("data", (d: string) => {
        stdout += d;
        if (!ready && stdout.includes("ready\n")) {
          ready = true;
          onReady?.(child.pid!);
        }
      });
      child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(killer);
        resolve({ code, signal, stdout, stderr });
      });
    });
  }

  const keepAlive = "setInterval(() => {}, 1000);";
  const diedFrom = (res: ChildResult, signal: NodeJS.Signals, code: number) =>
    assert.ok(res.signal === signal || res.code === code, `expected death by ${signal}: ${JSON.stringify(res)}`);

  it("SIGTERM runs the SessionEnd hook once and the process still dies from the signal (143)", async () => {
    await project();
    const res = await host("", keepAlive, (pid) => process.kill(pid, "SIGTERM"));
    diedFrom(res, "SIGTERM", 143);
    assert.equal(sessionEnds(), 1);
  });

  it("SIGINT is handled the same way (130)", async () => {
    await project();
    const res = await host("", keepAlive, (pid) => process.kill(pid, "SIGINT"));
    diedFrom(res, "SIGINT", 130);
    assert.equal(sessionEnds(), 1);
  });

  it("a host with its own SIGTERM handler keeps control: the SDK neither exits nor re-raises", async () => {
    await project();
    const res = await host(
      "",
      `${keepAlive}
       process.on("SIGTERM", () => {
         process.stdout.write("host handler\\n");
         setTimeout(() => process.exit(7), 1500);
       });`,
      (pid) => process.kill(pid, "SIGTERM"),
    );
    assert.equal(res.signal, null, res.stderr);
    assert.equal(res.code, 7);
    assert.match(res.stdout, /host handler/);
    assert.equal(sessionEnds(), 1);
  });

  it("does not wait forever on signal-exit, which also defers to other listeners", async () => {
    await project();
    const res = await host(
      "",
      keepAlive,
      (pid) => process.kill(pid, "SIGTERM"),
      `import { createRequire } from "node:module";
       const onExit = createRequire(import.meta.url)(${JSON.stringify(signalExitModule)});
       onExit(() => {});`,
    );
    diedFrom(res, "SIGTERM", 143);
    assert.equal(sessionEnds(), 1);
  });

  it("a process that ends on its own runs SessionEnd once (beforeExit) and exits 0", async () => {
    await project();
    const res = await host("", "");
    assert.equal(res.code, 0, res.stderr);
    assert.equal(sessionEnds(), 1);
  });

  it("dispose() then a natural exit runs SessionEnd once", async () => {
    await project();
    const res = await host("", "session.dispose();");
    assert.equal(res.code, 0, res.stderr);
    assert.equal(sessionEnds(), 1);
  });

  it("dispose() then an immediate SIGTERM runs SessionEnd once and still dies from the signal", async () => {
    await project();
    const res = await host("", `${keepAlive} session.dispose(); process.kill(process.pid, "SIGTERM");`);
    diedFrom(res, "SIGTERM", 143);
    assert.equal(sessionEnds(), 1);
  });

  it("dispose() with nothing to wait for, then an immediate SIGTERM, still dies from the signal", async () => {
    // No SessionEnd hook: dispose() settles at once, so the SDK unregisters
    // while the SIGTERM is still pending. Removing the last listener then
    // would drop the signal and leave the process running.
    await project();
    await writeFile(join(cwd, ".kimiflare", "settings.json"), JSON.stringify({ hooks: {} }));
    const res = await host("", `${keepAlive} session.dispose(); process.kill(process.pid, "SIGTERM");`);
    diedFrom(res, "SIGTERM", 143);
  });

  it("removes its handlers once the session's SessionEnd settles after dispose()", async () => {
    await project();
    const events = ["SIGTERM", "SIGINT", "SIGHUP", "beforeExit", "uncaughtExceptionMonitor", "exit"];
    const res = await host(
      "",
      `const counts = () => ${JSON.stringify(events)}.map((e) => process.listenerCount(e)).join(",");
       process.stdout.write("live " + counts() + "\\n");
       session.dispose();
       await new Promise((r) => setTimeout(r, 1000));
       process.stdout.write("disposed " + counts() + "\\n");`,
    );
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /live 1,1,1,1,1,1\n/);
    assert.match(res.stdout, /disposed 0,0,0,0,0,0\n/);
    assert.equal(sessionEnds(), 1);
  });

  it("handleProcessExit: false installs no handlers; SIGTERM kills as before without SessionEnd", async () => {
    await project();
    const events = ["SIGTERM", "SIGINT", "SIGHUP", "beforeExit", "uncaughtExceptionMonitor", "exit"];
    const res = await host(
      "handleProcessExit: false,",
      `${keepAlive}
       process.stdout.write("listeners " + ${JSON.stringify(events)}.map((e) => process.listenerCount(e)).join(",") + "\\n");
       process.kill(process.pid, "SIGTERM");`,
    );
    assert.match(res.stdout, /listeners 0,0,0,0,0,0\n/);
    diedFrom(res, "SIGTERM", 143);
    assert.equal(sessionEnds(), 0);
  });

  it("an uncaught exception still crashes with exit code 1, and SessionEnd is started", async () => {
    await project();
    const res = await host("", `${keepAlive} setTimeout(() => { throw new Error("kaboom"); }, 10);`);
    assert.equal(res.code, 1);
    assert.match(res.stderr, /kaboom/);
    // Best-effort: the hook command was spawned before the process died.
    for (let i = 0; i < 50 && sessionEnds() === 0; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(sessionEnds(), 1);
  });
});
