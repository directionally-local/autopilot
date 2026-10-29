import { describe, it } from "node:test";
import assert from "node:assert";
import { buildPlanReminder, withPlanReminder } from "./plan-reminder.js";

describe("buildPlanReminder", () => {
  it("returns undefined when there is no plan", () => {
    assert.equal(buildPlanReminder([]), undefined);
  });

  it("renders each task with its status", () => {
    const reminder = buildPlanReminder([
      { id: "1", title: "read the code", status: "completed" },
      { id: "2", title: "write the fix", status: "in_progress" },
      { id: "3", title: "run tests", status: "pending" },
    ]);
    assert.match(reminder!, /Current plan:/);
    assert.match(reminder!, /\[x\] read the code/);
    assert.match(reminder!, /\[>\] write the fix/);
    assert.match(reminder!, /\[ \] run tests/);
  });
});

describe("withPlanReminder", () => {
  it("appends the reminder at the end without mutating the input", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    const out = withPlanReminder(messages, "<system-reminder>plan</system-reminder>");
    assert.equal(out.length, 2);
    assert.equal(out[1]!.role, "system");
    assert.equal(out[1]!.content, "<system-reminder>plan</system-reminder>");
    assert.equal(messages.length, 1);
  });

  it("returns the messages unchanged when there is no reminder", () => {
    const messages = [{ role: "user" as const, content: "hi" }];
    assert.equal(withPlanReminder(messages, undefined), messages);
  });
});
