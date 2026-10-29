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

/** Commands that only print file contents. `sed`/`awk` count only in their
 *  line-range form, which is how models use them to read a slice of a file. */
const FILE_READ_COMMANDS = new Set(["cat", "head", "tail", "nl", "bat"]);

/**
 * True when a bash command only reads file contents (`cat`, `head`, `tail`,
 * `nl`, `bat`, `sed -n`, `awk 'NR…'`), optionally piped into another reader.
 * Used to point models that read through bash at the `read` tool (#1001).
 * Conservative: any other command, redirection, substitution or shell
 * operator makes it false.
 */
export function isFileReadCommand(command: string): boolean {
  const trimmed = command.trim();
  if (!trimmed) return false;
  // Ignore operators inside quoted arguments (`awk 'NR>=1 && NR<=120' file`).
  const unquoted = trimmed.replace(/'[^']*'|"[^"]*"/g, "''");
  if (/[;&<>`]|\$\(/.test(unquoted)) return false;
  const segments = trimmed.split("|").map((s) => s.trim()).filter(Boolean);
  if (segments.length === 0) return false;
  return segments.every((segment) => {
    const tokens = segment.split(/\s+/);
    const cmd = tokens[0]!;
    if (FILE_READ_COMMANDS.has(cmd)) return true;
    if (cmd === "sed") return tokens.some((t) => t === "-n" || /^-[a-zA-Z]*n/.test(t));
    if (cmd === "awk") return tokens.some((t) => /\b(?:NR|FNR)\b/.test(t));
    return false;
  });
}

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

/**
 * Detect git commands that create commits or rewrite history on the current
 * branch and block them when that branch is the repository's default branch.
 * Complements guardGitPush: a commit on `main` is just as unwanted as a push
 * to it when the user prefers pull requests. Returns a blocked ToolOutput when
 * the command should not proceed; returns undefined otherwise.
 */
export async function guardGitCommit(command: string, ctx: ToolContext): Promise<ToolOutput | undefined> {
  const trimmed = command.trim();
  const verbMatch = COMMIT_VERBS.exec(trimmed);
  const hardReset = HARD_RESET.test(trimmed);
  if (!verbMatch && !hardReset) return undefined;

  // `preferPullRequests` defaults to true; allowDirectPush is the explicit opt-out.
  if (ctx.preferPullRequests === false) return undefined;
  const allowed = ctx.allowDirectPush === true || process.env.KIMIFLARE_ALLOW_DIRECT_PUSH === "1";
  if (allowed) return undefined;

  // `git merge --abort`, `git rebase --continue`, ... do not create commits.
  if (/\s--(?:abort|continue|skip|quit)\b/.test(trimmed)) return undefined;

  const verbIndex = hardReset ? trimmed.search(HARD_RESET) : trimmed.search(COMMIT_VERBS);
  // `git switch -c feat && git commit` lands on the new branch, not the default one.
  const createIndex = trimmed.search(BRANCH_CREATE);
  if (createIndex >= 0 && createIndex < verbIndex) return undefined;

  const defaultBranch = await resolveDefaultBranch(ctx.cwd);
  if (!defaultBranch) return undefined; // not a git repo or no default branch to protect

  const current = await getCurrentBranch(ctx.cwd);
  if (!current || current !== defaultBranch) return undefined;

  const verb = hardReset ? "reset --hard" : verbMatch![1]!;
  const msg =
    `Blocked: \`git ${verb}\` on the default branch (${defaultBranch}). ` +
    `Create a feature branch first (\`git switch -c <name>\`), then commit and open a PR with \`github_create_pr\`. ` +
    `To allow direct commits, set \`allowDirectPush: true\` in config or run with \`KIMIFLARE_ALLOW_DIRECT_PUSH=1\`.`;
  return makeErrorOutput(msg);
}

/** Commit-creating or history-rewriting git verbs, including `git -C dir <verb>`. */
const COMMIT_VERBS = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+(commit|merge|rebase|cherry-pick|revert)\b/;
const HARD_RESET = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+reset\b[^&;|]*\s--hard\b/;
const BRANCH_CREATE = /\bgit\b(?:\s+-[cC]\s+\S+)*\s+(?:switch\s+-[cC]|checkout\s+-[bB])\b/;

/**
 * The branch the guard protects. Prefers origin/HEAD; for a local-only repo
 * (or one where origin/HEAD is unset) falls back to main/master when that is
 * the checked-out branch.
 */
async function resolveDefaultBranch(cwd: string): Promise<string | undefined> {
  const fromOrigin = await getDefaultBranch(cwd);
  if (fromOrigin) return fromOrigin;
  const current = await getCurrentBranch(cwd);
  return current === "main" || current === "master" ? current : undefined;
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
  // `origin/HEAD` as a plain ref (not a symbolic ref) tells us nothing.
  if (!match || match[1] === "HEAD") return undefined;
  return match[1];
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
  // Look at the `git push` segment of a compound command: `cd sub && git push
  // origin main` must be guarded just like a bare `git push origin main`.
  const segments = command
    .split(/&&|\|\||;|\n/)
    .map((s) => s.trim().replace(/^\(+/, "").replace(/\)+$/, "").trim());

  for (const segment of segments) {
    const tokens = segment.split(/\s+/);
    if (tokens[0] !== "git") continue;
    let i = 1;
    // `git -C dir push`, `git -c key=value push`
    while (i < tokens.length && (tokens[i] === "-C" || tokens[i] === "-c")) i += 2;
    if (tokens[i] !== "push") continue;
    i++;

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

  return undefined;
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

  const commitGuard = await guardGitCommit(args.command, ctx);
  if (commitGuard) return commitGuard;

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
        meta: { exitCode: code, timedOut: killedByTimeout, aborted: killedByAbort, stdout, stderr },
      });
    });
  });
}
