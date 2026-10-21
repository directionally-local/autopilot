import { describe, it } from "node:test";
import assert from "node:assert";
import { extractFirstUserText, buildLocalResumeSummary, sessionNameText } from "./use-session-manager.js";
import type { ChatMessage } from "../agent/messages.js";
import type { SessionState } from "../agent/session-state.js";
import { emptySessionState } from "../agent/session-state.js";

describe("extractFirstUserText", () => {
  it("returns 'session' for empty messages", () => {
    assert.strictEqual(extractFirstUserText([]), "session");
  });

  it("returns 'session' when there is no user message", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "you are kimi" },
      { role: "assistant", content: "hi" },
    ];
    assert.strictEqual(extractFirstUserText(msgs), "session");
  });

  it("returns string content directly", () => {
    const msgs: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "fix the bug in auth.ts" },
    ];
    assert.strictEqual(extractFirstUserText(msgs), "fix the bug in auth.ts");
  });

  it("extracts the first text part from an array-shaped user message", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [
          { type: "image", image_url: { url: "data:..." } } as never,
          { type: "text", text: "describe this screenshot" },
        ],
      },
    ];
    assert.strictEqual(extractFirstUserText(msgs), "describe this screenshot");
  });

  it("falls back to 'session' when array content has no text part", () => {
    const msgs: ChatMessage[] = [
      {
        role: "user",
        content: [{ type: "image", image_url: { url: "data:..." } } as never],
      },
    ];
    assert.strictEqual(extractFirstUserText(msgs), "session");
  });

  it("falls back to 'session' when string content is empty", () => {
    const msgs: ChatMessage[] = [{ role: "user", content: "" }];
    assert.strictEqual(extractFirstUserText(msgs), "session");
  });

  it("uses only the first user message, ignoring later ones", () => {
    const msgs: ChatMessage[] = [
      { role: "user", content: "first" },
      { role: "assistant", content: "ok" },
      { role: "user", content: "second" },
    ];
    assert.strictEqual(extractFirstUserText(msgs), "first");
  });
});

describe("sessionNameText", () => {
  it("names a new session after the opening prompt before it is in the history", () => {
    // The TUI creates the id before UserPromptSubmit so the first prompt's
    // hook payload carries it (it used to be null).
    assert.strictEqual(sessionNameText([{ role: "system", content: "sys" }], "  fix the login bug "), "fix the login bug");
  });

  it("falls back to the first user message", () => {
    assert.strictEqual(sessionNameText([{ role: "user", content: "earlier" }]), "earlier");
    assert.strictEqual(sessionNameText([], "   "), "session");
  });
});

describe("buildLocalResumeSummary", () => {
  it("returns null for empty session state", () => {
    assert.strictEqual(buildLocalResumeSummary(emptySessionState()), null);
  });

  it("includes task when set", () => {
    const state = emptySessionState("Fix auth bug");
    assert.strictEqual(buildLocalResumeSummary(state), "Task: Fix auth bug");
  });

  it("includes modified files", () => {
    const state = emptySessionState();
    state.files_modified = ["src/auth.ts", "src/auth.test.ts"];
    assert.strictEqual(
      buildLocalResumeSummary(state),
      "Modified: src/auth.ts, src/auth.test.ts",
    );
  });

  it("includes next actions (max 3)", () => {
    const state = emptySessionState();
    state.next_actions = ["run tests", "update docs", "commit", "deploy"];
    const result = buildLocalResumeSummary(state);
    assert.ok(result?.includes("Next: run tests; update docs; commit"));
    assert.ok(!result?.includes("deploy"));
  });

  it("combines task, modified files, and next actions", () => {
    const state = emptySessionState("Refactor API");
    state.files_modified = ["src/api.ts"];
    state.next_actions = ["add tests", "update README"];
    assert.strictEqual(
      buildLocalResumeSummary(state),
      "Task: Refactor API | Modified: src/api.ts | Next: add tests; update README",
    );
  });

  it("returns null when only empty arrays are present", () => {
    const state: SessionState = {
      ...emptySessionState(),
      files_modified: [],
      next_actions: [],
    };
    assert.strictEqual(buildLocalResumeSummary(state), null);
  });
});
