import { describe, it } from "node:test";
import assert from "node:assert";
import { BUG_REPORT_LINE } from "./bug-report.js";
import { dispatchSlashCommand, type SlashContext } from "./slash-commands.js";
import { BUILTIN_COMMANDS } from "../commands/builtins.js";

describe("/bug", () => {
  it("prints where to report a bug and files nothing", async () => {
    const infos: string[] = [];
    const ctx = {
      cfg: null,
      mkKey: () => "k",
      setEvents: (f: (e: Array<{ text: string }>) => Array<{ text: string }>) => infos.push(...f([]).map((e) => e.text)),
    } as unknown as SlashContext;
    assert.strictEqual(await dispatchSlashCommand(ctx, "/bug"), true);
    assert.deepStrictEqual(infos, ["Report a bug: https://github.com/directionally-local/autopilot/issues/new · or email contact@directionallylocal.com · Feedback: /feedback"]);
    assert.strictEqual(infos[0], BUG_REPORT_LINE);
  });

  it("/help opens the menu with the same line as its footer", async () => {
    const infos: string[] = [];
    let opened = false;
    const ctx = {
      cfg: null,
      mkKey: () => "k",
      setEvents: (f: (e: Array<{ text: string }>) => Array<{ text: string }>) => infos.push(...f([]).map((e) => e.text)),
      setShowHelpMenu: (v: boolean) => (opened = v),
    } as unknown as SlashContext;
    assert.strictEqual(await dispatchSlashCommand(ctx, "/help"), true);
    assert.strictEqual(opened, true);
    assert.deepStrictEqual(infos, [BUG_REPORT_LINE]);
  });

  it("is in the slash picker; /hello no longer offers the retired voice-note page; /exit names no old brand", () => {
    assert.ok(BUILTIN_COMMANDS.some((c) => c.name === "bug"));
    const hello = BUILTIN_COMMANDS.find((c) => c.name === "hello");
    assert.ok(hello && !/voice/i.test(hello.description));
    assert.ok(BUILTIN_COMMANDS.every((c) => !/kimiflare/i.test(c.description)));
  });
});
