import { describe, it } from "node:test";
import assert from "node:assert";
import { PassThrough } from "node:stream";
import React from "react";
import { render, renderToString } from "ink";
import { ProviderPicker } from "./provider-setup.js";
import { ThemeProvider } from "./theme-context.js";
import { resolveTheme } from "./theme.js";
import { providerRows } from "../providers/connect.js";
import type { ProviderId } from "../providers/presets.js";

const theme = resolveTheme();
const env = { OPENAI_API_KEY: "sk-env" } as NodeJS.ProcessEnv;
const rows = providerRows({ provider: "anthropic", providers: { anthropic: { apiKey: "sk-ant-saved" } } }, { env });

/** Render with a fake TTY so the picker receives keystrokes. */
function interactive(onPick: (id: ProviderId | null) => void) {
  const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: () => {}, ref: () => {}, unref: () => {} });
  let frame = "";
  const stdout = Object.assign(new PassThrough(), { isTTY: true, columns: 120, rows: 40 });
  stdout.on("data", (c: Buffer) => (frame += c.toString("utf8")));
  const app = render(
    <ThemeProvider theme={theme}>
      <ProviderPicker rows={rows} onPick={onPick} title="Switch provider" subtitle="sub" />
    </ThemeProvider>,
    { stdin: stdin as unknown as NodeJS.ReadStream, stdout: stdout as unknown as NodeJS.WriteStream, debug: true, exitOnCtrlC: false, patchConsole: false },
  );
  const tick = () => new Promise((r) => setTimeout(r, 30));
  const ready = tick();
  return {
    ready,
    async type(s: string) {
      for (const ch of s) {
        stdin.write(ch);
        await tick();
      }
    },
    async key(seq: string) {
      stdin.write(seq);
      await tick();
    },
    frame: () => frame,
    unmount: () => app.unmount(),
  };
}

describe("ProviderPicker", () => {
  it("lists ready providers first with their status, current marked", () => {
    const out = renderToString(
      <ThemeProvider theme={theme}>
        <ProviderPicker rows={rows} onPick={() => {}} title="Switch provider" subtitle="sub" />
      </ThemeProvider>,
      { columns: 140 },
    );
    const lines = out.split("\n").filter((l) => /key in environment|key saved|needs a key/.test(l));
    assert.match(lines[0]!, /● Anthropic\s+key saved/);
    assert.match(lines[1]!, /OpenAI\s+key in environment/);
    assert.match(out, /Search \d+ providers/);
  });

  it("type to search, arrows to move, Enter picks", async () => {
    let picked: ProviderId | null | undefined;
    const ui = interactive((id) => (picked = id));
    await ui.ready;
    await ui.type("gemin");
    assert.match(ui.frame(), /\d+ match/);
    await ui.key("\r");
    assert.strictEqual(picked, "gemini");
    ui.unmount();
  });

  it("searches hints too (\"local\" finds Ollama and LM Studio) and Esc cancels", async () => {
    let picked: ProviderId | null | undefined;
    const ui = interactive((id) => (picked = id));
    await ui.ready;
    await ui.type("local");
    await ui.key("\x1b[B"); // down
    await ui.key("\r");
    assert.ok(picked === "lmstudio" || picked === "ollama", String(picked));
    ui.unmount();
    let cancelled: ProviderId | null | undefined = "openai";
    const ui2 = interactive((id) => (cancelled = id));
    await ui2.ready;
    await ui2.key("\x1b");
    await new Promise((r) => setTimeout(r, 80));
    assert.strictEqual(cancelled, null);
    ui2.unmount();
  });
});
