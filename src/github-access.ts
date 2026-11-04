/**
 * GitHub access at the first pull request. When the agent pushes a branch or
 * opens a pull request and it fails for want of GitHub access (no
 * GITHUB_TOKEN/GH_TOKEN, no saved sign-in, gh not signed in), the session
 * asks instead of showing the raw error:
 *
 *   To push a branch and open a pull request, dl needs GitHub access.
 *   › Sign in with GitHub in the browser
 *     I'll set GITHUB_TOKEN myself
 *     Not now (keep the changes on a local branch)
 *
 * Signing in runs `gh auth login --web --git-protocol https` (its one-time
 * code and URL shown), then the push or pull request is tried once more.
 * "Not now" tells the model the pull request wasn't opened, so it reports
 * that instead of failing. Headless runs and `-p` have no one to ask: they
 * get one clear line instead.
 *
 * Renderer-free so it can be tested: the executor supplies the tool run,
 * the Camouflage view the prompts.
 */

import type { ToolContext, ToolOutput } from "./tools/registry.js";
import { createsGhPr } from "./util/pr-footer.js";
import { launchedByDl } from "./util/env.js";
import { ghStatus, runGh, type GhDeviceCode, type GhLogin, type GhRun } from "./util/gh-cli.js";

export type GithubOperation = "push" | "pr";

/** What the person chose: signed in (try again), they'll set a token, or not now. */
export type GithubAccessOutcome = "signed-in" | "token" | "not-now";

export interface GithubAccessRequest {
  op: GithubOperation;
}

export type GithubAccessAsker = (req: GithubAccessRequest) => Promise<GithubAccessOutcome>;

/** `git push` anywhere in a command (with or without `-C <dir>` or `-c k=v`). */
const GIT_PUSH = /(^|[\s;&|(])git\s+(?:-[Cc]\s+\S+\s+)*push\b/;

/** Whether a tool call pushes a branch or opens a pull request. */
export function githubOperation(tool: string, args: Record<string, unknown>): GithubOperation | undefined {
  if (tool === "github_create_pr") return "pr";
  if (tool !== "bash" || typeof args.command !== "string") return undefined;
  if (createsGhPr(args.command)) return "pr";
  if (GIT_PUSH.test(args.command)) return "push";
  return undefined;
}

/** A GitHub token from the session (saved sign-in), the environment, or `gh auth token`. */
export async function hasGithubToken(
  ctx: Pick<ToolContext, "githubToken">,
  o: { env?: NodeJS.ProcessEnv; gh?: GhRun } = {},
): Promise<boolean> {
  const env = o.env ?? process.env;
  if (ctx.githubToken || env.GITHUB_TOKEN || env.GH_TOKEN) return true;
  return (await ghStatus(o.gh ?? runGh).catch(() => "missing" as const)) === "signed-in";
}

/** The call failed: a non-zero exit (bash), or github_create_pr's failure text. */
export function operationFailed(tool: string, out: ToolOutput): boolean {
  if (tool === "github_create_pr") return /^Failed to (?:create PR|determine default branch)/.test(out.content);
  const exit = out.meta?.exitCode;
  if (typeof exit === "number") return exit !== 0;
  const m = /^exit=(-?\d+)/.exec(out.content);
  return !!m && Number(m[1]) !== 0;
}

/**
 * Output that says GitHub access is missing: gh not signed in or not
 * installed, the API asking for authentication, or git unable to
 * authenticate to github.com over HTTPS. (An SSH key problem isn't one: a
 * GitHub sign-in wouldn't fix it.)
 */
export function looksLikeMissingGithubAccess(output: string): boolean {
  if (/gh auth login/.test(output)) return true;
  if (/\bgh: (?:command )?not found|command not found: gh\b|spawn gh ENOENT|'gh' is not recognized/.test(output)) return true;
  if (/GitHub API 401|Bad credentials|Requires authentication/.test(output)) return true;
  const https = /https:\/\/(?:[^\s'"@]+@)?github\.com/.test(output);
  return https && /could not read (?:Username|Password)|Authentication failed|terminal prompts disabled|Invalid username or (?:password|token)|Password authentication is not supported/i.test(output);
}

export const GITHUB_ACCESS_HEADLESS_LINE =
  "No GitHub access: set GITHUB_TOKEN (or GH_TOKEN), or install the GitHub CLI and run `gh auth login`, then try again.";

function output(content: string): ToolOutput {
  const bytes = Buffer.byteLength(content, "utf8");
  return { content, rawBytes: bytes, reducedBytes: bytes };
}

/** What the model is told when the person didn't give access. */
export function notOpenedNote(op: GithubOperation, outcome: Exclude<GithubAccessOutcome, "signed-in">): string {
  const what = op === "pr" ? "The pull request wasn't opened" : "The branch wasn't pushed and no pull request was opened";
  const why =
    outcome === "token"
      ? "there's no GitHub access yet, and the user will set GITHUB_TOKEN themselves"
      : "there's no GitHub access, and the user chose not to set it up now";
  const next =
    outcome === "token"
      ? "Tell the user the work is on a local branch and the pull request wasn't opened yet; once GITHUB_TOKEN is set they can ask you to push it and open the pull request."
      : "Tell the user the work is on a local branch and the pull request wasn't opened.";
  return `[autopilot] ${what}: ${why}. Keep the changes on the local branch (commit them there if they aren't committed yet). Don't push or open a pull request again in this task. ${next}`;
}

/**
 * Run a tool call that may push or open a pull request. When it fails for
 * want of GitHub access and there is no token: ask (interactive sessions),
 * and after a sign-in try once more; otherwise add one clear line.
 */
export async function runWithGithubAccess(
  tool: string,
  args: Record<string, unknown>,
  ctx: Pick<ToolContext, "githubToken" | "askGithubAccess" | "signal">,
  run: () => Promise<string | ToolOutput>,
  o: { env?: NodeJS.ProcessEnv; gh?: GhRun } = {},
): Promise<string | ToolOutput> {
  const op = githubOperation(tool, args);
  const first = await run();
  if (!op) return first;
  const out = typeof first === "string" ? output(first) : first;
  if (!operationFailed(tool, out) || out.meta?.aborted || ctx.signal?.aborted) return first;
  if (!looksLikeMissingGithubAccess(out.content)) return first;
  if (await hasGithubToken(ctx, o)) return first;
  if (!ctx.askGithubAccess) return output(`${out.content}\n\n${GITHUB_ACCESS_HEADLESS_LINE}`);
  const outcome = await ctx.askGithubAccess({ op }).catch(() => "not-now" as const);
  if (outcome === "signed-in") return run();
  return output(notOpenedNote(op, outcome));
}

// ── The prompt ───────────────────────────────────────────────────────────

export const GITHUB_SIGN_IN = "signin";
export const GITHUB_TOKEN_SELF = "token";
export const GITHUB_NOT_NOW = "not-now";

/** "To push a branch and open a pull request, dl needs GitHub access." */
export function githubAccessTitle(env: NodeJS.ProcessEnv = process.env): string {
  return `To push a branch and open a pull request, ${launchedByDl(env) ? "dl" : "Autopilot"} needs GitHub access.`;
}

export function githubAccessOptions(o: { signIn: boolean } = { signIn: true }): { value: string; label: string }[] {
  return [
    ...(o.signIn ? [{ value: GITHUB_SIGN_IN, label: "Sign in with GitHub in the browser" }] : []),
    { value: GITHUB_TOKEN_SELF, label: "I'll set GITHUB_TOKEN myself" },
    { value: GITHUB_NOT_NOW, label: "Not now (keep the changes on a local branch)" },
  ];
}

export const GH_INSTALL_LINE =
  "Signing in uses the GitHub CLI (gh), which isn't installed: `brew install gh` on macOS, or see https://github.com/cli/cli/blob/trunk/docs/install_linux.md on Linux.";

export function githubTokenHelpLine(env: NodeJS.ProcessEnv = process.env): string {
  return `Create a token with repo access at https://github.com/settings/tokens, set GITHUB_TOKEN to it, and start ${launchedByDl(env) ? "dl" : "Autopilot"} again. The changes stay on a local branch until then.`;
}

export const GITHUB_SIGNED_IN_LINE = "✓ Signed in to GitHub. Trying again…";
export const GITHUB_NOT_NOW_LINE = "OK: the changes stay on a local branch.";

/** The waiting line while gh's browser sign-in runs. */
export function ghWaitingText(c: GhDeviceCode, opened: boolean): string {
  return `First copy your one-time code: ${c.code}\n${opened ? `Opened ${c.url} in your browser` : `Then open ${c.url} in a browser`} and paste it there. Waiting for the sign-in… Esc to cancel`;
}

export interface GithubAccessDeps {
  select: (title: string, options: { value: string; label: string }[], subtitle?: string) => Promise<string | null>;
  say: (message: string, severity?: "info" | "error") => void;
  /** Show the waiting text until the returned function is called (null: it was said instead). `cancel` is Esc. */
  wait: (text: string, cancel: () => void) => Promise<(() => void) | null>;
  openBrowser: (url: string) => boolean;
  gh?: GhRun;
  login: GhLogin;
  env?: NodeJS.ProcessEnv;
}

/** Ask, and sign in with gh when chosen. A failed or cancelled sign-in asks again. */
export async function runGithubAccess(deps: GithubAccessDeps): Promise<GithubAccessOutcome> {
  const gh = deps.gh ?? runGh;
  const title = githubAccessTitle(deps.env);
  const subtitle = "Enter to choose · Esc for not now";
  let signIn = true;
  for (;;) {
    const choice = await deps.select(title, githubAccessOptions({ signIn }), subtitle);
    if (choice === GITHUB_TOKEN_SELF) {
      deps.say(githubTokenHelpLine(deps.env));
      return "token";
    }
    if (choice !== GITHUB_SIGN_IN) {
      deps.say(GITHUB_NOT_NOW_LINE);
      return "not-now";
    }
    if ((await ghStatus(gh).catch(() => "missing" as const)) === "missing") {
      deps.say(GH_INSTALL_LINE);
      signIn = false;
      continue;
    }
    const ctrl = new AbortController();
    let end: (() => void) | null = null;
    let waiting: Promise<void> = Promise.resolve();
    const result = await deps.login({
      signal: ctrl.signal,
      onCode: (c) => {
        const opened = deps.openBrowser(c.url);
        waiting = deps.wait(ghWaitingText(c, opened), () => ctrl.abort()).then((e) => void (end = e));
      },
    });
    await waiting;
    (end as (() => void) | null)?.();
    if (result.ok) {
      // So `git push` over HTTPS uses the sign-in too.
      await gh(["auth", "setup-git"], { timeoutMs: 10_000 }).catch(() => null);
      deps.say(GITHUB_SIGNED_IN_LINE);
      return "signed-in";
    }
    deps.say(ctrl.signal.aborted ? "GitHub sign-in cancelled." : `GitHub sign-in didn't finish${result.message ? `: ${result.message}` : "."}`, ctrl.signal.aborted ? "info" : "error");
  }
}
