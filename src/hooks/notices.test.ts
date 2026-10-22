import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { takeHookStartupNotices, exitCodeNoticeText, HOOKS_EXIT_CODE_DOCS_URL } from "./notices.js";
import { legacyGlobalSettingsPath, legacyProjectSettingsPath, projectSettingsPath, globalSettingsPath } from "./settings.js";
import { getRecommendedHook, LEGACY_RECOMMENDED_COMMANDS } from "./recommended.js";

let xdg: string;
let proj: string;
let savedXdg: string | undefined;
let savedTrust: string | undefined;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value), "utf8");
}
const statePath = () => join(xdg, "kimiflare", "state.json");

beforeEach(() => {
  savedXdg = process.env.XDG_CONFIG_HOME;
  xdg = mkdtempSync(join(tmpdir(), "hooks-notice-xdg-"));
  proj = mkdtempSync(join(tmpdir(), "hooks-notice-proj-"));
  process.env.XDG_CONFIG_HOME = xdg;
  // These tests cover hook behaviour, not project trust (project-trust.test.ts),
  // so project settings files are trusted the way a CI run opts in.
  savedTrust = process.env.AUTOPILOT_TRUST_PROJECT;
  process.env.AUTOPILOT_TRUST_PROJECT = "1";
});

afterEach(() => {
  if (savedXdg === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedXdg;
  if (savedTrust === undefined) delete process.env.AUTOPILOT_TRUST_PROJECT;
  else process.env.AUTOPILOT_TRUST_PROJECT = savedTrust;
  rmSync(xdg, { recursive: true, force: true });
  rmSync(proj, { recursive: true, force: true });
});

describe("legacy settings path notice (#887)", () => {
  it("is shown once when hooks live only in a legacy path, naming it and the new path", async () => {
    writeJson(legacyProjectSettingsPath(proj), { hooks: { Stop: [{ command: "printf x" }] } });
    const first = await takeHookStartupNotices(proj);
    const legacy = first.find((n) => n.includes("legacy path"));
    assert.ok(legacy, first.join("\n"));
    assert.ok(legacy.includes(legacyProjectSettingsPath(proj)));
    assert.ok(legacy.includes(projectSettingsPath(proj)));
    assert.deepStrictEqual(await takeHookStartupNotices(proj), [], "second run shows nothing");
    assert.deepStrictEqual(JSON.parse(readFileSync(statePath(), "utf8")).legacyHooksNoticePaths, [legacyProjectSettingsPath(proj)]);
  });

  it("is shown again for a different legacy file (e.g. the global one)", async () => {
    writeJson(legacyProjectSettingsPath(proj), { hooks: { Stop: [{ command: "printf x" }] } });
    await takeHookStartupNotices(proj);
    writeJson(legacyGlobalSettingsPath(), { hooks: { Stop: [{ command: "printf y" }] } });
    const notices = await takeHookStartupNotices(proj);
    assert.strictEqual(notices.length, 1);
    assert.ok(notices[0]!.includes(legacyGlobalSettingsPath()));
    assert.ok(!notices[0]!.includes(legacyProjectSettingsPath(proj)));
  });

  it("is not shown when the autopilot path of the same scope has hooks, or when nothing is configured", async () => {
    assert.deepStrictEqual(await takeHookStartupNotices(proj), []);
    writeJson(legacyGlobalSettingsPath(), { hooks: { Stop: [{ command: "a" }] } });
    writeJson(globalSettingsPath(), { hooks: { Stop: [{ command: "b" }] } });
    assert.deepStrictEqual(await takeHookStartupNotices(proj), []);
  });
});

describe("1.29.0 exit-code notice (#888)", () => {
  it("is shown once to a user with a custom blocking hook, naming hooks that use exit 1", async () => {
    writeJson(projectSettingsPath(proj), {
      hooks: {
        PreToolUse: [
          { id: "old-guard", matcher: "bash", command: "grep -q rm && exit 1; exit 0" },
          { id: "new-guard", matcher: "bash", command: "echo no >&2; exit 2" },
        ],
      },
    });
    const first = await takeHookStartupNotices(proj);
    assert.strictEqual(first.length, 1);
    assert.ok(first[0]!.startsWith("Hooks changed in 1.29.0: only exit 2 blocks; exit 1 now allows. Update custom guards: "));
    assert.ok(first[0]!.includes(HOOKS_EXIT_CODE_DOCS_URL));
    assert.ok(HOOKS_EXIT_CODE_DOCS_URL.endsWith("#blocking-and-exit-codes"));
    assert.ok(first[0]!.includes("old-guard"));
    assert.ok(!first[0]!.includes("new-guard"));
    assert.deepStrictEqual(await takeHookStartupNotices(proj), [], "shown once");
    assert.strictEqual(JSON.parse(readFileSync(statePath(), "utf8")).hooksExitCodeNoticeShown, true);
  });

  it("is not shown with only recommended hooks (current or legacy exit-1 versions)", async () => {
    // (The legacy-path notice may fire here; only the exit-code one matters.)
    const rec = getRecommendedHook("block-env-file-writes")!;
    const [legacyCommand] = [...LEGACY_RECOMMENDED_COMMANDS.keys()];
    assert.match(legacyCommand!, /exit 1/);
    writeJson(projectSettingsPath(proj), { hooks: { PreToolUse: [{ ...rec.hook, enabled: true }] } });
    writeJson(legacyProjectSettingsPath(proj), { hooks: { PreToolUse: [{ id: "legacy-rec", command: legacyCommand }] } });
    const notices = await takeHookStartupNotices(proj);
    assert.ok(!notices.some((n) => n.includes("1.29.0")), notices.join("\n"));
  });

  it("ignores disabled custom hooks and non-blocking events", () => {
    assert.strictEqual(
      exitCodeNoticeText({
        hooks: {
          PreToolUse: [{ id: "off", command: "exit 1", enabled: false }],
          PostToolUse: [{ id: "post", command: "exit 1" }],
          Stop: [{ id: "stop", command: "exit 1" }],
        },
      }),
      null,
    );
    const text = exitCodeNoticeText({ hooks: { UserPromptSubmit: [{ id: "prompt-guard", command: "exit 1" }] } });
    assert.ok(text?.includes("prompt-guard"));
  });

  it("is checked only on the first run: hooks added later do not trigger it", async () => {
    assert.deepStrictEqual(await takeHookStartupNotices(proj), []);
    writeJson(projectSettingsPath(proj), { hooks: { PreToolUse: [{ id: "later", command: "exit 1" }] } });
    assert.deepStrictEqual(await takeHookStartupNotices(proj), []);
  });
});
