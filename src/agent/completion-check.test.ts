import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { completionCheckFromConfig, createJevCompletionCheck, prCiNudge, shouldCheckCompletion, toolsUsedSince } from "./completion-check.js";
import type { JevQuestion } from "./jev.js";
import type { ChatMessage } from "./messages.js";

const input = { userRequest: "Implement the feature", finalText: "I reviewed the code. Next I'll implement it.", toolsUsed: ["read", "grep"] };

describe("completion check", () => {
  it("only checks substantial turns that didn't end by asking the user", () => {
    assert.equal(shouldCheckCompletion(input, "medium"), true);
    assert.equal(shouldCheckCompletion(input, "light"), false);
    assert.equal(shouldCheckCompletion({ ...input, finalText: "Should I use Postgres or SQLite?" }, "heavy"), false);
    assert.equal(shouldCheckCompletion({ ...input, finalText: "  " }, "heavy"), false);
  });

  it("asks Jev a yes/no question with the request, tool summary, and final message (redacted)", async () => {
    let asked: JevQuestion | undefined;
    const check = createJevCompletionCheck("k", async (_key, q) => {
      asked = q;
      return { type: "noul", noul: 0.03 };
    });
    const p = await check({ ...input, userRequest: "deploy with API_KEY=sk-or-v1-abcdefghijk" }, new AbortController().signal);
    assert.equal(p, 0.03);
    assert.equal(asked?.kind, "yes");
    assert.match(asked!.prompt, /stopping early, only planning, or announcing next steps/);
    assert.match(asked!.prompt, /clearly explaining a blocker or question that needs the user/);
    assert.match(asked!.prompt, /2 tool calls \(read, grep\); it only read or searched/);
    assert.match(asked!.prompt, /Next I'll implement it/);
    assert.doesNotMatch(asked!.prompt, /sk-or-v1-abcdefghijk/);
  });

  it("returns null when Jev fails or answers in the wrong shape", async () => {
    assert.equal(await createJevCompletionCheck("k", async () => { throw new Error("down"); })(input, new AbortController().signal), null);
    assert.equal(await createJevCompletionCheck("k", async () => ({ type: "choice", probabilities: {} }))(input, new AbortController().signal), null);
  });

  it("is off without OpenRouter, with a custom endpoint, or when disabled", () => {
    assert.equal(completionCheckFromConfig({}), undefined);
    assert.equal(completionCheckFromConfig({ openrouterApiKey: "k", baseUrl: "https://x" }), undefined);
    assert.equal(completionCheckFromConfig({ openrouterApiKey: "k", completionCheck: false }), undefined);
    assert.equal(typeof completionCheckFromConfig({ openrouterApiKey: "k" }), "function");
  });

  it("lists the tools used since the turn's request", () => {
    const user: ChatMessage = { role: "user", content: "go" };
    const messages: ChatMessage[] = [
      { role: "assistant", content: null, tool_calls: [{ id: "0", type: "function", function: { name: "old", arguments: "{}" } }] },
      user,
      { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }, { id: "2", type: "function", function: { name: "edit", arguments: "{}" } }] },
      { role: "tool", tool_call_id: "1", content: "x" },
    ];
    assert.deepEqual(toolsUsedSince(messages, user), ["read", "edit"]);
  });
});


describe("prCiNudge", () => {
  const user: ChatMessage = { role: "user", content: "ship it" };
  const created = (content: string): ChatMessage[] => [
    user,
    { role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "github_create_pr", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "1", name: "github_create_pr", content },
  ];
  const checked = (content: string): ChatMessage => ({ role: "tool", tool_call_id: "2", name: "github_pr_checks", content });

  it("nudges when a PR was created but CI was never checked", () => {
    const nudge = prCiNudge(created("Created PR #42: Add feature"), user);
    assert.match(nudge!, /never checked its CI/);
  });

  it("ignores turns that did not create a PR", () => {
    assert.equal(prCiNudge(created("Failed to create PR: nope"), user), null);
  });

  it("nudges while checks are still pending", () => {
    const messages = [...created("Created PR #42: Add feature"), checked("PR #42 — CI: 0 failing, 2 pending, 1 passed")];
    assert.match(prCiNudge(messages, user)!, /still running/);
  });

  it("stays quiet once every check passed", () => {
    const messages = [...created("Created PR #42: Add feature"), checked("PR #42 — CI: 0 failing, 0 pending, 3 passed")];
    assert.equal(prCiNudge(messages, user), null);
  });

  it("nudges when a fix was pushed after the last check", () => {
    const messages: ChatMessage[] = [
      ...created("Created PR #42: Add feature"),
      checked("PR #42 — CI: 1 failing, 0 pending, 2 passed"),
      {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "3", type: "function", function: { name: "bash", arguments: JSON.stringify({ command: "git push origin feat" }) } }],
      },
    ];
    assert.match(prCiNudge(messages, user)!, /pushed a fix/);
  });
});
