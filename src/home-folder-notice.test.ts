import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { homeFolderNotice, homeFolderNoticeOnce, resetHomeFolderNotice } from "./home-folder-notice.js";

describe("home folder notice", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "home-notice-")));
  const home = join(root, "home");
  const project = join(home, "code", "app");
  mkdirSync(project, { recursive: true });
  const link = join(root, "home-link");
  symlinkSync(home, link);
  beforeEach(() => resetHomeFolderNotice());

  it("names dl under dl, Autopilot otherwise", () => {
    assert.strictEqual(
      homeFolderNotice({ cwd: home, home, env: { AUTOPILOT_LAUNCHED_BY: "dl" } }),
      "You're in your home folder. dl works best inside a project: cd into one and run dl there.",
    );
    assert.strictEqual(
      homeFolderNotice({ cwd: home, home, env: {} }),
      "You're in your home folder. Autopilot works best inside a project: cd into one and run Autopilot there.",
    );
  });

  it("resolves symlinks on both sides, and is silent in any other folder", () => {
    assert.ok(homeFolderNotice({ cwd: link, home, env: {} }));
    assert.ok(homeFolderNotice({ cwd: home, home: link, env: {} }));
    assert.strictEqual(homeFolderNotice({ cwd: project, home, env: {} }), null);
    assert.strictEqual(homeFolderNotice({ cwd: root, home, env: {} }), null);
  });

  it("is shown once per session", () => {
    assert.ok(homeFolderNoticeOnce({ cwd: home, home, env: {} }));
    assert.strictEqual(homeFolderNoticeOnce({ cwd: home, home, env: {} }), null);
  });

  it("a session started elsewhere doesn't use up the once", () => {
    assert.strictEqual(homeFolderNoticeOnce({ cwd: project, home, env: {} }), null);
    assert.ok(homeFolderNoticeOnce({ cwd: home, home, env: {} }));
  });
});
