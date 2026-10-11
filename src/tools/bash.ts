import { spawn } from "node:child_process";
import { tmpdir, platform } from "node:os";
import { join } from "node:path";
import type { ToolSpec, ToolContext, ToolOutput } from "./registry.js";
import { logger } from "../util/logger.js";
import { getUserAgent } from "../util/version.js";
import { interactiveCommandHint, userShellCommandsEnabled } from "../agent/user-shell.js";

interface Args {
  command: string;
  timeout_ms?: number;
}

const DEFAULT_TIMEOUT = 120_000;
const MAX_TIMEOUT = 600_000;

export interface ShellCommand {
  shell: string;
  args: string[];
  isPosix: boolean;
}

/**
 * Resolve the shell to use for executing commands.
 *
 * Priority:
 * 1. Explicit `override` (from config or ToolContext)
 * 2. Platform auto-detection when override is "auto" or undefined
 *
 * Supported named values:
 * - "bash"        → bash -lc
 * - "cmd"         → cmd /c
 * - "powershell"  → powershell -Command
 * - "auto"        → platform detection
 *
 * Any absolute path is treated as a custom shell. The flag is guessed from
 * the basename: bash/sh/zsh/fish → -lc, cmd → /c, powershell/pwsh → -Command.
 */
export function getShellCommand(override?: string): ShellCommand {
  const raw = override?.trim();

  if (raw && raw !== "auto") {
    const lower = raw.toLowerCase();

    if (lower === "bash") {
      return { shell: "bash", args: ["-lc"], isPosix: true };
    }
    if (lower === "cmd") {
      return { shell: process.env.COMSPEC || "cmd.exe", args: ["/c"], isPosix: false };
    }
    if (lower === "powershell") {
      return { shell: "powershell", args: ["-Command"], isPosix: false };
    }

    // Absolute path to a custom shell
    const base = lower.replace(/\\/g, "/").split("/").pop() || "";
    if (base.includes("cmd")) {
      return { shell: raw, args: ["/c"], isPosix: false };
    }
    if (base.includes("powershell") || base.includes("pwsh")) {
      return { shell: raw, args: ["-Command"], isPosix: false };
    }
    // Default to POSIX-style for unknown custom shells
    return { shell: raw, args: ["-lc"], isPosix: true };
  }

  // Auto-detect based on platform
  const isWindows = platform() === "win32";
  if (isWindows) {
    return { shell: process.env.COMSPEC || "cmd.exe", args: ["/c"], isPosix: false };
  }
  return { shell: "bash", args: ["-lc"], isPosix: true };
}

export const bashTool: ToolSpec<Args> = {
  name: "bash",
  description:
    "Run a shell command. On Unix the default shell is bash; on Windows it falls back to cmd.exe. Prompts the user for permission before executing. stdout and stderr are captured and combined. Large outputs are reduced to a compact summary by default; use expand_artifact to retrieve the full log.",
  parameters: {
    type: "object",
    properties: {
      command: { type: "string" },
      timeout_ms: {
        type: "integer",
        description: "Milliseconds. Default 120000, max 600000.",
        minimum: 1000,
        maximum: MAX_TIMEOUT,
      },
    },
    required: ["command"],
    additionalProperties: false,
  },
  needsPermission: true,
  render: (args) => ({ title: formatBashTitle(String(args.command ?? "")) }),
  run: (args, ctx) => runBash(args, ctx),
};

function formatBashTitle(raw: string): string {
  let cmd = (raw ?? "").trim();
  const m = cmd.match(/^cd\s+([^\s&;]+)\s*(?:&&|;)\s*(.*)$/);
  if (m) cmd = m[2]!.trim();
  return `$ ${cmd}`.slice(0, 120);
}

/**
 * Detect `git push` commands that would land on the repository's default branch
 * and block them unless direct pushes are explicitly allowed. Returns a blocked
 * ToolOutput when the push should not proceed; returns undefined otherwise.
 */
export async function guardGitPush(command: string, ctx: ToolContext): Promise<ToolOutput | undefined> {
  const trimmed = command.trim();
  if (!/\bgit\s+push\b/.test(trimmed)) return undefined;

  const allowed = ctx.allowDirectPush === true || process.env.KIMIFLARE_ALLOW_DIRECT_PUSH === "1";
  if (allowed) return undefined;

  const defaultBranch = await getDefaultBranch(ctx.cwd);
  if (!defaultBranch) return undefined; // not a git repo or no origin/HEAD

  const target = parsePushTarget(trimmed);
  if (!target) return undefined; // could not determine target — let git itself fail/succeed

  // --all / --mirror are treated conservatively: they may push the default branch.
  if (target.kind === "all" || target.kind === "mirror") {
    const hint = await getBranchProtectionHint(ctx.cwd, defaultBranch, ctx);
    const msg =
      `Blocked: \`${trimmed}\` may push the default branch (${defaultBranch}). ` +
      `Create a feature branch, push it, and open a PR with \`github_create_pr\`. ` +
      `To allow direct pushes, set \`allowDirectPush: true\` in config or run with \`KIMIFLARE_ALLOW_DIRECT_PUSH=1\`.` +
      (hint ? `\n${hint}` : "");
    return makeErrorOutput(msg);
  }

  const targetBranch = target.kind === "current" ? await getCurrentBranch(ctx.cwd) : target.ref;
  if (!targetBranch) return undefined;

  if (targetBranch === defaultBranch) {
    const hint = await getBranchProtectionHint(ctx.cwd, defaultBranch, ctx);
    const msg =
      `Blocked: \`${trimmed}\` would push directly to the default branch (${defaultBranch}). ` +
      `Create a feature branch, push it, and open a PR with \`github_create_pr\`. ` +
      `To allow direct pushes, set \`allowDirectPush: true\` in config or run with \`KIMIFLARE_ALLOW_DIRECT_PUSH=1\`.` +
      (hint ? `\n${hint}` : "");
    return makeErrorOutput(msg);
  }

  return undefined;
}

function makeErrorOutput(message: string): ToolOutput {
  const bytes = Buffer.byteLength(message, "utf8");
  return { content: message, rawBytes: bytes, reducedBytes: bytes };
}

async function execOnce(command: string, cwd: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], { cwd });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
    });
    child.on("close", (code) => {
      if (code !== 0) return resolve(undefined);
      resolve(out.trim() || undefined);
    });
  });
}

async function getDefaultBranch(cwd: string): Promise<string | undefined> {
  const raw = await execOnce("git rev-parse --abbrev-ref origin/HEAD 2>/dev/null || true", cwd);
  if (!raw) return undefined;
  const match = raw.match(/^origin\/(\S+)$/);
  return match?.[1];
}

async function getCurrentBranch(cwd: string): Promise<string | undefined> {
  return execOnce("git rev-parse --abbrev-ref HEAD 2>/dev/null || true", cwd);
}

interface GitHubRepo {
  owner: string;
  repo: string;
}

/**
 * Parse the origin remote URL into owner/repo when it points to GitHub.
 * Handles HTTPS and SSH formats.
 */
async function getGitHubRemote(cwd: string): Promise<GitHubRepo | undefined> {
  const url = await execOnce("git remote get-url origin 2>/dev/null || true", cwd);
  if (!url) return undefined;

  const httpsMatch = url.match(/^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (httpsMatch) {
    return { owner: httpsMatch[1]!, repo: httpsMatch[2]! };
  }

  const sshMatch = url.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) {
    return { owner: sshMatch[1]!, repo: sshMatch[2]! };
  }

  return undefined;
}

function getGitHubToken(ctx: ToolContext): string | undefined {
  return ctx.githubToken || process.env.GITHUB_TOKEN || process.env.GH_TOKEN;
}

/**
 * Check whether the given branch on a GitHub repo has protection rules.
 * Returns true if protected, false if unprotected, and undefined if we
 * can't tell (no token, network error, not GitHub, etc.).
 */
async function isBranchProtected(owner: string, repo: string, branch: string, token?: string): Promise<boolean | undefined> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": getUserAgent(),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches/${branch}/protection`, {
      signal: controller.signal,
      headers,
    });

    if (res.status === 404) return false; // no protection rules
    if (res.ok) return true;
    return undefined; // other error — don't nag
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Return a gentle hint when the default branch appears unprotected on GitHub.
 * Returns undefined when protected, not a GitHub repo, or when we can't tell.
 */
async function getBranchProtectionHint(cwd: string, branch: string, ctx: ToolContext): Promise<string | undefined> {
  const gh = await getGitHubRemote(cwd);
  if (!gh) return undefined;

  const token = getGitHubToken(ctx);
  const protected_ = await isBranchProtected(gh.owner, gh.repo, branch, token);
  if (protected_ === false) {
    return `Tip: \`${branch}\` doesn't have branch protection rules on GitHub yet. ` +
      `You may want to enable them to prevent accidental direct pushes. ` +
      `Want guidance on setting them up? Just ask.`;
  }
  return undefined;
}

export type PushTarget = { kind: "current" } | { kind: "ref"; ref: string } | { kind: "all" } | { kind: "mirror" };

export function parsePushTarget(command: string): PushTarget | undefined {
  // Strip common shell wrappers so we can look at the git push tokens.
  const stripped = command.replace(/^\s*(?:\(.*\)\s*&&\s*)?/, "").trim();
  const tokens = stripped.split(/\s+/);
  // tokens[0] = git, tokens[1] = push
  if (tokens[0] !== "git" || tokens[1] !== "push") return undefined;

  let i = 2;
  const options = new Set<string>();
  const positional: string[] = [];

  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok === "--") {
      i++;
      while (i < tokens.length) {
        positional.push(tokens[i]!);
        i++;
      }
      break;
    }
    if (tok.startsWith("-")) {
      if (tok === "--all") options.add("all");
      else if (tok === "--mirror") options.add("mirror");
      else if (tok === "--delete" || tok === "-d") options.add("delete");
      // option may consume next token as its value
      const needsArg = /^-[A-Za-z]$/.test(tok) && !/[dutq]/.test(tok.charAt(1));
      i++;
      if (needsArg && i < tokens.length) i++;
      continue;
    }
    positional.push(tok);
    i++;
  }

  if (options.has("all")) return { kind: "all" };
  if (options.has("mirror")) return { kind: "mirror" };

  // positional: [remote] [refspec ...]
  const refspecs = positional.slice(1);
  if (refspecs.length === 0) return { kind: "current" };

  // Use the last refspec; for `git push origin src:dst` we care about dst.
  const last = refspecs[refspecs.length - 1]!;
  if (last.includes(":")) {
    const dst = last.split(":").pop()!;
    if (!dst) return { kind: "current" }; // e.g. ":branch" is delete
    return { kind: "ref", ref: dst.replace(/^\+/, "").replace(/^refs\/heads\//, "") };
  }
  return { kind: "ref", ref: last.replace(/^refs\/heads\//, "") };
}

/** Env vars that carry co-author data into the generated shell. The script
 *  text never contains configured values: config/env data must never become
 *  shell program text (#716). */
const COAUTHOR_TRAILER_ENV = "KF_COAUTHOR_TRAILER";
const COAUTHOR_MSG_ENV = "KF_COAUTHOR_MSG";

/** Static: references the trailer and temp file only via quoted expansions,
 *  and removes the temp file whether or not the amend succeeds. */
const AMEND_BLOCK = [
  `if ! git log -1 --pretty=%B 2>/dev/null | grep -qF -- "$${COAUTHOR_TRAILER_ENV}"; then`,
  `  git log -1 --pretty=%B | git interpret-trailers --trailer "$${COAUTHOR_TRAILER_ENV}" > "$${COAUTHOR_MSG_ENV}" && git commit --amend -F "$${COAUTHOR_MSG_ENV}" --no-edit; _KF_RC=$?;`,
  `  rm -f "$${COAUTHOR_MSG_ENV}"; [ $_KF_RC -eq 0 ];`,
  `fi`,
].join("\n");

/** Build the trailer, or null when a value could corrupt the commit message
 *  (line breaks add extra trailers) or contains other control characters. */
export function buildCoauthorTrailer(coauthor: { name: string; email: string }): string | null {
  // eslint-disable-next-line no-control-regex
  const unsafe = /[\u0000-\u001f\u007f\u2028\u2029]/;
  if (unsafe.test(coauthor.name) || unsafe.test(coauthor.email)) return null;
  const name = coauthor.name.trim();
  const email = coauthor.email.trim();
  if (!name || !email || /[<>]/.test(email)) return null;
  return `Co-authored-by: ${name} <${email}>`;
}

/** Wrap a command so commits it creates carry the co-author trailer. Returns
 *  the command plus env vars the caller must pass to the shell. */
export function injectCoauthor(
  command: string,
  coauthor?: { name: string; email: string },
): { command: string; env: Record<string, string> } {
  const unchanged = { command, env: {} };
  if (!coauthor) return unchanged;
  const trailer = buildCoauthorTrailer(coauthor);
  if (!trailer) {
    logger.warn("bash:coauthor_rejected", { reason: "empty value, control character, or line break in co-author name/email" });
    return unchanged;
  }

  const trimmed = command.trim();
  if (command.includes(trailer)) return unchanged;

  // Detect git commands that create commits
  const createsCommit = /\bgit\s+(commit|merge|revert|cherry-pick)\b/.test(trimmed);
  const isRebaseContinue = /\bgit\s+rebase\b/.test(trimmed) && !/\b--abort\b|\b--skip\b/.test(trimmed);
  const movesHeadOnly = /\bgit\s+(reset|checkout|switch)\b/.test(trimmed);
  const mentionsGit = /\bgit\b/.test(trimmed);

  if (!createsCommit && !isRebaseContinue && !mentionsGit) return unchanged;
  if (movesHeadOnly) return unchanged;

  const env = {
    [COAUTHOR_TRAILER_ENV]: trailer,
    [COAUTHOR_MSG_ENV]: join(tmpdir(), `kf-coauthor-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
  };

  if (createsCommit || isRebaseContinue) {
    // Primary path: known commit-creating command — amend immediately after success
    return { command: `(${command}) && { ${AMEND_BLOCK}\n}`, env };
  }

  // Safety net: command mentions git but isn't obviously commit-creating
  // (e.g., a script or Makefile that calls git internally).
  // Record HEAD before and after; amend if a new commit lacks the trailer.
  const beforeHead = `git rev-parse HEAD 2>/dev/null || echo "NO_HEAD"`;
  const afterCheck = [
    `_KF_AFTER_HEAD=$(git rev-parse HEAD 2>/dev/null || echo "NO_HEAD")`,
    `if [ "$_KF_BEFORE_HEAD" != "$_KF_AFTER_HEAD" ] && [ "$_KF_AFTER_HEAD" != "NO_HEAD" ] && git merge-base --is-ancestor "$_KF_BEFORE_HEAD" "$_KF_AFTER_HEAD" 2>/dev/null; then`,
    AMEND_BLOCK,
    `fi`,
  ].join("\n");
  return {
    command: `_KF_BEFORE_HEAD=$(${beforeHead}); (${command}); _KF_EXIT=$?; [ $_KF_EXIT -eq 0 ] && { ${afterCheck}\n}; exit $_KF_EXIT`,
    env,
  };
}

async function runBash(args: Args, ctx: ToolContext): Promise<ToolOutput> {
  const timeout = Math.min(Math.max(1000, args.timeout_ms ?? DEFAULT_TIMEOUT), MAX_TIMEOUT);

  const pushGuard = await guardGitPush(args.command, ctx);
  if (pushGuard) return pushGuard;

  const { shell, args: shellArgs, isPosix } = getShellCommand(ctx.shell);
  const { command, env: coauthorEnv } = isPosix
    ? injectCoauthor(args.command, ctx.coauthor)
    : { command: args.command, env: {} };

  return new Promise<ToolOutput>((resolve, reject) => {
    logger.debug("bash:spawn", { command: args.command.slice(0, 200), cwd: ctx.cwd, shell });
    const child = spawn(shell, [...shellArgs, command], {
      cwd: ctx.cwd,
      env: {
        ...process.env,
        ...coauthorEnv,
        GIT_EDITOR: "true",
      },
    });
    // No one can type into this process: close stdin so commands that wait
    // for input fail fast instead of hanging until the timeout.
    child.stdin?.end();
    let stdout = "";
    let stderr = "";
    let killedByTimeout = false;
    let killedByAbort = false;

    const timer = setTimeout(() => {
      killedByTimeout = true;
      logger.warn("bash:kill_timeout", { command: args.command.slice(0, 200) });
      child.kill("SIGKILL");
    }, timeout);

    const onAbort = () => {
      killedByAbort = true;
      logger.warn("bash:kill_abort", { command: args.command.slice(0, 200), pid: child.pid });
      child.kill("SIGKILL");
    };
    ctx.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      logger.error("bash:error", { error: e.message, pid: child.pid });
      reject(e);
    });
    // If the command backgrounds a process (e.g. `npm run dev &`), the
    // grandchild may inherit our stdout/stderr pipes. Node will then wait
    // for those pipes to close before emitting "close", so the Promise
    // never resolves. Destroying the streams on "exit" forces "close" to
    // fire immediately while preserving all output already buffered.
    child.on("exit", (code, signal) => {
      logger.debug("bash:exit", { code, signal, pid: child.pid, killedByTimeout, killedByAbort });
      child.stdout?.destroy();
      child.stderr?.destroy();
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener("abort", onAbort);
      logger.debug("bash:close", { code, signal, pid: child.pid, killedByTimeout, killedByAbort });
      const header = killedByTimeout
        ? `(timed out after ${timeout}ms)`
        : killedByAbort
          ? `(aborted — sent SIGKILL)`
          : `exit=${code ?? "?"}${signal ? ` signal=${signal}` : ""}`;
      const parts: string[] = [header];
      if (stdout) parts.push(`--- stdout ---\n${stdout.trimEnd()}`);
      if (stderr) parts.push(`--- stderr ---\n${stderr.trimEnd()}`);
      if (!stdout && !stderr) parts.push("(no output)");
      if (userShellCommandsEnabled() && !killedByAbort) {
        const hint = interactiveCommandHint({
          command: args.command,
          exitCode: code,
          timedOut: killedByTimeout,
          output: `${stdout}\n${stderr}`,
        });
        if (hint) parts.push(hint);
      }
      const raw = parts.join("\n");
      resolve({
        content: raw,
        rawBytes: Buffer.byteLength(raw, "utf8"),
        reducedBytes: Buffer.byteLength(raw, "utf8"),
        meta: { exitCode: code, timedOut: killedByTimeout },
      });
    });
  });
}
