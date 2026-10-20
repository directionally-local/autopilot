import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AsterGitHub, AsterGitHubError } from "./aster-github.js";

describe("Aster GitHub REST client", () => {
  it("opens a PR against the validated repository and returns its public metadata", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown; authorization: string | null }> = [];
    const client = new AsterGitHub("placeholder-github-token", async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) as unknown : undefined,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        number: 42,
        html_url: "https://github.com/me/app/pull/42",
        title: "Add account settings",
        state: "open",
        merged_at: null,
        head: { ref: "aster/abc12345" },
        base: { ref: "main" },
      }, { status: 201 });
    });

    const pull = await client.createPullRequest("me/app", {
      title: "Add account settings",
      body: "Implemented the requested settings page.",
      head: "aster/abc12345",
      base: "main",
    });

    assert.deepEqual(pull, {
      number: 42,
      url: "https://github.com/me/app/pull/42",
      title: "Add account settings",
      state: "open",
      headBranch: "aster/abc12345",
      baseBranch: "main",
      merged: false,
    });
    assert.equal(calls[0]?.url, "https://api.github.com/repos/me/app/pulls");
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[0]?.body, {
      title: "Add account settings",
      body: "Implemented the requested settings page.",
      head: "aster/abc12345",
      base: "main",
    });
    assert.equal(calls[0]?.authorization, "Bearer placeholder-github-token");
  });

  it("lists check runs for a repository ref", async () => {
    const client = new AsterGitHub("placeholder-github-token", async (input) => {
      assert.equal(String(input), "https://api.github.com/repos/me/app/commits/aster%2Fabc12345/check-runs?per_page=100");
      return Response.json({ check_runs: [
        { id: 8, name: "Tests", status: "completed", conclusion: "success", html_url: "https://github.com/me/app/actions/runs/8" },
        { id: 9, name: "Lint", status: "in_progress", conclusion: null },
      ] });
    });

    assert.deepEqual(await client.listChecks("me/app", "aster/abc12345"), [
      { id: 8, name: "Tests", status: "completed", conclusion: "success", url: "https://github.com/me/app/actions/runs/8" },
      { id: 9, name: "Lint", status: "in_progress", conclusion: null, url: null },
    ]);
  });

  it("treats an already-merged pull request as an idempotent merge success", async () => {
    const methods: string[] = [];
    const client = new AsterGitHub("placeholder-github-token", async (_input, init) => {
      methods.push(init?.method ?? "GET");
      if (init?.method === "PUT") return Response.json({ message: "Pull Request is not mergeable" }, { status: 405 });
      return Response.json({
        number: 42, html_url: "https://github.com/me/app/pull/42", title: "Already merged", state: "closed",
        merged_at: "2026-10-20T00:00:00Z", head: { ref: "aster/abc12345" }, base: { ref: "main" },
      });
    });

    assert.deepEqual(await client.mergePullRequest("me/app", 42), {
      merged: true,
      message: "Pull request was already merged",
    });
    assert.deepEqual(methods, ["PUT", "GET"]);
  });

  it("merges with squash and rejects unsafe repository or branch values before network access", async () => {
    let requestCount = 0;
    const client = new AsterGitHub("placeholder-github-token", async (_input, init) => {
      requestCount++;
      assert.equal(init?.method, "PUT");
      assert.deepEqual(JSON.parse(String(init?.body)), { merge_method: "squash" });
      return Response.json({ merged: true, message: "Pull Request successfully merged", sha: "abc123" });
    });
    assert.deepEqual(await client.mergePullRequest("me/app", 42), {
      merged: true,
      message: "Pull Request successfully merged",
      sha: "abc123",
    });
    await assert.rejects(client.createPullRequest("me/../../other", {
      title: "Unsafe",
      body: "",
      head: "branch",
      base: "main",
    }), (error: unknown) => error instanceof AsterGitHubError && error.code === "invalid_repository");
    await assert.rejects(client.createPullRequest("me/app", {
      title: "Unsafe",
      body: "",
      head: "../../main",
      base: "main",
    }), (error: unknown) => error instanceof AsterGitHubError && error.code === "invalid_pull_request");
    assert.equal(requestCount, 1);
  });
});
