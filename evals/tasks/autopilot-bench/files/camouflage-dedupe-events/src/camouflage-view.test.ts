import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { helpOptions, listMentionDir, modelOptions, shouldSendSubagentPolicyNotice, splitBangResult, syncSlashCommands, toolRow, toolSummary, validateCommandName } from "./camouflage-view.js";
import { listModels } from "./models/registry.js";

describe("Camouflage event sync helpers", () => {
  it("registers slash commands only when the complete payload changes", () => {
    const sent: { name: string; description?: string; args_hint?: string }[][] = [];
    const send = (commands: { name: string; description?: string; args_hint?: string }[]) => sent.push(commands);
    let key = syncSlashCommands([], undefined, send);
    key = syncSlashCommands([], key, send);
    key = syncSlashCommands([{ name: "review", description: "Review changes" }], key, send);
    key = syncSlashCommands([{ name: "review", description: "Review changes" }], key, send);
    key = syncSlashCommands([{ name: "review", description: "Review carefully" }], key, send);
    assert.equal(sent.length, 3, "startup sends once, then only the add and edit changes");
    assert.ok(sent[0]!.some((command) => command.args_hint), "built-in argument hints are in the registered payload");
    assert.deepEqual(sent[2]!.at(-1), { name: "review", description: "Review carefully (custom)" });
  });

  it("deduplicates repeated policy notices but keeps user-directed decisions", () => {
    const sent = new Set<string>();
    const automatic = "Subagent policy: auto will assess this substantial task for independent work; worker calls remain permission-gated.";
    assert.equal(shouldSendSubagentPolicyNotice(automatic, sent), true);
    assert.equal(shouldSendSubagentPolicyNotice(automatic, sent), false);
    assert.equal(shouldSendSubagentPolicyNotice("Subagent policy: auto policy changed.", sent), true);
    const explicit = "Subagent policy: respecting your explicit request to delegate. Worker calls still require permission.";
    assert.equal(shouldSendSubagentPolicyNotice(explicit, sent), true);
    assert.equal(shouldSendSubagentPolicyNotice(explicit, sent), true);
  });

  it("strips bang status from output and preserves ordinary tool output", () => {
    assert.deepEqual(splitBangResult("! false", "exit=7\nfailed\n"), { output: "failed\n", status: "exit=7", exitCode: 7 });
    assert.deepEqual(splitBangResult("! kill", "signal=SIGTERM\npartial output"), { output: "partial output", status: "signal=SIGTERM" });
    assert.deepEqual(splitBangResult("Bash", "exit=1\nnot a bang command"), { output: "exit=1\nnot a bang command" });
  });
});
describe("listMentionDir", () => {
  it("lists the folder being typed, folders first, prefixed as typed", async () => {
    const root = await mkdtemp(join(tmpdir(), "mention-"));
    await mkdir(join(root, "proj"));
    await mkdir(join(root, "zeta"));
    await writeFile(join(root, "a.md"), "");
    await writeFile(join(root, ".hidden"), "");
    const cwd = join(root, "proj");
    assert.deepEqual(await listMentionDir(cwd, "../"), { dir: "../", entries: ["../proj/", "../zeta/", "../a.md"] });
    assert.deepEqual((await listMentionDir(cwd, "..")).dir, "../");
    assert.deepEqual((await listMentionDir(cwd, "../ze")).entries[0], "../proj/");
    assert.deepEqual(await listMentionDir(cwd, "../nope/x"), { dir: "../nope/", entries: [] });
  });
});

describe("tool rows", () => {
  it("splits a render title into name and arguments", () => {
    assert.deepEqual(toolRow("read", "read src/a.ts", "{}"), { label: "Read", args: "src/a.ts" });
    assert.deepEqual(toolRow("mcp_x_y", undefined, '{"q":1}'), { label: "mcp_x_y", args: '{"q":1}' });
  });
  it("summarizes results", () => {
    assert.equal(toolSummary("read", true, false, "a\nb\nc\n"), "3 lines");
    assert.equal(toolSummary("grep", true, false, ""), "No matches");
    assert.equal(toolSummary("bash", false, false, "\nboom: failed\n"), "boom: failed");
    assert.match(toolSummary("edit", false, true, "Permission denied"), /declined/);
  });
});

describe("modelOptions", () => {
  it("matches the Ink picker: current, then best & latest, then the rest, with columns", () => {
    const models = listModels().filter((m) => m.supports.tools);
    const current = models[models.length - 1]!.id;
    const opts = modelOptions(models, current);
    assert.equal(opts.length, models.length, "every model is reachable");
    assert.ok(opts.every((o) => o.columns?.length === 2), "context and price columns");
    const sections = [...new Set(opts.map((o) => o.section))];
    assert.ok(sections.some((x) => x?.startsWith("Best & latest")));
    if (sections[0] === "Current") assert.equal(opts[0]!.value, current);
  });
});

describe("helpOptions", () => {
  it("lists the Ink help pages as sections, with custom commands last", () => {
    const opts = helpOptions([{ name: "ship", description: "Ship it" }]);
    const sections = [...new Set(opts.map((o) => o.section))];
    assert.deepEqual(sections.slice(0, 3), ["Mode", "Session", "Memory"]);
    assert.ok(opts.some((o) => o.value === "/memory search <query>"), "argument templates are pickable");
    assert.deepEqual(opts[opts.length - 1], { value: "/ship", label: "/ship", description: "Ship it", section: "Custom commands" });
  });
});

describe("validateCommandName", () => {
  it("applies the Ink wizard's rules", () => {
    assert.equal(validateCommandName("review", []), null);
    assert.equal(validateCommandName("ops/deploy-check", []), null);
    assert.match(validateCommandName("1bad", [])!, /start with a letter/);
    assert.match(validateCommandName("Model", [])!, /built-in/);
    assert.match(validateCommandName("review", ["review"])!, /already exists/);
  });
});
