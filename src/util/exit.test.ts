import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { onShutdown, runShutdownTasks, resetExitForTesting, SHUTDOWN_PHASE } from "./exit.js";

describe("shutdown tasks", () => {
  beforeEach(() => resetExitForTesting());

  it("runs phases in order and each task once", async () => {
    const order: string[] = [];
    onShutdown("flush", () => void order.push("flush"), SHUTDOWN_PHASE.flush);
    onShutdown("a", async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push("a");
    });
    onShutdown("b", () => void order.push("b"));
    await Promise.all([runShutdownTasks(), runShutdownTasks()]);
    await runShutdownTasks();
    assert.deepEqual(order, ["b", "a", "flush"]);
  });

  it("skips unregistered tasks and survives a failing one", async () => {
    const ran: string[] = [];
    const off = onShutdown("gone", () => void ran.push("gone"));
    off();
    onShutdown("boom", () => {
      throw new Error("boom");
    });
    onShutdown("flush", () => void ran.push("flush"), SHUTDOWN_PHASE.flush);
    await runShutdownTasks();
    assert.deepEqual(ran, ["flush"]);
  });

  it("is bounded by the timeout when a task hangs", async () => {
    let flushed = false;
    onShutdown("hang", () => new Promise(() => {}));
    onShutdown("flush", () => void (flushed = true), SHUTDOWN_PHASE.flush);
    const start = Date.now();
    await runShutdownTasks(150);
    assert.ok(Date.now() - start < 1000);
    // The hung phase is cut short so the flush still gets its reserved time.
    assert.equal(flushed, true);
  });
});

describe("exit handlers (child process)", () => {
  const exitModule = fileURLToPath(new URL("./exit.ts", import.meta.url));
  const run = (body: string) =>
    spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { onShutdown, installExitHandlers } from ${JSON.stringify(exitModule)};
      onShutdown("mark", async () => { await new Promise((r) => setTimeout(r, 30)); process.stdout.write("ran\\n"); });
      ${body}
    `], { encoding: "utf8", timeout: 10_000 });

  it("SIGTERM runs the shutdown tasks, then exits 143", () => {
    const res = run(`installExitHandlers(); setInterval(() => {}, 1000); setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);`);
    assert.equal(res.stdout, "ran\n");
    assert.equal(res.status, 143);
  });

  it("a custom exit code is used for signals", () => {
    const res = run(`installExitHandlers({ exitCode: () => 0 }); setInterval(() => {}, 1000); setTimeout(() => process.kill(process.pid, "SIGTERM"), 50);`);
    assert.equal(res.stdout, "ran\n");
    assert.equal(res.status, 0);
  });

  it("an uncaught crash runs the shutdown tasks, prints the error and exits 1", () => {
    const res = run(`installExitHandlers({ crashes: true }); setTimeout(() => { throw new Error("kaboom"); }, 10);`);
    assert.equal(res.stdout, "ran\n");
    assert.match(res.stderr, /kaboom/);
    assert.equal(res.status, 1);
  });

  it("an unhandled rejection is handled the same way", () => {
    const res = run(`installExitHandlers({ crashes: true }); Promise.reject(new Error("nope"));`);
    assert.equal(res.stdout, "ran\n");
    assert.match(res.stderr, /nope/);
    assert.equal(res.status, 1);
  });
});
