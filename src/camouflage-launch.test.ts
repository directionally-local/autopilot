import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import {
  CamouflageCrashed,
  CamouflageUnavailable,
  crashGiveUpMessage,
  diagnoseRenderer,
  formatUnavailable,
  mountFailureReason,
  rendererBlocker,
  runWithCrashRestarts,
  type DiagnoseDeps,
} from "./camouflage-launch.js";

const PKG = join("/opt", "lib", "node_modules", "autopilot-ai", "node_modules", "camouflage-tui");
const BIN = join(PKG, "bin", "camouflage-tui");

function deps(over: Partial<DiagnoseDeps> & { files?: Record<string, string>; executables?: string[] } = {}): DiagnoseDeps {
  const files: Record<string, string> = { [join(PKG, "package.json")]: '{"version":"2.8.1"}', ...over.files };
  const executables = new Set(over.executables ?? []);
  return {
    env: {},
    platform: "linux",
    arch: "x64",
    home: "/home/u",
    packageDir: () => PKG,
    isExecutable: (p) => executables.has(p),
    readFile: (p) => {
      const f = files[p];
      if (f === undefined) throw new Error("ENOENT");
      return f;
    },
    ...over,
  };
}

describe("diagnoseRenderer / rendererBlocker", () => {
  it("is happy when the package's own renderer is there", () => {
    const d = diagnoseRenderer(deps({ executables: [BIN] }));
    assert.equal(d.packageVersion, "2.8.1");
    assert.equal(d.packageBin, BIN);
    assert.equal(d.packageBinExists, true);
    assert.equal(rendererBlocker(d), null);
  });

  it("an empty bin/ on a supported platform is left to the SDK's one-time download", () => {
    const d = diagnoseRenderer(deps());
    assert.equal(d.packageBinExists, false);
    assert.equal(d.prebuilt, true);
    assert.equal(rendererBlocker(d), null);
  });

  it("an empty bin/ on a platform with no prebuilt renderer is blocked up front", () => {
    const d = diagnoseRenderer(deps({ platform: "freebsd", arch: "x64" }));
    assert.equal(d.prebuilt, false);
    assert.match(rendererBlocker(d)!, /no prebuilt renderer for freebsd-x64.*bin\/camouflage-tui/);
  });

  it("a missing package is blocked", () => {
    const d = diagnoseRenderer(deps({ packageDir: () => null }));
    assert.equal(d.packageBin, null);
    assert.match(rendererBlocker(d)!, /not installed/);
  });

  it("checks CAMOUFLAGE_BIN as a path, or as a name on PATH", () => {
    const missing = diagnoseRenderer(deps({ env: { CAMOUFLAGE_BIN: "/nope/camouflage-tui" }, executables: [BIN] }));
    assert.equal(missing.envBinFound, false);
    assert.match(rendererBlocker(missing)!, /CAMOUFLAGE_BIN is set to \/nope\/camouflage-tui/);

    const onPath = diagnoseRenderer(deps({ env: { CAMOUFLAGE_BIN: "camouflage-tui", PATH: "/a:/usr/local/bin" }, executables: ["/usr/local/bin/camouflage-tui"] }));
    assert.equal(onPath.envBinFound, true);
    assert.equal(rendererBlocker(onPath), null);
  });

  it("reads the installer's saved failure", () => {
    const d = diagnoseRenderer(deps({ files: { "/home/u/.camouflage/install-error.txt": "2026-10-20T00:00:00Z\nHTTP 404 from https://x\n" } }));
    assert.equal(d.installErrorPath, "/home/u/.camouflage/install-error.txt");
    assert.match(d.installError!, /HTTP 404/);
  });
});

describe("formatUnavailable", () => {
  it("says what, where, why and how to fix, and points at print mode", () => {
    const d = diagnoseRenderer(deps({ files: { "/home/u/.camouflage/install-error.txt": "2026-10-20\nHTTP 404 from https://x" } }));
    const msg = formatUnavailable(d, "the renderer failed to start: boom");
    assert.match(msg, /interactive UI can't start/);
    assert.match(msg, /Why: +the renderer failed to start: boom/);
    assert.match(msg, /Platform: +linux-x64\n/);
    assert.match(msg, /camouflage-tui 2\.8\.1 at /);
    assert.ok(msg.includes(`${BIN} (missing)`));
    assert.match(msg, /last download failed: HTTP 404 from https:\/\/x/);
    assert.ok(msg.includes(`node "${join(PKG, "scripts", "install.js")}"`));
    assert.match(msg, /npm rebuild camouflage-tui/);
    assert.match(msg, /npm install -g autopilot-ai/);
    assert.match(msg, /CAMOUFLAGE_BIN/);
    assert.match(msg, /autopilot -p "\.\.\."/);
  });

  it("flags an unsupported platform and a bad CAMOUFLAGE_BIN", () => {
    const d = diagnoseRenderer(deps({ platform: "linux", arch: "riscv64", env: { CAMOUFLAGE_BIN: "/x/r" } }));
    const err = new CamouflageUnavailable(rendererBlocker(d)!, d);
    assert.match(err.message, /linux-riscv64 \(camouflage-tui ships no prebuilt renderer for it\)/);
    assert.match(err.message, /CAMOUFLAGE_BIN=\/x\/r \(not found or not executable\)/);
    assert.match(err.message, /cargo install --git/);
    assert.equal(err.reason, "CAMOUFLAGE_BIN is set to /x/r, which is not an executable file");
  });
});

describe("runWithCrashRestarts", () => {
  it("returns when the view ends normally", async () => {
    const calls: Array<string | undefined> = [];
    const out = await runWithCrashRestarts(async (id) => {
      calls.push(id);
    });
    assert.deepEqual(out, { gaveUp: false, restarts: 0 });
    assert.deepEqual(calls, [undefined]);
  });

  it("re-mounts on the crashed session, then ends normally", async () => {
    const calls: Array<string | undefined> = [];
    const restarts: number[] = [];
    const out = await runWithCrashRestarts(
      async (id) => {
        calls.push(id);
        if (calls.length === 1) throw new CamouflageCrashed("renderer exited (SIGKILL)", "s1");
      },
      { onRestart: ({ restart }) => restarts.push(restart) },
    );
    assert.deepEqual(out, { gaveUp: false, restarts: 1 });
    assert.deepEqual(calls, [undefined, "s1"]);
    assert.deepEqual(restarts, [1]);
  });

  it("gives up after two re-mounts within a minute, keeping the last known session", async () => {
    let t = 0;
    const calls: Array<string | undefined> = [];
    const out = await runWithCrashRestarts(
      async (id) => {
        calls.push(id);
        t += 5_000;
        // The reopened App may die before it saves anything.
        throw new CamouflageCrashed("renderer exited (SIGKILL)", calls.length === 1 ? "s1" : null);
      },
      { now: () => t },
    );
    assert.equal(out.gaveUp, true);
    assert.deepEqual(calls, [undefined, "s1", "s1"]);
    if (out.gaveUp) {
      assert.equal(out.crashes, 3);
      assert.equal(out.restarts, 2);
      assert.equal(out.sessionId, "s1");
    }
  });

  it("crashes spread over more than a minute keep restarting", async () => {
    let t = 0;
    let n = 0;
    const out = await runWithCrashRestarts(
      async () => {
        n++;
        t += 40_000;
        if (n <= 5) throw new CamouflageCrashed("x", "s");
      },
      { now: () => t },
    );
    assert.deepEqual(out, { gaveUp: false, restarts: 5 });
  });

  it("lets other errors through", async () => {
    await assert.rejects(
      runWithCrashRestarts(async () => {
        throw new CamouflageUnavailable("nope");
      }),
      CamouflageUnavailable,
    );
  });
});

describe("mountFailureReason", () => {
  it("summarises the SDK's failed-repair error and keeps other errors to one line", () => {
    assert.equal(
      mountFailureReason("camouflage: bundled renderer is missing at /x/bin/camouflage-tui; an automatic repair was attempted but failed. Install diagnostics: /h/.camouflage/install-error.txt. EACCES"),
      "the renderer binary is missing and downloading it again failed",
    );
    assert.equal(mountFailureReason("spawn EACCES\nmore"), "the renderer failed to start: spawn EACCES");
  });

  it("lists the first failed download attempt and counts the rest", () => {
    const d = diagnoseRenderer(deps({ files: { "/home/u/.camouflage/install-error.txt": "2026\na1: EACCES; a2: EACCES; a3: HTTP 404" } }));
    assert.match(formatUnavailable(d, "r"), /last download failed: a1: EACCES \(\+2 more attempts\)/);
  });
});

describe("crashGiveUpMessage", () => {
  it("names the saved session and how to resume it", () => {
    const msg = crashGiveUpMessage({ crashes: 3, sessionId: "abc-123" });
    assert.match(msg, /crashed 3 times within 60 seconds/);
    assert.match(msg, /crash-\*\.txt/);
    assert.match(msg, /\/resume/);
    assert.match(msg, /autopilot -S abc-123 -p/);
  });

  it("says nothing was lost when no session started", () => {
    assert.match(crashGiveUpMessage({ crashes: 3, sessionId: null }), /nothing was lost/);
  });
});
