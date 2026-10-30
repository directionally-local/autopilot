/**
 * `!` user shell commands: the interactive TUI lets the user type
 * `! <command>` to run a command in their real terminal (TTY, keyboard
 * input), with the output shared back into the conversation.
 *
 * The agent's own `bash` tool has no TTY, so this is how commands that need
 * a login, password, or interactive prompt get run. This module holds the
 * process-level capability flag (only the TUI turns it on), the system
 * prompt section that teaches the model about it, and the heuristic that
 * tells the model to suggest it after a bash call that needed a terminal.
 */

let enabled = false;

/** Called by the interactive TUI at startup. Headless / SDK / server never call it. */
export function enableUserShellCommands(on = true): void {
  enabled = on;
}

export function userShellCommandsEnabled(): boolean {
  return enabled;
}

export const USER_SHELL_PROMPT_SECTION = `## Commands the user runs with \`!\`

The user can run a shell command directly in this session by typing \`!\` followed by the command in the prompt (for example \`! gh auth login\`). It runs in their real terminal with full keyboard input, and the output is added to this conversation for you to read.

Your \`bash\` tool has no terminal: stdin is closed and there is no TTY, so anything that waits for typed input fails or hangs. Instead of running the command yourself, suggest \`! <exact command>\` when:
- it needs a login or interactive auth (\`gh auth login\`, \`npm login\`, \`docker login\`, \`gcloud auth login\`, \`aws sso login\`, \`az login\`, \`wrangler login\`, \`vercel login\`, …)
- it prompts for a password, passphrase, one-time code, or confirmation (\`sudo …\`, \`ssh\` with a passphrase or unknown host key, \`git push\` over HTTPS asking for credentials)
- it is an interactive program (REPLs, setup wizards without non-interactive flags, \`git rebase -i\`, editors, TUIs)
- the user would otherwise have to paste a secret (token, password) into the chat
- one of your bash calls failed with a "not logged in", "authentication required", "not a tty", or "terminal required" error, or timed out waiting for input
- the user declined permission for a command but still wants it run

Prefer non-interactive flags when they exist (\`--yes\`, \`-m\`, \`--with-token\` reading an env var, \`CI=1\`) and run the command yourself. Don't suggest \`!\` for commands your bash tool can run. When you do suggest it, give the exact line to type (e.g. "run \`! gh auth login\` in the prompt") and stop; when the user runs it, its output is added to the conversation and the turn continues automatically, so carry on from there.`;

const AUTH_OR_TTY_OUTPUT: RegExp[] = [
  /not logged in(?:to)?\b/i,
  /you are not logged in/i,
  /\b(?:authentication|login|sign[- ]?in) (?:is )?required\b/i,
  /\bplease (?:run|use) [`'"]?[\w.-]+ (?:auth )?log ?in\b/i,
  /\bto (?:authenticate|get started with [\w ]+CLI), (?:please )?run\b/i,
  /\bgh auth login\b/i,
  /\bnot a tty\b/i,
  /\binappropriate ioctl for device\b/i,
  /\b(?:stdin|input) is not a (?:tty|terminal)\b/i,
  /\b(?:a|no) (?:terminal|tty) (?:is )?(?:required|present)\b/i,
  /\bmust be run (?:from|in) an? (?:terminal|interactive)/i,
  /\brequires an interactive (?:terminal|shell|session)\b/i,
  /\bcannot prompt\b|\bunable to prompt\b|\bprompts? (?:are )?disabled\b/i,
  /\bcould not read (?:username|password) for\b/i,
  /\bterminal prompts disabled\b/i,
  /\bhost key verification failed\b/i,
];

const INTERACTIVE_COMMAND =
  /^(?:sudo\b|ssh\b|passwd\b|su\b|gh auth login\b|npm (?:login|adduser)\b|yarn (?:npm )?login\b|pnpm login\b|docker login\b|gcloud auth\b|aws (?:sso )?(?:login|configure)\b|az login\b|firebase login\b|vercel login\b|wrangler login\b|netlify login\b|heroku login\b|fly(?:ctl)? auth login\b|op signin\b|gpg\b)/i;

/** A prompt left waiting at the end of the output (e.g. "Password:", "Continue? [y/N]"). */
const TRAILING_PROMPT = /(?:password|passphrase|username|token|code|otp)[^\n]{0,40}:\s*$|\[(?:y\/n|Y\/n|y\/N)\]\s*$|\(y(?:es)?\/n(?:o)?\)\s*$|\?\s*$/i;

export interface BashOutcome {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/**
 * Returns a short note to append to a bash tool result when the failure looks
 * like the command needed a terminal or a login, or null when it doesn't.
 * Deliberately conservative: successful commands never get a hint.
 */
export function interactiveCommandHint(o: BashOutcome): string | null {
  if (!o.timedOut && o.exitCode === 0) return null;
  const cmd = o.command.trim().replace(/^cd\s+[^\s&;]+\s*(?:&&|;)\s*/, "");
  const tail = o.output.slice(-4000);
  const looksInteractive =
    AUTH_OR_TTY_OUTPUT.some((re) => re.test(tail)) ||
    INTERACTIVE_COMMAND.test(cmd) ||
    (o.timedOut && TRAILING_PROMPT.test(tail.trimEnd()));
  if (!looksInteractive) return null;
  const suggestion = cmd.length <= 200 && !cmd.includes("\n") ? `\`! ${cmd}\`` : "`! <command>`";
  return (
    "[autopilot] This command appears to need a login, a password, or an interactive terminal, " +
    "which your bash tool cannot provide. Don't retry it as-is. If a non-interactive alternative exists, use it; " +
    `otherwise ask the user to run ${suggestion} in the prompt and wait for its output to appear in the conversation.`
  );
}
