/**
 * "Opened with dl": the line pull requests the agent opens end with. On by
 * default for every provider; `prFooter: false` in config.json,
 * `/settings pr-footer off` or AUTOPILOT_PR_FOOTER=0 turns it off. Never
 * added to commits, and never twice.
 *
 * Applied where the agent opens a PR: the github_create_pr tool, `gh pr
 * create` run through the bash tool (the body is amended right after the PR
 * exists, see wrapGhPrCreate), and the dl server's PR for a code
 * conversation.
 */

import { readFileSync } from "node:fs";
import { configPath } from "./app-dirs.js";
import { readEnv } from "./env.js";

export const PR_FOOTER = "Opened with [dl](https://dl.new), a free coding agent.";

/** What marks a body as already carrying the footer (its link), however it was worded or wrapped. */
const FOOTER_MARK = "](https://dl.new)";

/** True when the body already has the footer. */
export function hasPrFooter(body: string | undefined | null): boolean {
  return !!body && body.includes(FOOTER_MARK);
}

/** The body ending with the footer (once). An empty body becomes just the footer. */
export function withPrFooter(body: string | undefined | null): string {
  const text = (body ?? "").replace(/\s+$/, "");
  if (hasPrFooter(text)) return text;
  return text ? `${text}\n\n${PR_FOOTER}` : PR_FOOTER;
}

/**
 * Whether PRs get the footer: AUTOPILOT_PR_FOOTER when set, else config.json's
 * `prFooter`, else on. Read from disk each time (PRs are rare) so a change
 * from /settings applies at once in every host.
 */
export function prFooterEnabled(env: NodeJS.ProcessEnv = process.env, path?: string): boolean {
  const raw = readEnv("PR_FOOTER", env)?.trim().toLowerCase();
  if (raw === "0" || raw === "false" || raw === "off") return false;
  if (raw === "1" || raw === "true" || raw === "on") return true;
  try {
    const cfg = JSON.parse(readFileSync(path ?? configPath("config.json"), "utf8")) as { prFooter?: unknown };
    return cfg.prFooter !== false;
  } catch {
    return true;
  }
}

/** Env var carrying the footer into the shell: the script text never contains it. */
const FOOTER_ENV = "KF_PR_FOOTER";
const OUT_ENV = "KF_PR_OUT";

/** `gh pr create` anywhere in a command (not `gh pr create --web`, which opens a browser form instead). */
export function createsGhPr(command: string): boolean {
  return /(^|[\s;&|(])gh\s+pr\s+create\b/.test(command) && !/\bgh\s+pr\s+create\b[^\n;&|]*\s(--web|-w)\b/.test(command);
}

/**
 * Wrap a POSIX command that runs `gh pr create` so the PR it opens ends with
 * the footer: the command's output is kept (and printed) as is, then, when it
 * succeeded and printed a PR URL, that PR's body is read back and the footer
 * appended unless it is already there. The command's exit status is kept;
 * a failed amend is silent. Unchanged when the command doesn't create a PR.
 */
export function wrapGhPrCreate(command: string, tmpFile: string): { command: string; env: Record<string, string> } {
  if (!createsGhPr(command)) return { command, env: {} };
  const amend = [
    `_KF_URL=$(grep -Eo 'https://github\\.com/[^[:space:]]+/pull/[0-9]+' "$${OUT_ENV}" | tail -n 1)`,
    `if [ -n "$_KF_URL" ]; then`,
    `  _KF_BODY=$(gh pr view "$_KF_URL" --json body -q .body 2>/dev/null) && case "$_KF_BODY" in`,
    `    *"](https://dl.new)"*) ;;`,
    `    *) if [ -n "$_KF_BODY" ]; then printf '%s\\n\\n%s\\n' "$_KF_BODY" "$${FOOTER_ENV}"; else printf '%s\\n' "$${FOOTER_ENV}"; fi | gh pr edit "$_KF_URL" --body-file - >/dev/null 2>&1 ;;`,
    `  esac`,
    `fi`,
  ].join("\n");
  const wrapped = [
    `(`,
    `(${command}) > "$${OUT_ENV}"; _KF_RC=$?`,
    `cat "$${OUT_ENV}"`,
    `if [ $_KF_RC -eq 0 ]; then`,
    amend,
    `fi`,
    `rm -f "$${OUT_ENV}"`,
    `exit $_KF_RC`,
    `)`,
  ].join("\n");
  return { command: wrapped, env: { [FOOTER_ENV]: PR_FOOTER, [OUT_ENV]: tmpFile } };
}
