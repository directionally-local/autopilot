import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { DlCommit } from "./dl-github.js";
import { finalAssistantMessage, issueLinkLines, pullRequestBody, pullRequestTitle, trimTitle } from "./dl-pull-request.js";

const commit = (message: string, merge = false): DlCommit => ({ sha: message.slice(0, 7), message, merge });
const PROMPT_TITLE = "Resolve GitHub issue https://github.com/me/app/issues/49 and list sessions";

describe("dl server pull request title", () => {
  it("uses the subject of a single commit", () => {
    assert.equal(pullRequestTitle([commit("feat: dl sessions lists every conversation\n\nBody text.")], PROMPT_TITLE),
      "feat: dl sessions lists every conversation");
  });

  it("uses the oldest Conventional Commit subject among several commits", () => {
    assert.equal(pullRequestTitle([
      commit("wip"),
      commit("fix(cli)!: stop listing archived sessions"),
      commit("feat: add a state column"),
    ], PROMPT_TITLE), "fix(cli)!: stop listing archived sessions");
  });

  it("uses the oldest subject when no commit is Conventional, skipping merges", () => {
    assert.equal(pullRequestTitle([
      commit("Merge branch 'main' into dl/abc", true),
      commit("Add a state column"),
      commit("Tidy the table"),
    ], PROMPT_TITLE), "Add a state column");
  });

  it("falls back to the prompt-derived title when there are no commits", () => {
    assert.equal(pullRequestTitle([], PROMPT_TITLE), PROMPT_TITLE);
  });

  it("trims long subjects to 80 characters at a word boundary", () => {
    const long = `feat: ${"conversation ".repeat(10)}`;
    const title = trimTitle(long);
    assert.ok(title.length <= 80, title);
    assert.ok(title.endsWith("conversation…"), title);
  });
});

describe("dl server pull request body", () => {
  it("keeps only the assistant text after the last tool call of the run", () => {
    const events = [
      { runId: "r1", type: "assistant.delta", data: { text: "I'll start by reading the roadmap" } },
      { runId: "r1", type: "tool.activity", data: { activity: "started" } },
      { runId: "r1", type: "assistant.delta", data: { text: "issue.Now I have it" } },
      { runId: "r1", type: "tool.activity", data: { activity: "completed" } },
      { runId: "r2", type: "assistant.delta", data: { text: "other run" } },
      { runId: "r1", type: "assistant.delta", data: { text: "\n\nAdded the state " } },
      { runId: "r1", type: "assistant.delta", data: { delta: "column.\n\n" } },
    ];
    assert.equal(finalAssistantMessage(events, "r1"), "Added the state column.");
  });

  it("falls back to commit bodies when the final message is empty", () => {
    assert.equal(pullRequestBody({
      repository: "me/app", prompt: "do it", finalMessage: "  ",
      commits: [commit("feat: add sessions\n\nLists every conversation.")],
    }), "Lists every conversation.");
    assert.equal(pullRequestBody({
      repository: "me/app", prompt: "do it", finalMessage: "",
      commits: [commit("feat: add sessions\n\nLists every conversation."), commit("test: cover sessions")],
    }), "**feat: add sessions**\n\nLists every conversation.\n\n**test: cover sessions**");
    assert.equal(pullRequestBody({ repository: "me/app", prompt: "do it", finalMessage: "", commits: [commit("feat: x")] }), "do it");
  });

  it("adds a line linking the issues the prompt and commits reference", () => {
    assert.equal(pullRequestBody({
      repository: "me/app",
      prompt: "Resolve https://github.com/me/app/issues/49, see other/lib#3 and issue #50; it is the #1 priority",
      finalMessage: "Done.",
      commits: [commit("feat: x\n\nCloses #51\nFixes #49")],
    }), "Done.\n\nResolves #49\nRefs other/lib#3\nResolves #50\nCloses #51");
  });

  it("skips issues the summary already closes and links pull requests as references", () => {
    assert.deepEqual(issueLinkLines("me/app", "fix issue #7 like https://github.com/me/app/pull/6", [], "Fixes #7"), ["Refs #6"]);
  });
});
