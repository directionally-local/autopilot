import { describe, it } from "node:test";
import assert from "node:assert";
import { classifyNextMessage } from "./next-message.js";

describe("classifyNextMessage", () => {
  it("flags corrections", () => {
    for (const t of ["no, use the other file", "Nope.", "wrong file", "that's not what I meant", "not what I asked", "undo that", "revert the change", "stop"]) {
      assert.strictEqual(classifyNextMessage(t), "correction", t);
    }
  });

  it("flags continuations", () => {
    for (const t of ["go on", "continue", "yes", "ok", "OK do it", "do it", "proceed", "looks good, ship it"]) {
      assert.strictEqual(classifyNextMessage(t), "continue", t);
    }
  });

  it("flags questions and new tasks", () => {
    assert.strictEqual(classifyNextMessage("why did that fail?"), "question");
    assert.strictEqual(classifyNextMessage("add a test for the parser"), "new_task");
    assert.strictEqual(classifyNextMessage("Nothing else, thanks"), "new_task");
  });

  it("does not confuse prefixes with words", () => {
    assert.strictEqual(classifyNextMessage("Nobody uses that path, remove it"), "new_task");
    assert.strictEqual(classifyNextMessage("yesterday's build broke"), "new_task");
    assert.strictEqual(classifyNextMessage("Okra recipe?"), "question");
  });

  it("treats empty and slash input as other", () => {
    assert.strictEqual(classifyNextMessage("   "), "other");
    assert.strictEqual(classifyNextMessage("/clear"), "other");
  });
});
