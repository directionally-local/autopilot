import assert from "node:assert/strict";
import { test } from "node:test";
import { createForegroundSearchChoice } from "./foreground-search.js";

const fields = { objective: "Find public Node.js readFile documentation", search_queries: ["Node.js fs readFile documentation"] };
const previewCommand = `parallel-public-docs ${JSON.stringify(fields)}`;
const tokenOf = (notice: string) => /\/search approve ([\w-]+)/.exec(notice)![1]!;

test("a literal native slash command preserves the user supplied fields and requires a separate exact approval", async () => {
  const choice = createForegroundSearchChoice();
  const spaced = { ...fields, objective: "Find  public Node.js readFile documentation" };
  const result = choice.command(`parallel-public-docs ${JSON.stringify(spaced)}`);
  assert.equal(result.permit, undefined);
  assert.ok(result.notice.includes(JSON.stringify(spaced, null, 2)));
  assert.ok(result.notice.includes("https://mcp.parallel.ai/mcp"));
  const token = tokenOf(result.notice);
  assert.equal(choice.command(`approve ${token}`).permit?.objective, spaced.objective);
  assert.equal(choice.command(`approve ${token}`).permit, undefined);
});

test("cancel, a wrong token, a new preview, and unrelated input invalidate the old preview", () => {
  for (const action of ["cancel", "approve wrong", previewCommand, ""]) {
    const choice = createForegroundSearchChoice();
    const token = tokenOf(choice.command(previewCommand).notice);
    choice.command(action);
    assert.equal(choice.command(`approve ${token}`).permit, undefined, action);
  }
  const choice = createForegroundSearchChoice();
  const token = tokenOf(choice.command(previewCommand).notice);
  choice.clear();
  assert.equal(choice.command(`approve ${token}`).permit, undefined);
});

test("missing, blank, multiple, control-character and extra metadata fields cannot be approved", () => {
  for (const input of [null, [], {}, { ...fields, objective: " " }, { ...fields, objective: "line\nbreak" },
    { ...fields, search_queries: [] }, { ...fields, search_queries: ["one", "two"] },
    { ...fields, client_model: "extra" }, { ...fields, session_id: "extra" }]) {
    const choice = createForegroundSearchChoice();
    const result = choice.command(`parallel-public-docs ${JSON.stringify(input)}`);
    assert.equal(result.permit, undefined);
    assert.ok(!result.notice.includes("lookup preview"));
  }
});
