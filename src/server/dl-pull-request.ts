/**
 * Title and body for the pull request a dl server code conversation opens: the title comes from
 * the branch's commits, the body from the turn's final assistant message, with a line linking
 * any issue the prompt or the commits reference.
 */
import type { DlCommit } from "./dl-github.js";

const MAX_TITLE_CHARS = 80;
const MAX_BODY_CHARS = 10_000;
const CONVENTIONAL_SUBJECT_RE = /^[a-z]+(?:\([^)\n]*\))?!?: \S/i;

/** The minimal event shape the final-message reader needs. */
export interface DlTurnEvent {
  runId: string | null;
  type: string;
  data: Record<string, unknown>;
}

function subjectOf(message: string): string {
  return (message.split("\n")[0] ?? "").replace(/\s+/g, " ").trim();
}

function bodyOf(message: string): string {
  const lines = message.replace(/\r\n/g, "\n").split("\n");
  return lines.slice(1).join("\n").trim();
}

/** Trims a title to at most 80 characters, cutting at a word boundary when one is close. */
export function trimTitle(title: string): string {
  const flat = title.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_TITLE_CHARS) return flat;
  const cut = flat.slice(0, MAX_TITLE_CHARS - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space >= 60 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The commits that describe the branch's work: merge commits are dropped when any other commit exists. */
function authoredCommits(commits: readonly DlCommit[]): DlCommit[] {
  const withSubject = commits.filter((commit) => subjectOf(commit.message));
  const authored = withSubject.filter((commit) => !commit.merge);
  return authored.length ? authored : withSubject;
}

/**
 * One commit: its subject. Several (oldest first): the oldest Conventional Commit subject, else
 * the oldest subject. No commits: the prompt-derived fallback.
 */
export function pullRequestTitle(commits: readonly DlCommit[], fallback: string): string {
  const candidates = authoredCommits(commits);
  const chosen = candidates.find((commit) => CONVENTIONAL_SUBJECT_RE.test(subjectOf(commit.message))) ?? candidates[0];
  return trimTitle(chosen ? subjectOf(chosen.message) : fallback);
}

/**
 * The assistant's last message of a run: the text streamed after its last tool call. Narration
 * between tool calls ("I'll start by reading…") is dropped.
 */
export function finalAssistantMessage(events: Iterable<DlTurnEvent>, runId: string): string {
  let text = "";
  for (const event of events) {
    if (event.runId !== runId) continue;
    if (event.type === "tool.activity") {
      text = "";
    } else if (event.type === "assistant.delta") {
      const delta = typeof event.data.text === "string" ? event.data.text : typeof event.data.delta === "string" ? event.data.delta : "";
      text += delta;
    }
  }
  return text.trim();
}

/**
 * Lines that link issues: "Resolves #N" for an issue of this repository the prompt names (by URL,
 * as "issue #N"/"fixes #N", or as owner/repo#N), "Refs …" for another repository's issue or for a
 * pull request, and "Closes #N" for each issue a commit
 * closes. Issues the body already references with a closing keyword are skipped.
 */
export function issueLinkLines(repository: string, prompt: string, commits: readonly DlCommit[], body = ""): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const repo = repository.toLowerCase();
  const closing = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;
  for (const match of body.matchAll(closing)) {
    if (!match[1] || match[1].toLowerCase() === repo) seen.add(`${repo}#${match[2]}`);
  }
  const add = (owner: string, number: string, keyword: "Resolves" | "Closes" | "Refs") => {
    const key = `${owner.toLowerCase()}#${Number(number)}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (owner.toLowerCase() !== repo) lines.push(`Refs ${owner}#${Number(number)}`);
    else lines.push(`${keyword} #${Number(number)}`);
  };
  for (const match of prompt.matchAll(/https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(issues|pull)\/(\d+)/gi)) {
    add(match[1]!, match[3]!, match[2]!.toLowerCase() === "issues" ? "Resolves" : "Refs");
  }
  // A bare #N counts only after a word that makes it an issue ("issue #12", "fixes #12") or
  // as owner/repo#N, so "the #1 priority" is not linked.
  const withoutUrls = prompt.replace(/https?:\/\/\S+/g, " ");
  const named = /\b(?:(?:issues?|bugs?|tickets?|close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)|([\w.-]+\/[\w.-]+)#(\d+))\b/gi;
  for (const match of withoutUrls.matchAll(named)) {
    if (match[4]) add(match[3]!, match[4], "Resolves");
    else add(match[1] ?? repository, match[2]!, "Resolves");
  }
  for (const commit of commits) {
    for (const match of commit.message.matchAll(closing)) add(match[1] ?? repository, match[2]!, "Closes");
  }
  return lines;
}

/**
 * The PR body: the turn's final assistant message, else the commit bodies, else the prompt; then
 * the issue link lines.
 */
export function pullRequestBody(input: {
  repository: string;
  prompt: string;
  finalMessage: string;
  commits: readonly DlCommit[];
}): string {
  const commits = authoredCommits(input.commits);
  const commitBodies = commits.map((commit) => bodyOf(commit.message)).filter(Boolean);
  let summary = input.finalMessage.trim()
    || (commits.length > 1 && commitBodies.length
      ? commits.map((commit) => {
          const body = bodyOf(commit.message);
          return body ? `**${subjectOf(commit.message)}**\n\n${body}` : `**${subjectOf(commit.message)}**`;
        }).join("\n\n")
      : commitBodies.join("\n\n"))
    || input.prompt.trim();
  summary = summary.slice(0, MAX_BODY_CHARS).trim();
  const links = issueLinkLines(input.repository, input.prompt, input.commits, summary);
  return links.length ? `${summary}\n\n${links.join("\n")}` : summary;
}
