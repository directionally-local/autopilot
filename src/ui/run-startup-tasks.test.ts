import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cfg } from "../app.js";
import type { ChatEvent } from "./view-types.js";
import { writeState } from "../util/state.js";
import { runStartupTasks } from "./run-startup-tasks.js";

const settle = () => new Promise((r) => setTimeout(r, 500));

/** Run the startup tasks in `cwd` and collect every line they add. */
async function startupLines(cwd: string, cfg: Partial<Cfg>): Promise<ChatEvent[]> {
  const events: ChatEvent[] = [];
  let n = 0;
  const prev = process.cwd();
  process.chdir(cwd);
  try {
    runStartupTasks({
      cfg: cfg as Cfg,
      setCfg: () => undefined,
      setEvents: (update) => {
        const next = typeof update === "function" ? update(events.slice()) : update;
        events.splice(0, events.length, ...next);
      },
      mkKey: () => `k${n++}`,
      memoryManagerRef: { current: null },
      sessionStartRecallRef: { current: null },
      setKimiMdStale: () => undefined,
      customCommandsRef: { current: [] },
      setCustomCommandsVersion: () => undefined,
    });
    await settle();
  } finally {
    process.chdir(prev);
  }
  return events;
}

describe("startup is nearly silent", () => {
  it("says none of the removed notices, even when each would have applied", async () => {
    // Started in the home folder, with another agent's setup and a skill to index, memory on
    // and never disclosed, and the free tier's default-model note queued.
    const home = mkdtempSync(join(tmpdir(), "quiet-start-"));
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      writeFileSync(join(home, "CLAUDE.md"), "# Notes\nUse pnpm.\n");
      writeFileSync(join(home, ".cursorrules"), "be brief\n");
      mkdirSync(join(home, ".agents", "skills"), { recursive: true });
      writeFileSync(join(home, ".agents", "skills", "deploy.md"), "---\nname: deploy\ndescription: deploy the app\n---\n\nRun the deploy script.\n");
      await writeState({ freeDefaultLunaNoticePending: true });
      const lines = await startupLines(home, {
        model: "some/model",
        provider: "custom",
        baseUrl: "http://127.0.0.1:9/v1",
        memoryEnabled: true,
        memoryDisclosureShown: false,
        memoryDbPath: join(home, "memory.db"),
      });
      const text = lines.map((e) => ("text" in e ? e.text : "")).join("\n");
      assert.doesNotMatch(text, /memory is on/i, "memory disclosure");
      assert.doesNotMatch(text, /home folder/i, "home-folder notice");
      assert.doesNotMatch(text, /indexed \d+ skill/i, "skills count");
      assert.doesNotMatch(text, /CLAUDE\.md|cursorrules|setup-import|Using your/i, "setup-import checklist");
      assert.doesNotMatch(text, /GPT-6 Luna|default/i, "free-tier default note");
      assert.doesNotMatch(text, /memory cleanup|memory: indexed/i, "memory bookkeeping");
      assert.deepStrictEqual(lines, [], "nothing at all");
    } finally {
      process.env.HOME = oldHome;
    }
  });

  it("still says what the user's own files got wrong: a command shadowed by a built-in, a skill that doesn't parse", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quiet-start-cmd-"));
    mkdirSync(join(dir, ".autopilot", "commands"), { recursive: true });
    writeFileSync(join(dir, ".autopilot", "commands", "tour.md"), "Say hi\n");
    mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
    writeFileSync(join(dir, ".agents", "skills", "broken.md"), "# no front matter\n");
    const lines = await startupLines(dir, { model: "some/model", provider: "custom", baseUrl: "http://127.0.0.1:9/v1", memoryEnabled: false });
    const text = lines.map((e) => ("text" in e ? e.text : "")).join("\n");
    assert.match(text, /\/tour .* shadowed by built-in/);
    assert.match(text, /skill index error: Failed to parse .*broken\.md/);
  });
});
