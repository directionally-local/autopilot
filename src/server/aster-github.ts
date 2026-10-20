/**
 * Minimal GitHub REST client for Aster. The token (a fine-grained PAT in
 * `GITHUB_TOKEN`) stays on the control-plane host and is never forwarded to a cell.
 */

export interface AsterRepository {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  description: string | null;
  defaultBranch: string;
  updatedAt: string | null;
}

export interface AsterPullRequest {
  number: number;
  url: string;
  title: string;
  state: "open" | "closed";
  headBranch: string;
  baseBranch: string;
  merged: boolean;
}

export interface AsterCheckRun {
  id: number;
  name: string;
  status: string;
  conclusion: string | null;
  url: string | null;
}

export class AsterGitHubError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
    this.name = "AsterGitHubError";
  }
}

export const REPOSITORY_FULL_NAME_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const REPOSITORY_NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const API = "https://api.github.com";

type GitHubMethod = "GET" | "POST" | "PUT" | "PATCH";

interface RawRepository {
  full_name: string;
  name: string;
  owner?: { login?: string };
  private: boolean;
  description: string | null;
  default_branch?: string;
  pushed_at?: string | null;
  updated_at?: string | null;
}

interface RawPullRequest {
  number: number;
  html_url: string;
  title: string;
  state: "open" | "closed";
  merged_at: string | null;
  head: { ref: string };
  base: { ref: string };
}

interface RawCheckRuns {
  check_runs: Array<{ id: number; name: string; status: string; conclusion: string | null; html_url?: string | null }>;
}

export class AsterGitHub {
  constructor(
    private readonly token: string | undefined = process.env.GITHUB_TOKEN,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  get configured(): boolean {
    return Boolean(this.token?.trim());
  }

  /** Repositories the token can push to, most recently pushed first. */
  async listRepositories(query = ""): Promise<AsterRepository[]> {
    const raw = await this.request<RawRepository[]>(
      "GET",
      "/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member",
    );
    const needle = query.trim().toLowerCase();
    return raw
      .map(mapRepository)
      .filter((repo) => !needle || repo.fullName.toLowerCase().includes(needle) || (repo.description ?? "").toLowerCase().includes(needle));
  }

  async getRepository(fullName: string): Promise<AsterRepository> {
    if (!REPOSITORY_FULL_NAME_RE.test(fullName)) throw new AsterGitHubError("Invalid repository name", 400, "invalid_repository");
    return mapRepository(await this.request<RawRepository>("GET", `/repos/${fullName}`));
  }

  /** Creates a repository under the token's user, initialized so it has a default branch to clone. */
  async createRepository(input: { name: string; private: boolean; description?: string }): Promise<AsterRepository> {
    if (!REPOSITORY_NAME_RE.test(input.name) || input.name === "." || input.name === "..") {
      throw new AsterGitHubError("Repository names may use letters, digits, '.', '_' and '-'", 400, "invalid_repository_name");
    }
    const description = input.description?.trim().slice(0, 350);
    return mapRepository(await this.request<RawRepository>("POST", "/user/repos", {
      name: input.name,
      private: input.private,
      auto_init: true,
      ...(description ? { description } : {}),
    }));
  }

  async createPullRequest(
    repository: string,
    input: { title: string; body: string; head: string; base: string },
  ): Promise<AsterPullRequest> {
    this.validatePullRequestInput(repository, input);
    const raw = await this.request<RawPullRequest>("POST", `/repos/${repository}/pulls`, {
      title: input.title.trim().slice(0, 256),
      body: input.body.trim().slice(0, 50_000),
      head: input.head,
      base: input.base,
    });
    return mapPullRequest(raw);
  }

  async getPullRequest(repository: string, number: number): Promise<AsterPullRequest> {
    this.validatePullRequestNumber(repository, number);
    return mapPullRequest(await this.request<RawPullRequest>("GET", `/repos/${repository}/pulls/${number}`));
  }

  async listChecks(repository: string, ref: string): Promise<AsterCheckRun[]> {
    this.validateRepository(repository);
    if (!ref.trim() || ref.length > 200) throw new AsterGitHubError("Invalid GitHub ref", 400, "invalid_ref");
    const raw = await this.request<RawCheckRuns>(
      "GET",
      `/repos/${repository}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100`,
    );
    return raw.check_runs.map((run) => ({
      id: run.id,
      name: run.name,
      status: run.status,
      conclusion: run.conclusion,
      url: run.html_url ?? null,
    }));
  }

  async mergePullRequest(repository: string, number: number): Promise<{ merged: boolean; message: string; sha?: string }> {
    this.validatePullRequestNumber(repository, number);
    try {
      const result = await this.request<{ merged: boolean; message: string; sha?: string }>(
        "PUT",
        `/repos/${repository}/pulls/${number}/merge`,
        { merge_method: "squash" },
      );
      if (!result.merged) throw new AsterGitHubError(result.message || "GitHub did not merge the pull request", 409, "pull_request_not_merged");
      return result;
    } catch (error) {
      if (error instanceof AsterGitHubError && error.status === 409) {
        const existing = await this.getPullRequest(repository, number).catch(() => undefined);
        if (existing?.merged) return { merged: true, message: "Pull request was already merged" };
      }
      throw error;
    }
  }

  async closePullRequest(repository: string, number: number): Promise<AsterPullRequest> {
    this.validatePullRequestNumber(repository, number);
    return mapPullRequest(await this.request<RawPullRequest>("PATCH", `/repos/${repository}/pulls/${number}`, { state: "closed" }));
  }

  private validatePullRequestInput(repository: string, input: { title: string; body: string; head: string; base: string }): void {
    this.validateRepository(repository);
    if (!input.title.trim() || input.title.length > 256 || input.body.length > 50_000
      || !isValidBranch(input.head) || !isValidBranch(input.base)) {
      throw new AsterGitHubError("Invalid pull request title, body, or branch", 400, "invalid_pull_request");
    }
  }

  private validatePullRequestNumber(repository: string, number: number): void {
    this.validateRepository(repository);
    if (!Number.isSafeInteger(number) || number < 1) throw new AsterGitHubError("Invalid pull request number", 400, "invalid_pull_request_number");
  }

  private validateRepository(repository: string): void {
    if (!REPOSITORY_FULL_NAME_RE.test(repository)) throw new AsterGitHubError("Invalid repository name", 400, "invalid_repository");
  }

  private async request<T>(method: GitHubMethod, path: string, body?: unknown): Promise<T> {
    if (!this.configured) throw new AsterGitHubError("GitHub is not connected on the server", 503, "github_not_configured");
    let response: Response;
    try {
      response = await this.fetchImpl(API + path, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "autopilot-aster",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch {
      throw new AsterGitHubError("GitHub could not be reached", 502, "github_unreachable");
    }
    if (response.ok) return await response.json() as T;
    const detail = await response.json().catch(() => ({})) as { message?: string; errors?: Array<{ message?: string }> };
    const message = detail.errors?.[0]?.message ?? detail.message ?? `GitHub returned HTTP ${response.status}`;
    if (response.status === 404) throw new AsterGitHubError("Repository or pull request not found or not accessible with the server's GitHub token", 404, "repository_not_found");
    if (response.status === 401) throw new AsterGitHubError("The server's GitHub token was rejected", 502, "github_token_rejected");
    if (response.status === 403) throw new AsterGitHubError(`GitHub refused the request: ${message}`, 403, "github_forbidden");
    if (response.status === 409 || response.status === 405) throw new AsterGitHubError(message, 409, "github_conflict");
    if (response.status === 422) throw new AsterGitHubError(message, 422, "github_validation_failed");
    throw new AsterGitHubError(message, 502, "github_error");
  }
}

function isValidBranch(branch: string): boolean {
  return BRANCH_RE.test(branch)
    && !branch.startsWith("-")
    && !branch.endsWith("/")
    && !branch.includes("..")
    && !branch.includes("//")
    && !branch.includes("@{")
    && branch.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.endsWith(".lock"));
}

function mapRepository(raw: RawRepository): AsterRepository {
  return {
    fullName: raw.full_name,
    name: raw.name,
    owner: raw.owner?.login ?? raw.full_name.split("/")[0] ?? "",
    private: raw.private,
    description: raw.description,
    defaultBranch: raw.default_branch ?? "main",
    updatedAt: raw.pushed_at ?? raw.updated_at ?? null,
  };
}

function mapPullRequest(raw: RawPullRequest): AsterPullRequest {
  return {
    number: raw.number,
    url: raw.html_url,
    title: raw.title,
    state: raw.state,
    headBranch: raw.head.ref,
    baseBranch: raw.base.ref,
    merged: raw.merged_at !== null,
  };
}
