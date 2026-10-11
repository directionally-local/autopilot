import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import { getUserAgent } from "../util/version.js";

const GITHUB_API_BASE = "https://api.github.com";
const TIMEOUT_MS = 20_000;

function getHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": getUserAgent(),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  return headers;
}

function githubApiBase(): string {
  return process.env.ASTER_GITHUB_API_URL?.trim().replace(/\/+$/, "") || GITHUB_API_BASE;
}

function githubRequestTimeoutMs(): number {
  // Aster proxy writes may wait for an approval (configured server maximum: one hour).
  return process.env.ASTER_GITHUB_API_URL ? 66 * 60 * 1000 : TIMEOUT_MS;
}

async function githubFetch(path: string, token?: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), githubRequestTimeoutMs());
  try {
    const res = await fetch(`${githubApiBase()}${path}`, {
      signal: controller.signal,
      headers: getHeaders(token),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function githubPost(path: string, body: unknown, token?: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), githubRequestTimeoutMs());
  try {
    const res = await fetch(`${githubApiBase()}${path}`, {
      method: "POST",
      signal: controller.signal,
      headers: {
        ...getHeaders(token),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function makeOutput(content: string): ToolOutput {
  const bytes = Buffer.byteLength(content, "utf8");
  return { content, rawBytes: bytes, reducedBytes: bytes };
}

function getToken(ctx: ToolContext): string | undefined {
  return process.env.ASTER_GITHUB_TOKEN || ctx.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

function formatError(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

// ─── github_list_merged_prs ──────────────────────────────────────────────────

interface ListMergedPrsArgs {
  owner: string;
  repo: string;
  days?: number;
}

export const githubListMergedPrsTool: ToolSpec<ListMergedPrsArgs> = {
  name: "github_list_merged_prs",
  description:
    "List merged pull requests for a repository within the last N days. " +
    "Returns PR number, title, author, merge date, and URL for each merged PR.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      days: { type: "integer", description: "Number of days to look back. Default: 7.", minimum: 1, maximum: 90 },
    },
    required: ["owner", "repo"],
    additionalProperties: false,
  },
  needsPermission: false,
  render: (args) => ({ title: `GitHub merged PRs ${args.owner ?? ""}/${args.repo ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    const days = args.days ?? 7;
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();

    // Fetch merged PRs sorted by updated desc, then filter by merged_at
    const prs = await githubFetch(
      `/repos/${args.owner}/${args.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      token,
    ) as Array<{
      number: number;
      title: string;
      user: { login: string };
      merged_at: string | null;
      html_url: string;
      body: string | null;
    }>;

    const merged = prs
      .filter((p) => p.merged_at && p.merged_at >= since)
      .sort((a, b) => (b.merged_at ?? "").localeCompare(a.merged_at ?? ""));

    if (merged.length === 0) {
      return makeOutput(`No merged PRs in ${args.owner}/${args.repo} within the last ${days} day(s).`);
    }

    const lines = merged.map((p) =>
      `#${p.number} ${p.title} — @${p.user.login} — merged ${p.merged_at!.slice(0, 10)} — ${p.html_url}`,
    );

    return makeOutput(
      [`Merged PRs in ${args.owner}/${args.repo} (last ${days} days):`, "", ...lines].join("\n"),
    );
  },
};

// ─── github_list_releases ────────────────────────────────────────────────────

interface ListReleasesArgs {
  owner: string;
  repo: string;
  limit?: number;
}

export const githubListReleasesTool: ToolSpec<ListReleasesArgs> = {
  name: "github_list_releases",
  description:
    "List recent GitHub releases for a repository. " +
    "Returns tag name, name, published date, and URL for each release.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      limit: { type: "integer", description: "Max releases to return. Default: 5.", minimum: 1, maximum: 20 },
    },
    required: ["owner", "repo"],
    additionalProperties: false,
  },
  needsPermission: false,
  render: (args) => ({ title: `GitHub releases ${args.owner ?? ""}/${args.repo ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    const limit = args.limit ?? 5;

    const releases = await githubFetch(
      `/repos/${args.owner}/${args.repo}/releases?per_page=${limit}`,
      token,
    ) as Array<{
      tag_name: string;
      name: string;
      published_at: string;
      html_url: string;
      body: string | null;
    }>;

    if (releases.length === 0) {
      return makeOutput(`No releases found for ${args.owner}/${args.repo}.`);
    }

    const lines = releases.map((r) =>
      `${r.tag_name} — ${r.name} — published ${r.published_at.slice(0, 10)} — ${r.html_url}`,
    );

    return makeOutput(
      [`Releases for ${args.owner}/${args.repo}:`, "", ...lines].join("\n"),
    );
  },
};

// ─── github_read_pr ──────────────────────────────────────────────────────────

interface ReadPrArgs {
  owner: string;
  repo: string;
  number: number;
}

export const githubReadPrTool: ToolSpec<ReadPrArgs> = {
  name: "github_read_pr",
  description:
    "Read a GitHub pull request by owner, repo, and PR number. Returns title, body, state, author, " +
    "created/updated dates, and a summary of changed files. Use this in plan mode or when you need " +
    "structured PR data without write permissions.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      number: { type: "integer", description: "Pull request number.", minimum: 1 },
    },
    required: ["owner", "repo", "number"],
    additionalProperties: false,
  },
  needsPermission: false,
  render: (args) => ({ title: `GitHub PR ${args.owner ?? ""}/${args.repo ?? ""}#${args.number ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    const pr = await githubFetch(`/repos/${args.owner}/${args.repo}/pulls/${args.number}`, token) as {
      title: string;
      body: string | null;
      state: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
      merged: boolean;
      mergeable: boolean | null;
      additions: number;
      deletions: number;
      changed_files: number;
      html_url: string;
      head: { ref: string; sha: string };
      base: { ref: string; sha: string };
    };

    const files = await githubFetch(
      `/repos/${args.owner}/${args.repo}/pulls/${args.number}/files?per_page=100`,
      token,
    ) as Array<{ filename: string; status: string; additions: number; deletions: number }>;

    const fileLines = files.map((f) => `  ${f.status}  ${f.filename}  +${f.additions}/-${f.deletions}`);

    const content = [
      `PR: ${pr.title}`,
      `URL: ${pr.html_url}`,
      `State: ${pr.state}${pr.merged ? " (merged)" : ""}`,
      `Author: ${pr.user.login}`,
      `Created: ${pr.created_at}`,
      `Updated: ${pr.updated_at}`,
      `Branch: ${pr.head.ref} → ${pr.base.ref}`,
      `Changes: +${pr.additions}/-${pr.deletions} in ${pr.changed_files} file(s)`,
      `Mergeable: ${pr.mergeable ?? "unknown"}`,
      "",
      pr.body ?? "(no description)",
      "",
      "Files:",
      ...fileLines,
    ].join("\n");

    return makeOutput(content);
  },
};

// ─── github_read_issue ───────────────────────────────────────────────────────

interface ReadIssueArgs {
  owner: string;
  repo: string;
  number: number;
}

export const githubReadIssueTool: ToolSpec<ReadIssueArgs> = {
  name: "github_read_issue",
  description:
    "Read a GitHub issue by owner, repo, and issue number. Returns title, body, state, author, " +
    "labels, and comments summary. Use this in plan mode or when you need structured issue data.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      number: { type: "integer", description: "Issue number.", minimum: 1 },
    },
    required: ["owner", "repo", "number"],
    additionalProperties: false,
  },
  needsPermission: false,
  render: (args) => ({ title: `GitHub issue ${args.owner ?? ""}/${args.repo ?? ""}#${args.number ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    const issue = await githubFetch(`/repos/${args.owner}/${args.repo}/issues/${args.number}`, token) as {
      title: string;
      body: string | null;
      state: string;
      user: { login: string };
      created_at: string;
      updated_at: string;
      labels: Array<{ name: string }>;
      html_url: string;
      comments: number;
    };

    const comments = issue.comments > 0
      ? (await githubFetch(
          `/repos/${args.owner}/${args.repo}/issues/${args.number}/comments?per_page=20`,
          token,
        ) as Array<{ user: { login: string }; body: string; created_at: string }>)
      : [];

    const labelNames = issue.labels.map((l) => l.name).join(", ") || "none";

    const commentLines = comments.length > 0
      ? [
          "",
          `Comments (${comments.length} of ${issue.comments}):`,
          ...comments.map((c) => `  @${c.user.login} (${c.created_at}):\n    ${c.body.replace(/\n/g, "\n    ")}`),
        ]
      : [];

    const content = [
      `Issue: ${issue.title}`,
      `URL: ${issue.html_url}`,
      `State: ${issue.state}`,
      `Author: ${issue.user.login}`,
      `Labels: ${labelNames}`,
      `Created: ${issue.created_at}`,
      `Updated: ${issue.updated_at}`,
      `Comments: ${issue.comments}`,
      "",
      issue.body ?? "(no description)",
      ...commentLines,
    ].join("\n");

    return makeOutput(content);
  },
};

// ─── github_read_code ────────────────────────────────────────────────────────

interface ReadCodeArgs {
  owner: string;
  repo: string;
  path: string;
  ref?: string;
}

export const githubReadCodeTool: ToolSpec<ReadCodeArgs> = {
  name: "github_read_code",
  description:
    "Read file contents from a GitHub repository at a specific path and optional ref (branch, tag, or commit SHA). " +
    "Returns the file content as text. For directories, returns a list of entries. " +
    "Use this to inspect code in remote repositories without cloning them.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      path: { type: "string", description: "File or directory path within the repository." },
      ref: { type: "string", description: "Branch, tag, or commit SHA. Defaults to the default branch." },
    },
    required: ["owner", "repo", "path"],
    additionalProperties: false,
  },
  needsPermission: false,
  render: (args) => ({
    title: `GitHub code ${args.owner ?? ""}/${args.repo ?? ""}/${args.path ?? ""}${args.ref ? `@${args.ref}` : ""}`,
  }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    const refParam = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
    const data = await githubFetch(`/repos/${args.owner}/${args.repo}/contents/${encodeURIComponent(args.path)}${refParam}`, token) as
      | { type: "file"; content: string; encoding: "base64"; html_url: string; size: number; name: string }
      | Array<{ type: string; name: string; path: string; size: number }>;

    if (Array.isArray(data)) {
      // Directory listing
      const lines = data.map((item) => `  ${item.type === "dir" ? "📁" : "📄"} ${item.name}${item.type !== "dir" ? ` (${item.size} bytes)` : ""}`);
      const content = [`Directory: ${args.owner}/${args.repo}/${args.path}`, "", ...lines].join("\n");
      return makeOutput(content);
    }

    if (data.type === "file") {
      const decoded = Buffer.from(data.content, "base64").toString("utf8");
      const content = [`File: ${args.owner}/${args.repo}/${args.path}`, `URL: ${data.html_url}`, `Size: ${data.size} bytes`, "", decoded].join("\n");
      return makeOutput(content);
    }

    return makeOutput(`Unexpected response type for ${args.path}`);
  },
};

// ─── github_create_pr ────────────────────────────────────────────────────────

interface CreatePrArgs {
  owner: string;
  repo: string;
  title: string;
  body?: string;
  head: string;
  base?: string;
  draft?: boolean;
}

export const githubCreatePrTool: ToolSpec<CreatePrArgs> = {
  name: "github_create_pr",
  description:
    "Create a pull request on GitHub. Provide the owner, repo, title, and the head branch " +
    "(the branch containing your changes). The base branch defaults to the repository's default branch.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      title: { type: "string", description: "Pull request title." },
      body: { type: "string", description: "Pull request description (markdown supported)." },
      head: { type: "string", description: "Branch containing the changes." },
      base: { type: "string", description: "Branch to merge into. Defaults to the repository's default branch." },
      draft: { type: "boolean", description: "Create as a draft pull request." },
    },
    required: ["owner", "repo", "title", "head"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({ title: `Create PR ${args.owner ?? ""}/${args.repo ?? ""}: ${args.title ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    let base = args.base;
    if (!base) {
      try {
        const repoInfo = await githubFetch(`/repos/${args.owner}/${args.repo}`, token) as { default_branch: string };
        base = repoInfo.default_branch;
      } catch (err) {
        return makeOutput(`Failed to determine default branch for ${args.owner}/${args.repo}: ${formatError(err)}`);
      }
    }

    let pr: {
      number: number;
      title: string;
      html_url: string;
      state: string;
      head?: { ref?: string };
      base?: { ref?: string };
    };
    try {
      pr = await githubPost(
        `/repos/${args.owner}/${args.repo}/pulls`,
        {
          title: args.title,
          body: args.body ?? "",
          head: args.head,
          base,
          draft: args.draft ?? false,
        },
        token,
      ) as typeof pr;
    } catch (err) {
      return makeOutput(`Failed to create PR: ${formatError(err)}`);
    }

    const branchLine = pr.head?.ref && pr.base?.ref
      ? `Branch: ${pr.head.ref} → ${pr.base.ref}`
      : undefined;
    const content = [
      `Created PR #${pr.number}: ${pr.title}`,
      `URL: ${pr.html_url}`,
      `State: ${pr.state}`,
      ...(branchLine ? [branchLine] : []),
    ].join("\n");

    return makeOutput(content);
  },
};
