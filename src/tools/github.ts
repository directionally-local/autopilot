import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import { getUserAgent } from "../util/version.js";

const execFile = promisify(execFileCallback);
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

async function ghApi(path: string, token?: string, body?: unknown, method = "POST"): Promise<unknown> {
  const args = ["api", path.replace(/^\/+/, "")];
  if (body !== undefined && typeof body === "object" && body !== null) {
    args.push("-X", method);
    for (const [key, value] of Object.entries(body)) {
      if (value === undefined || value === null) continue;
      args.push(typeof value === "boolean" ? "-F" : "-f", `${key}=${String(value)}`);
    }
  }
  const result = await execFile("gh", args, {
    timeout: TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: token ? { ...process.env, GH_TOKEN: token } : process.env,
  });
  return JSON.parse(result.stdout);
}

export async function githubFetch(path: string, token?: string, cliFallback: (path: string, token?: string) => Promise<unknown> = ghApi): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, {
      signal: controller.signal,
      headers: getHeaders(token),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`GitHub API ${res.status}: ${res.statusText}${body ? ` — ${body.slice(0, 200)}` : ""}`);
    }
    return await res.json();
  } catch (apiError) {
    try {
      return await cliFallback(path, token);
    } catch (cliError) {
      throw new Error(`${formatError(apiError)}; gh CLI fallback failed: ${formatError(cliError)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function githubPost(path: string, body: unknown, token?: string, method = "POST"): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API_BASE}${path}`, {
      method,
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
  } catch (apiError) {
    try {
      return await ghApi(path, token, body, method);
    } catch (cliError) {
      throw new Error(`${formatError(apiError)}; gh CLI fallback failed: ${formatError(cliError)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** POST a GraphQL query/mutation. Used for operations the REST API cannot
 *  express (converting a PR to draft and marking it ready for review). */
async function githubGraphql(
  query: string,
  variables: Record<string, unknown>,
  token?: string,
): Promise<Record<string, unknown>> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${GITHUB_API_BASE}/graphql`, {
      method: "POST",
      signal: controller.signal,
      headers: { ...getHeaders(token), "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const payload = (await res.json().catch(() => null)) as
      | { data?: Record<string, unknown>; errors?: Array<{ message?: string }> }
      | null;
    const detail = payload?.errors?.map((e) => e.message).filter(Boolean).join("; ");
    if (!res.ok || !payload || detail) {
      throw new Error(`GitHub GraphQL ${res.status}: ${detail || res.statusText}`);
    }
    return payload.data ?? {};
  } finally {
    clearTimeout(timer);
  }
}

function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makeOutput(content: string): ToolOutput {
  const bytes = Buffer.byteLength(content, "utf8");
  return { content, rawBytes: bytes, reducedBytes: bytes };
}

function getToken(ctx: ToolContext): string | undefined {
  return ctx.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
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
    "(the branch containing your changes). The base branch defaults to the repository's default branch. " +
    "PRs are opened as drafts by default: after creating one, wait for CI with github_pr_checks, fix any " +
    "failing checks, and only then mark it ready with github_update_pr (draft: false).",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      title: { type: "string", description: "Pull request title." },
      body: { type: "string", description: "Pull request description (markdown supported)." },
      head: { type: "string", description: "Branch containing the changes." },
      base: { type: "string", description: "Branch to merge into. Defaults to the repository's default branch." },
      draft: {
        type: "boolean",
        description:
          "Open as a draft. Defaults to true so the PR stays a draft until CI is green; " +
          "pass false only when the user explicitly wants a ready-for-review PR immediately.",
      },
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
      draft?: boolean;
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
          draft: args.draft ?? true,
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
      `State: ${pr.state}${pr.draft ? " (draft)" : ""}`,
      ...(branchLine ? [branchLine] : []),
      "",
      "Next: call github_pr_checks with wait_seconds (e.g. 300) to wait for CI. Fix any failing checks, " +
        "push, and re-check; mark the PR ready with github_update_pr (draft: false) only once every check is green.",
    ].join("\n");

    return makeOutput(content);
  },
};

// ─── github_pr_checks ────────────────────────────────────────────────────────

interface CheckRun {
  name: string;
  status: string;
  conclusion: string | null;
  details_url?: string | null;
  html_url?: string | null;
  output?: { title?: string | null; summary?: string | null } | null;
}

interface CommitStatus {
  context: string;
  state: string;
  target_url?: string | null;
  description?: string | null;
}

interface CheckEntry {
  name: string;
  detail: string;
  url?: string;
}

interface PrChecksSnapshot {
  number: number;
  url: string;
  sha: string;
  draft: boolean;
  headRef: string;
  baseRef: string;
  failing: CheckEntry[];
  pending: CheckEntry[];
  passing: CheckEntry[];
  neutral: CheckEntry[];
  total: number;
  notes: string[];
}

const NEUTRAL_CONCLUSIONS = new Set(["neutral", "skipped", "stale"]);

function snippet(text: string | null | undefined, max = 300): string {
  if (!text) return "";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

async function fetchPrChecks(owner: string, repo: string, number: number, token?: string): Promise<PrChecksSnapshot> {
  const pr = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`, token) as {
    html_url: string;
    draft?: boolean;
    head: { sha: string; ref: string };
    base: { ref: string };
  };
  const sha = pr.head.sha;
  const notes: string[] = [];

  let checkRuns: CheckRun[] = [];
  try {
    const data = await githubFetch(
      `/repos/${owner}/${repo}/commits/${sha}/check-runs?per_page=100&filter=latest`,
      token,
    ) as { check_runs?: CheckRun[] };
    checkRuns = data.check_runs ?? [];
  } catch (err) {
    notes.push(`Could not read check runs: ${formatError(err)}`);
  }

  let statuses: CommitStatus[] = [];
  try {
    const data = await githubFetch(`/repos/${owner}/${repo}/commits/${sha}/status`, token) as {
      statuses?: CommitStatus[];
    };
    statuses = data.statuses ?? [];
  } catch (err) {
    notes.push(`Could not read commit statuses: ${formatError(err)}`);
  }

  const failing: CheckEntry[] = [];
  const pending: CheckEntry[] = [];
  const passing: CheckEntry[] = [];
  const neutral: CheckEntry[] = [];
  const seen = new Set<string>();

  for (const run of checkRuns) {
    if (seen.has(run.name)) continue;
    seen.add(run.name);
    const url = run.details_url ?? run.html_url ?? undefined;
    if (run.status !== "completed") {
      pending.push({ name: run.name, detail: run.status, ...(url ? { url } : {}) });
      continue;
    }
    const conclusion = run.conclusion ?? "unknown";
    if (conclusion === "success") {
      passing.push({ name: run.name, detail: "success", ...(url ? { url } : {}) });
    } else if (NEUTRAL_CONCLUSIONS.has(conclusion)) {
      neutral.push({ name: run.name, detail: conclusion, ...(url ? { url } : {}) });
    } else {
      const summary = snippet(run.output?.summary) || snippet(run.output?.title);
      failing.push({
        name: run.name,
        detail: summary ? `${conclusion} — ${summary}` : conclusion,
        ...(url ? { url } : {}),
      });
    }
  }

  for (const status of statuses) {
    if (seen.has(status.context)) continue;
    seen.add(status.context);
    const url = status.target_url ?? undefined;
    if (status.state === "success") {
      passing.push({ name: status.context, detail: "success", ...(url ? { url } : {}) });
    } else if (status.state === "pending") {
      pending.push({ name: status.context, detail: "pending", ...(url ? { url } : {}) });
    } else {
      const summary = snippet(status.description);
      failing.push({
        name: status.context,
        detail: summary ? `${status.state} — ${summary}` : status.state,
        ...(url ? { url } : {}),
      });
    }
  }

  return {
    number,
    url: pr.html_url,
    sha,
    draft: pr.draft === true,
    headRef: pr.head.ref,
    baseRef: pr.base.ref,
    failing,
    pending,
    passing,
    neutral,
    total: failing.length + pending.length + passing.length + neutral.length,
    notes,
  };
}

function formatChecksReport(s: PrChecksSnapshot, waitedMs: number, waitSeconds: number): string {
  const counts = s.total === 0
    ? "no checks reported"
    : `${s.failing.length} failing, ${s.pending.length} pending, ${s.passing.length} passed`;
  const lines = [
    `PR #${s.number} — CI: ${counts}`,
    `URL: ${s.url}`,
    `Branch: ${s.headRef} → ${s.baseRef}`,
    `Head: ${s.sha.slice(0, 12)}`,
    `Draft: ${s.draft ? "yes" : "no"}`,
  ];
  if (waitedMs > 0) lines.push(`Waited ${Math.round(waitedMs / 1000)}s for checks to finish.`);
  for (const note of s.notes) lines.push(`Note: ${note}`);
  if (s.failing.length > 0) {
    lines.push("", "Failing checks:");
    for (const c of s.failing) lines.push(`  ✗ ${c.name} — ${c.detail}${c.url ? ` — ${c.url}` : ""}`);
  }
  if (s.pending.length > 0) {
    lines.push("", "Pending checks:");
    for (const c of s.pending) lines.push(`  … ${c.name} — ${c.detail}${c.url ? ` — ${c.url}` : ""}`);
  }
  if (s.neutral.length > 0) {
    lines.push("", `Skipped/neutral: ${s.neutral.map((c) => c.name).join(", ")}`);
  }
  lines.push("");
  if (s.failing.length > 0) {
    lines.push(
      "Next: fix the failing checks, push the fix, then call github_pr_checks again. " +
        "Do not mark the PR ready while any check fails.",
    );
  } else if (s.pending.length > 0) {
    lines.push(
      `Next: checks are still running. Call github_pr_checks again with wait_seconds: ${Math.max(60, waitSeconds || 300)} to keep waiting.`,
    );
  } else if (s.total === 0) {
    lines.push(
      "Next: no CI checks have reported for this commit yet. If the repository runs CI, " +
        "call github_pr_checks again with wait_seconds: 300 to wait for them; if it has no CI, " +
        "mark the PR ready with github_update_pr (draft: false).",
    );
  } else {
    lines.push("All checks passed. Mark the PR ready for review with github_update_pr (draft: false).");
  }
  return lines.join("\n");
}

interface PrChecksArgs {
  owner: string;
  repo: string;
  number: number;
  wait_seconds?: number;
  poll_interval_seconds?: number;
}

const MAX_CHECK_WAIT_SECONDS = 600;
const DEFAULT_CHECK_POLL_SECONDS = 15;

export const githubPrChecksTool: ToolSpec<PrChecksArgs> = {
  name: "github_pr_checks",
  description:
    "Check the CI status of a pull request: failing, pending, and passing checks for its head commit. " +
    "Set wait_seconds to poll until the checks finish (CI often takes several minutes), up to 600 seconds. " +
    "Call this after github_create_pr and after every push; fix failing checks before marking the PR ready.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      number: { type: "integer", description: "Pull request number.", minimum: 1 },
      wait_seconds: {
        type: "integer",
        minimum: 0,
        maximum: MAX_CHECK_WAIT_SECONDS,
        description: "Poll until checks finish, up to 600 seconds. Default: 0 (single snapshot).",
      },
      poll_interval_seconds: {
        type: "integer",
        minimum: 1,
        maximum: 60,
        description: "How often to re-check while waiting. Default: 15.",
      },
    },
    required: ["owner", "repo", "number"],
    additionalProperties: false,
  },
  needsPermission: false,
  render: (args) => ({ title: `GitHub CI ${args.owner ?? ""}/${args.repo ?? ""}#${args.number ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    const waitSeconds = clamp(args.wait_seconds ?? 0, 0, MAX_CHECK_WAIT_SECONDS);
    const pollSeconds = clamp(args.poll_interval_seconds ?? DEFAULT_CHECK_POLL_SECONDS, 1, 60);
    const deadline = Date.now() + waitSeconds * 1000;

    let snapshot = await fetchPrChecks(args.owner, args.repo, args.number, token);
    let waitedMs = 0;
    while (
      waitSeconds > 0 &&
      (snapshot.pending.length > 0 || snapshot.total === 0) &&
      Date.now() < deadline
    ) {
      const sleepMs = Math.min(pollSeconds * 1000, deadline - Date.now());
      await sleepWithSignal(sleepMs, ctx.signal);
      waitedMs += sleepMs;
      snapshot = await fetchPrChecks(args.owner, args.repo, args.number, token);
    }

    return makeOutput(formatChecksReport(snapshot, waitedMs, waitSeconds));
  },
};

// ─── github_update_pr ────────────────────────────────────────────────────────

interface UpdatePrArgs {
  owner: string;
  repo: string;
  number: number;
  draft?: boolean;
  title?: string;
  body?: string;
  force?: boolean;
}

async function setDraftState(
  owner: string,
  repo: string,
  number: number,
  draft: boolean,
  token?: string,
): Promise<{ changed: boolean }> {
  const pr = await githubFetch(`/repos/${owner}/${repo}/pulls/${number}`, token) as {
    node_id?: string;
    draft?: boolean;
  };
  if (pr.draft === draft) return { changed: false };

  if (!pr.node_id) {
    throw new Error(`Cannot change draft state for PR #${number}: GitHub returned no node ID.`);
  }

  const mutation = draft ? "convertPullRequestToDraft" : "markPullRequestReadyForReview";
  const data = await githubGraphql(
    `mutation($id: ID!) { ${mutation}(input: { pullRequestId: $id }) { pullRequest { isDraft } } }`,
    { id: pr.node_id },
    token,
  );
  const result = data[mutation] as { pullRequest?: { isDraft?: boolean } } | null | undefined;
  if (result?.pullRequest?.isDraft !== draft) {
    throw new Error(`GitHub did not confirm the requested draft state for PR #${number}.`);
  }
  return { changed: true };
}

export const githubUpdatePrTool: ToolSpec<UpdatePrArgs> = {
  name: "github_update_pr",
  description:
    "Update a pull request: mark it ready for review (draft: false) or convert it back to a draft, " +
    "and optionally change its title or body. Refuses to mark a PR ready while its CI checks are failing " +
    "unless force is true.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      number: { type: "integer", description: "Pull request number.", minimum: 1 },
      draft: { type: "boolean", description: "true converts the PR to a draft; false marks it ready for review." },
      title: { type: "string", description: "New pull request title." },
      body: { type: "string", description: "New pull request description (markdown supported)." },
      force: {
        type: "boolean",
        description: "Mark ready even though CI is failing. Only when the user explicitly asks for it.",
      },
    },
    required: ["owner", "repo", "number"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({ title: `Update PR ${args.owner ?? ""}/${args.repo ?? ""}#${args.number ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    const changes: string[] = [];

    if (args.draft === false && args.force !== true) {
      const snapshot = await fetchPrChecks(args.owner, args.repo, args.number, token);
      if (snapshot.failing.length > 0) {
        return makeOutput([
          `Refusing to mark PR #${args.number} ready: ${snapshot.failing.length} CI check(s) are failing ` +
            `(${snapshot.failing.map((c) => c.name).join(", ")}).`,
          "Fix the failures, push, and re-run github_pr_checks. Pass force: true only if the user explicitly " +
            "wants the PR ready despite failing CI.",
        ].join("\n"));
      }
      if (snapshot.pending.length > 0) {
        changes.push(`warning: ${snapshot.pending.length} check(s) still running`);
      }
    }

    if (args.draft !== undefined) {
      const result = await setDraftState(args.owner, args.repo, args.number, args.draft, token);
      changes.push(
        result.changed
          ? (args.draft ? "converted to draft" : "marked ready for review")
          : `already ${args.draft ? "a draft" : "ready for review"}`,
      );
    }

    if (args.title !== undefined || args.body !== undefined) {
      const patch: Record<string, unknown> = {};
      if (args.title !== undefined) patch.title = args.title;
      if (args.body !== undefined) patch.body = args.body;
      await githubPost(`/repos/${args.owner}/${args.repo}/pulls/${args.number}`, patch, token, "PATCH");
      changes.push(args.title !== undefined ? "title updated" : "body updated");
    }

    if (changes.length === 0) {
      return makeOutput("Nothing to update: provide draft, title, or body.");
    }
    return makeOutput(`Updated PR #${args.number}: ${changes.join("; ")}.`);
  },
};
