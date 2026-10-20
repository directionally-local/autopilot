import { describe, it } from "node:test";
import assert from "node:assert";
import { buildPromptContent, expandCustomCommand, turnReasoningEffort } from "./prepare-prompt.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CustomCommand } from "../commands/types.js";

const cmd = (over: Partial<CustomCommand> = {}): CustomCommand => ({ name: "review", template: "Review $1", source: "project", filepath: "x.md", ...over });
const render = async (c: CustomCommand, input: string) => ({ prompt: c.template.replace("$1", input.split(/\s+/)[1] ?? ""), warnings: [] as string[] });

describe("expandCustomCommand", () => {
  it("returns null for plain prompts and unknown commands", async () => {
    assert.strictEqual(await expandCustomCommand("fix it", [cmd()], render), null);
    assert.strictEqual(await expandCustomCommand("/other x", [cmd()], render), null);
  });

  it("renders the template and reports per-turn overrides", async () => {
    const out = await expandCustomCommand("/Review auth.ts", [cmd({ model: "m/x", effort: "high", mode: "plan" })], render);
    assert.strictEqual(out?.prompt, "Review auth.ts");
    assert.strictEqual(out?.model, "m/x");
    assert.strictEqual(out?.effort, "high");
    assert.deepStrictEqual(out?.notices, [
      "command 'review' → model=m/x, effort=high (this turn)",
      "note: mode override (plan) is not yet wired; current mode applies",
    ]);
  });

  it("an empty render sends nothing but keeps template warnings", async () => {
    const out = await expandCustomCommand("/review", [cmd({ shell: true, model: "m/x" })], async () => ({ prompt: "  ", warnings: ["missing $1"] }));
    assert.deepStrictEqual(out, { prompt: "", notices: ["/review: missing $1", "/review: executing shell code from template"] });
  });
});

describe("buildPromptContent", () => {
  it("plain text stays a string", async () => {
    const out = await buildPromptContent("hello", async () => {
      throw new Error("unused");
    });
    assert.deepStrictEqual(out, { content: "hello", images: [], errors: [], notices: [] });
  });

  it("attaches encodable images and reports the rest", async () => {
    const dir = mkdtempSync(join(tmpdir(), "prompt-img-"));
    const [a, b] = [join(dir, "a.png"), join(dir, "b.png")];
    writeFileSync(a, "");
    writeFileSync(b, "");
    const out = await buildPromptContent(`look at ${a} and ${b}`, async (path) => {
      if (path.includes("b.png")) throw new Error("unreadable");
      return { filename: "a.png", dataUrl: "data:image/png;base64,AA", mimeType: "image/png" } as never;
    });
    assert.deepStrictEqual(out.images, ["a.png"]);
    assert.ok(Array.isArray(out.content) && out.content[1]?.type === "image_url");
    assert.strictEqual(out.errors.length, 1);
    assert.match(out.errors[0]!, /failed to encode image .*b\.png: unreadable/);
  });
});

describe("turnReasoningEffort", () => {
  it("override, then tier, then the session's effort", () => {
    assert.strictEqual(turnReasoningEffort("light", "high", "medium"), "high");
    assert.strictEqual(turnReasoningEffort("heavy", undefined, "low"), "high");
    assert.strictEqual(turnReasoningEffort("unknown", undefined, "low"), "low");
  });
});
