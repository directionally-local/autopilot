import assert from "node:assert/strict";
import test from "node:test";
import { humanizeToolTitle } from "./narrator.js";

test("summarizes execute_code calls instead of printing serialized source", () => {
  const source = "console.log(await api.tasks_set({ tasks: [...] }))".repeat(20);
  const title = humanizeToolTitle("execute_code", `execute_code({"code":${JSON.stringify(source)}})`);

  assert.equal(title, "Running code batch");
  assert.ok(!title.includes(source));
});
