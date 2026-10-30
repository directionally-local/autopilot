import { describe, it } from "node:test";
import assert from "node:assert";
import { githubReadPrTool, githubReadIssueTool, githubReadCodeTool, githubCreatePrTool, githubPrChecksTool, githubUpdatePrTool, githubFetch } from "./github.js";
import type { ToolOutput } from "./registry.js";

describe("GitHub CLI fallback", () => {
  it("uses the CLI fallback when the REST API fails", async () => {
    const originalFetch = globalThis.fetch;
    let fallbackPath = "";
    globalThis.fetch = async () => new Response("API unavailable", { status: 503 });
    try {
      const result = await githubFetch("/repos/owner/repo", undefined, async (path) => {
        fallbackPath = path;
        return { name: "repo" };
      });
      assert.equal(fallbackPath, "/repos/owner/repo");
      assert.deepEqual(result, { name: "repo" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("github_read_pr", () => {
  it("returns PR details", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/pulls/42/files")) {
        return new Response(
          JSON.stringify([
            { filename: "src/index.ts", status: "modified", additions: 5, deletions: 2 },
            { filename: "src/test.ts", status: "added", additions: 5, deletions: 0 },
          ]),
          { status: 200 },
        );
      }
      if (url.includes("/pulls/42")) {
        return new Response(
          JSON.stringify({
            title: "Fix bug",
            body: "This fixes the bug",
            state: "open",
            user: { login: "alice" },
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-02T00:00:00Z",
            merged: false,
            mergeable: true,
            additions: 10,
            deletions: 5,
            changed_files: 2,
            html_url: "https://github.com/owner/repo/pull/42",
            head: { ref: "fix-branch", sha: "abc123" },
            base: { ref: "main", sha: "def456" },
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    try {
      const result = (await githubReadPrTool.run({ owner: "owner", repo: "repo", number: 42 }, { cwd: "/tmp" })) as ToolOutput;
      assert.ok(result.content.includes("Fix bug"));
      assert.ok(result.content.includes("alice"));
      assert.ok(result.content.includes("src/index.ts"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("github_read_issue", () => {
  it("returns issue details with comments", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = input.toString();
      if (url.includes("/issues/7/comments")) {
        return new Response(
          JSON.stringify([{ user: { login: "charlie" }, body: "Good idea", created_at: "2024-01-02T00:00:00Z" }]),
          { status: 200 },
        );
      }
      if (url.includes("/issues/7")) {
        return new Response(
          JSON.stringify({
            title: "Feature request",
            body: "Please add this feature",
            state: "open",
            user: { login: "bob" },
            created_at: "2024-01-01T00:00:00Z",
            updated_at: "2024-01-01T00:00:00Z",
            labels: [{ name: "enhancement" }],
            html_url: "https://github.com/owner/repo/issues/7",
            comments: 1,
          }),
          { status: 200 },
        );
      }
      return new Response("Not found", { status: 404 });
    };

    try {
      const result = (await githubReadIssueTool.run({ owner: "owner", repo: "repo", number: 7 }, { cwd: "/tmp" })) as ToolOutput;
      assert.ok(result.content.includes("Feature request"));
      assert.ok(result.content.includes("enhancement"));
      assert.ok(result.content.includes("charlie"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("github_read_code", () => {
  it("returns file content", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({
          type: "file",
          content: Buffer.from("console.log('hello');").toString("base64"),
          encoding: "base64",
          html_url: "https://github.com/owner/repo/blob/main/src/index.ts",
          size: 21,
          name: "index.ts",
        }),
        { status: 200 },
      );
    };

    try {
      const result = (await githubReadCodeTool.run({ owner: "owner", repo: "repo", path: "src/index.ts" }, { cwd: "/tmp" })) as ToolOutput;
      assert.ok(result.content.includes("console.log('hello')"));
      assert.ok(result.content.includes("21 bytes"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns directory listing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify([
          { type: "file", name: "index.ts", path: "src/index.ts", size: 100 },
          { type: "dir", name: "utils", path: "src/utils", size: 0 },
        ]),
        { status: 200 },
      );
    };

    try {
      const result = (await githubReadCodeTool.run({ owner: "owner", repo: "repo", path: "src" }, { cwd: "/tmp" })) as ToolOutput;
      assert.ok(result.content.includes("index.ts"));
      assert.ok(result.content.includes("utils"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("github_create_pr", () => {
  it("creates a PR and returns the URL", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input, init) => {
      const url = input.toString();
      assert.ok(url.includes("/repos/owner/repo/pulls"));
      const body = JSON.parse((init as RequestInit).body as string);
      assert.strictEqual(body.title, "Add feature");
      assert.strictEqual(body.head, "feat");
      assert.strictEqual(body.base, "main");
      assert.strictEqual(body.draft, true);

      return new Response(
        JSON.stringify({
          number: 42,
          title: "Add feature",
          html_url: "https://github.com/owner/repo/pull/42",
          state: "open",
          draft: true,
        }),
        { status: 201 },
      );
    };

    try {
      const result = (await githubCreatePrTool.run(
        { owner: "owner", repo: "repo", title: "Add feature", head: "feat", base: "main", draft: true },
        { cwd: "/tmp" },
      )) as ToolOutput;
      assert.ok(result.content.includes("#42"));
      assert.ok(result.content.includes("https://github.com/owner/repo/pull/42"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("returns a friendly error when creation fails", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      return new Response(
        JSON.stringify({ message: "Validation failed", errors: [{ message: "No commits between main and feat" }] }),
        { status: 422 },
      );
    };

    try {
      const result = (await githubCreatePrTool.run(
        { owner: "owner", repo: "repo", title: "Add feature", head: "feat", base: "main" },
        { cwd: "/tmp" },
      )) as ToolOutput;
      assert.ok(result.content.includes("Failed to create PR"));
      assert.ok(result.content.includes("No commits between main and feat"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});


describe("github_create_pr draft default", () => {
  it("opens PRs as drafts by default and points at the CI check", async () => {
    const originalFetch = globalThis.fetch;
    let body: Record<string, unknown> = {};
    globalThis.fetch = async (_input, init) => {
      body = JSON.parse((init as RequestInit).body as string);
      return new Response(
        JSON.stringify({ number: 7, title: "T", html_url: "https://github.com/o/r/pull/7", state: "open", draft: true }),
        { status: 201 },
      );
    };
    try {
      const result = (await githubCreatePrTool.run(
        { owner: "o", repo: "r", title: "T", head: "feat", base: "main" },
        { cwd: "/tmp" },
      )) as ToolOutput;
      assert.equal(body.draft, true);
      assert.match(result.content, /\(draft\)/);
      assert.match(result.content, /github_pr_checks/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("github_pr_checks", () => {
  const prPayload = {
    html_url: "https://github.com/owner/repo/pull/42",
    draft: true,
    head: { sha: "abc123def4567890", ref: "feat" },
    base: { ref: "main" },
  };

  function mockChecks(handlers: { checkRuns: () => unknown; statuses?: () => unknown }) {
    return async (input: RequestInfo | URL) => {
      const url = input.toString();
      if (url.includes("/pulls/42")) return new Response(JSON.stringify(prPayload), { status: 200 });
      if (url.includes("/check-runs")) return new Response(JSON.stringify(handlers.checkRuns()), { status: 200 });
      if (url.includes("/status")) return new Response(JSON.stringify(handlers.statuses?.() ?? { statuses: [] }), { status: 200 });
      return new Response("not found", { status: 404 });
    };
  }

  it("summarizes failing, pending, and passing checks", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockChecks({
      checkRuns: () => ({
        check_runs: [
          { name: "test", status: "completed", conclusion: "failure", details_url: "https://ci/test", output: { summary: "1 failing test" } },
          { name: "lint", status: "completed", conclusion: "success" },
          { name: "build", status: "in_progress", conclusion: null },
        ],
      }),
      statuses: () => ({ statuses: [{ context: "deploy", state: "pending" }] }),
    });
    try {
      const result = (await githubPrChecksTool.run({ owner: "owner", repo: "repo", number: 42 }, { cwd: "/tmp" })) as ToolOutput;
      assert.match(result.content, /CI: 1 failing, 2 pending, 1 passed/);
      assert.match(result.content, /✗ test — failure — 1 failing test/);
      assert.match(result.content, /Do not mark the PR ready/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("polls until the checks finish when wait_seconds is set", async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mockChecks({
      checkRuns: () => {
        calls++;
        return calls === 1
          ? { check_runs: [{ name: "test", status: "in_progress", conclusion: null }] }
          : { check_runs: [{ name: "test", status: "completed", conclusion: "success" }] };
      },
    });
    try {
      const result = (await githubPrChecksTool.run(
        { owner: "owner", repo: "repo", number: 42, wait_seconds: 2, poll_interval_seconds: 1 },
        { cwd: "/tmp" },
      )) as ToolOutput;
      assert.ok(calls >= 2);
      assert.match(result.content, /All checks passed/);
      assert.match(result.content, /Waited 1s/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("github_update_pr", () => {
  function mockPr(conclusion: string) {
    return async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input.toString();
      if (url.endsWith("/graphql")) {
        return new Response(
          JSON.stringify({ data: { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } } }),
          { status: 200 },
        );
      }
      if (url.includes("/pulls/42")) {
        return new Response(
          JSON.stringify({
            node_id: "PR_1",
            draft: true,
            html_url: "https://github.com/owner/repo/pull/42",
            head: { sha: "abc", ref: "feat" },
            base: { ref: "main" },
          }),
          { status: 200 },
        );
      }
      if (url.includes("/check-runs")) {
        return new Response(
          JSON.stringify({ check_runs: [{ name: "test", status: "completed", conclusion }] }),
          { status: 200 },
        );
      }
      if (url.includes("/status")) return new Response(JSON.stringify({ statuses: [] }), { status: 200 });
      void init;
      return new Response("{}", { status: 200 });
    };
  }

  it("refuses to mark a PR ready while checks are failing", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mockPr("failure");
    try {
      const result = (await githubUpdatePrTool.run(
        { owner: "owner", repo: "repo", number: 42, draft: false },
        { cwd: "/tmp" },
      )) as ToolOutput;
      assert.match(result.content, /Refusing to mark PR #42 ready/);
      assert.match(result.content, /test/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("marks a green PR ready for review", async () => {
    const originalFetch = globalThis.fetch;
    let graphqlQuery = "";
    const base = mockPr("success");
    globalThis.fetch = async (input, init) => {
      if (input.toString().endsWith("/graphql")) {
        graphqlQuery = JSON.parse((init as RequestInit).body as string).query;
      }
      return base(input, init);
    };
    try {
      const result = (await githubUpdatePrTool.run(
        { owner: "owner", repo: "repo", number: 42, draft: false },
        { cwd: "/tmp" },
      )) as ToolOutput;
      assert.match(graphqlQuery, /markPullRequestReadyForReview/);
      assert.match(result.content, /marked ready for review/);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  for (const draft of [true, false]) {
    for (const scenario of ["error", "unchanged", "missing result", "missing node", "success", "already set"]) {
      it(`${draft ? "draft" : "ready"}: ${scenario}`, async () => {
        const originalFetch = globalThis.fetch;
        const requests: string[] = [];
        const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
        globalThis.fetch = async (input, init) => {
          const url = input.toString();
          requests.push(`${init?.method ?? "GET"} ${url}`);
          if (url.endsWith("/graphql")) {
            const request = JSON.parse(init?.body as string);
            assert.match(request.query, new RegExp(mutation));
            assert.deepEqual(request.variables, { id: "PR_1" });
            const payload = scenario === "error"
              ? { errors: [{ message: "Resource not accessible by integration" }] }
              : { data: { [mutation]: scenario === "missing result" ? null : {
                  pullRequest: { isDraft: scenario === "unchanged" ? !draft : draft },
                } } };
            return Response.json(payload);
          }
          // GitHub ignores the unsupported REST draft field, even with HTTP 200.
          return Response.json({
            node_id: scenario === "missing node" ? undefined : "PR_1",
            draft: scenario === "already set" ? draft : !draft,
          });
        };
        try {
          const run = () => githubUpdatePrTool.run(
            { owner: "owner", repo: "repo", number: 42, draft, force: true },
            { cwd: "/tmp" },
          );
          if (scenario === "success" || scenario === "already set") {
            const result = await run() as ToolOutput;
            assert.match(result.content, scenario === "already set"
              ? /already/ : draft ? /converted to draft/ : /marked ready for review/);
          } else {
            await assert.rejects(run, scenario === "error"
              ? /Resource not accessible by integration/
              : scenario === "missing node" ? /node ID/ : /draft state/i);
          }
          assert.ok(requests.every((request) => !request.startsWith("PATCH ")));
          if (scenario === "already set" || scenario === "missing node") {
            assert.equal(requests.length, 1);
          }
        } finally {
          globalThis.fetch = originalFetch;
        }
      });
    }
  }

});
