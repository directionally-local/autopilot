import { describe, it } from "node:test";
import assert from "node:assert";
import { githubReadPrTool, githubReadIssueTool, githubReadCodeTool, githubCreatePrTool, githubFetch } from "./github.js";
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
