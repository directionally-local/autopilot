/**
 * Test isolation: loaded with `--import` before any test module, in the test
 * runner and in every test process it spawns (`npm test`, `npm run test:file`).
 *
 * Each process gets a fresh temporary root, and every home, XDG and Autopilot
 * directory variable points inside it, so no test can read or write the real
 * user's home, config, state, data or cache (for example ~/.claude/settings.json
 * or ~/.local/state/autopilot). Child processes the tests start inherit the same
 * variables. The root is removed when the process exits; set
 * AUTOPILOT_TEST_KEEP_ROOT=1 to keep it for debugging.
 *
 * src/util/app-dirs.ts refuses to resolve a directory in the real home while
 * running tests, so a test that runs without this file fails loudly instead.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = realpathSync(mkdtempSync(join(tmpdir(), "autopilot-test-")));
const dir = (...segments) => {
  const path = join(root, ...segments);
  mkdirSync(path, { recursive: true });
  return path;
};

const home = dir("home");
const env = {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: dir("xdg", "config"),
  XDG_DATA_HOME: dir("xdg", "data"),
  XDG_STATE_HOME: dir("xdg", "state"),
  XDG_CACHE_HOME: dir("xdg", "cache"),
  CLAUDE_CONFIG_DIR: dir("home", ".claude"),
  // The dl server's config would otherwise fall back to /etc/autopilot.
  AUTOPILOT_SERVER_CONFIG: join(root, "etc", "server.json"),
  // Marker read by src/util/app-dirs.ts.
  AUTOPILOT_TEST_ROOT: root,
};
// Autopilot's other path overrides default to folders under the XDG
// directories above. Clear any inherited value (either spelling) so it cannot
// point back at real files and tests see the default layout.
for (const suffix of ["TRACE_DIR", "DUMP_LLM_DIR", "REMOTES_FILE", "ASTER_CONFIG"]) {
  delete process.env[`AUTOPILOT_${suffix}`];
  delete process.env[`KIMIFLARE_${suffix}`];
}
Object.assign(process.env, env);

if (process.env.AUTOPILOT_TEST_KEEP_ROOT !== "1") {
  process.on("exit", () => {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 2 });
    } catch {
      /* best effort */
    }
  });
}
