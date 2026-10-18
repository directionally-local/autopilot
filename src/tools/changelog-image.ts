import { readFile } from "node:fs/promises";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolSpec, ToolContext, ToolOutput, Task } from "./registry.js";
import { runKimi } from "../agent/client.js";
import { hasLlmAuth } from "../agent/llm-auth.js";

const GITHUB_API_BASE = "https://api.github.com";
const TIMEOUT_MS = 20_000;

interface ChangelogImageArgs {
  owner: string;
  repo: string;
  days?: number;
  output?: string;
}

interface MergedPr {
  number: number;
  title: string;
  body: string | null;
  user: { login: string };
  merged_at: string;
  html_url: string;
}

interface Release {
  tag_name: string;
  name: string;
  published_at: string;
}

async function githubFetch(path: string, token?: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${GITHUB_API_BASE}${path}`, {
      signal: controller.signal,
      headers,
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

function getToken(ctx: ToolContext): string | undefined {
  return ctx.githubToken;
}

function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

async function loadLogoBase64(): Promise<string | null> {
  try {
    const buf = await readFile(join(process.cwd(), "docs", "logo.png"));
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Simple word-wrap: splits text into lines that fit within maxWidth pixels
 *  at the given font size. Uses a rough heuristic of ~0.55× font-size per char. */
function wrapText(text: string, maxWidth: number, fontSize: number): string[] {
  const avgCharWidth = fontSize * 0.55;
  const maxChars = Math.floor(maxWidth / avgCharWidth);
  const lines: string[] = [];
  const rawLines = text.split("\n");
  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (!trimmed) {
      lines.push("");
      continue;
    }
    let remaining = trimmed;
    while (remaining.length > maxChars) {
      let cut = maxChars;
      while (cut > 0 && remaining[cut] !== " ") cut--;
      if (cut === 0) cut = maxChars;
      lines.push(remaining.slice(0, cut).trimEnd());
      remaining = remaining.slice(cut).trimStart();
    }
    if (remaining) lines.push(remaining);
  }
  return lines;
}

const CHANGELOG_SYSTEM_PROMPT = `You are a senior technical product writer. Your job is to write release notes that make users excited about new features while being completely accurate and grounded only in the provided pull requests.

Rules:
- Write 3–6 bullet points maximum. Highlight only the most significant, user-facing changes.
- Focus on USER VALUE and IMPACT, not implementation details or internal refactors.
- Use confident, clear, engaging language — like Apple product release notes.
- Group related changes under themes when it makes sense.
- Each bullet should be 1–2 sentences.
- Include the PR number in square brackets at the end of each bullet, e.g. [PR #123]
- Do NOT include changes that are purely internal (chores, refactors, dependency updates, version bumps) unless they have clear user-facing impact.
- Do NOT hallucinate features not present in the PRs.
- If there are no meaningful user-facing changes, say so briefly.

Format your response as plain text bullet points, one per line, starting with "• ". Do not use markdown headers or bold/italic.`;

async function summarizeWithLlm(
  prs: MergedPr[],
  ctx: ToolContext,
): Promise<string> {
  if (!ctx.llmAuth || !hasLlmAuth(ctx.llmAuth) || !ctx.model) {
    // Fallback: just list PR titles if no LLM credentials
    return prs.map((p) => `• ${p.title} [PR #${p.number}]`).join("\n");
  }

  const prDescriptions = prs
    .map((p) => {
      const bodySnippet = p.body ? `\n  ${p.body.slice(0, 300).replace(/\n/g, " ")}` : "";
      return `PR #${p.number}: ${p.title} (merged ${p.merged_at.slice(0, 10)} by @${p.user.login})${bodySnippet}`;
    })
    .join("\n\n");

  let summary = "";
  const events = runKimi({
    ...ctx.llmAuth,
    model: ctx.model,
    messages: [
      { role: "system", content: CHANGELOG_SYSTEM_PROMPT },
      {
        role: "user",
        content: `Write a changelog summary for the following merged pull requests:\n\n${prDescriptions}`,
      },
    ],
    signal: ctx.signal,
    temperature: 0.4,
    reasoningEffort: "low",
    idleTimeoutMs: 60_000,
  });

  for await (const ev of events) {
    if (ev.type === "text") summary += ev.delta;
  }

  return summary.trim() || prs.map((p) => `• ${p.title} [PR #${p.number}]`).join("\n");
}

function buildChangelogSvg(opts: {
  owner: string;
  repo: string;
  version: string;
  writeUp: string;
  logoBase64: string | null;
}): string {
  const { owner, repo, version, writeUp, logoBase64 } = opts;

  // ── Layout constants ──────────────────────────────────────────────
  const width = 900;
  const padX = 72;
  const padTop = 64;
  const padBottom = 56;
  const contentW = width - padX * 2;

  const repoFontSize = 22;
  const labelFontSize = 12;
  const bodyFontSize = 16;
  const bodyLineHeight = 24; // tighter for wrapped bullets
  const bulletIndent = 20;
  const bulletGap = 32; // space between bullet items
  const paraGap = 8; // space between wrapped lines within a bullet

  // ── Header ────────────────────────────────────────────────────────
  const logoW = 28;
  const logoH = 28;
  const logoY = padTop + 4;
  const repoTextX = padX + (logoBase64 ? logoW + 14 : 0);
  const repoTextY = padTop + 24;
  const labelY = repoTextY + 32; // extra breathing room
  const headerBottom = labelY + 32;

  // ── Parse write-up into blocks ────────────────────────────────────
  // A block is either a bullet item (starts with "•") or a paragraph.
  // Empty lines separate blocks.
  interface Block {
    type: "bullet" | "paragraph";
    lines: string[]; // already-wrapped lines
  }

  const rawLines = writeUp.split("\n").map((l) => l.trim());
  const blocks: Block[] = [];
  let currentBlock: Block | null = null;

  for (const raw of rawLines) {
    if (!raw) {
      // blank line ends current block
      if (currentBlock) {
        blocks.push(currentBlock);
        currentBlock = null;
      }
      continue;
    }

    const isBullet = raw.startsWith("•");
    const text = isBullet ? raw.slice(1).trim() : raw;

    if (!currentBlock || currentBlock.type !== (isBullet ? "bullet" : "paragraph")) {
      if (currentBlock) blocks.push(currentBlock);
      currentBlock = { type: isBullet ? "bullet" : "paragraph", lines: [] };
    }

    // Wrap text
    const wrapW = isBullet ? contentW - bulletIndent : contentW;
    const wrapped = wrapText(text, wrapW, bodyFontSize);
    currentBlock.lines.push(...wrapped);
  }
  if (currentBlock) blocks.push(currentBlock);

  // ── Layout blocks ─────────────────────────────────────────────────
  let bodyHeight = 0;
  const lineMeta: { text: string; y: number; isBullet: boolean; isFirst: boolean }[] = [];
  let y = headerBottom;

  for (let b = 0; b < blocks.length; b++) {
    const block = blocks[b]!;
    for (let i = 0; i < block.lines.length; i++) {
      const line = block.lines[i]!;
      lineMeta.push({
        text: line,
        y,
        isBullet: block.type === "bullet",
        isFirst: i === 0,
      });
      y += bodyLineHeight;
      // Tight extra spacing for wrapped lines inside a bullet
      if (block.type === "bullet" && i < block.lines.length - 1) {
        y += paraGap;
      }
    }
    // Gap between blocks
    if (b < blocks.length - 1) {
      y += bulletGap;
    }
  }
  bodyHeight = y - headerBottom;

  const height = headerBottom + bodyHeight + padBottom;

  // ── Build SVG elements ────────────────────────────────────────────
  const logoEl = logoBase64
    ? `<image x="${padX}" y="${logoY}" width="${logoW}" height="${logoH}" href="${logoBase64}"/>`
    : "";

  const bodySpans = lineMeta
    .map(({ text, y: ly, isBullet, isFirst }) => {
      // All lines of a bullet block are indented; first line also gets the dot
      const x = isBullet ? padX + bulletIndent : padX;
      const weight = isBullet ? 'font-weight="500"' : "";
      const fill = isBullet ? "#1f2937" : "#4b5563";
      return `<tspan x="${x}" y="${ly}" fill="${fill}" ${weight}>${escapeXml(text)}</tspan>`;
    })
    .join("");

  // Small orange dots for first lines of bullet blocks only
  const bulletDots = lineMeta
    .filter((m) => m.isBullet && m.isFirst)
    .map(({ y: ly }) => {
      const cy = ly - bodyFontSize * 0.35;
      return `<circle cx="${padX + 6}" cy="${cy}" r="3" fill="#f97316"/>`;
    })
    .join("");

  const today = escapeXml(new Date().toISOString().slice(0, 10));

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <style>
      .font { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif; }
    </style>
  </defs>

  <!-- Background -->
  <rect width="${width}" height="${height}" fill="#ffffff"/>

  <!-- Top accent bar -->
  <rect x="${padX}" y="${padTop}" width="36" height="3" fill="#f97316" rx="1.5"/>

  <!-- Header -->
  <g class="font">
    ${logoEl}
    <text x="${repoTextX}" y="${repoTextY}" fill="#111827" font-size="${repoFontSize}" font-weight="600">${escapeXml(owner)}/${escapeXml(repo)}</text>

    <text x="${padX}" y="${labelY}" fill="#9ca3af" font-size="${labelFontSize}" font-weight="500" letter-spacing="0.08em">CHANGELOG</text>

    <!-- Version pill -->
    <rect x="${padX + 88}" y="${labelY - 14}" width="${Math.max(40, version.length * 7 + 16)}" height="22" fill="#fff7ed" rx="11"/>
    <text x="${padX + 88 + 10}" y="${labelY}" fill="#f97316" font-size="${labelFontSize}" font-weight="500">${escapeXml(version)}</text>
  </g>

  <!-- Separator -->
  <line x1="${padX}" y1="${headerBottom - 10}" x2="${width - padX}" y2="${headerBottom - 10}" stroke="#f3f4f6" stroke-width="1"/>

  <!-- Body -->
  <g class="font">
    ${bulletDots}
    <text font-size="${bodyFontSize}" line-height="${bodyLineHeight}">
      ${bodySpans}
    </text>
  </g>

  <!-- Footer -->
  <g class="font" transform="translate(0, ${height - padBottom + 20})">
    <text x="${padX}" y="0" fill="#d1d5db" font-size="11">Generated with KimiFlare · ${today}</text>
  </g>
</svg>`;
}

export const changelogImageTool: ToolSpec<ChangelogImageArgs> = {
  name: "changelog_image",
  description:
    "Generate a beautiful changelog image for a GitHub repository. " +
    "Fetches merged PRs from the last N days, uses an LLM to write a creative summary, " +
    "then renders a shareable PNG with the project logo, version, and highlights.",
  parameters: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner (user or organization)." },
      repo: { type: "string", description: "Repository name." },
      days: { type: "integer", description: "Number of days to look back for merged PRs. Default: 7.", minimum: 1, maximum: 90 },
      output: { type: "string", description: "Output file path for the PNG. Default: ./changelog-<repo>-<version>.png" },
    },
    required: ["owner", "repo"],
    additionalProperties: false,
  },
  needsPermission: false,
  render: (args) => ({ title: `Changelog image for ${args.owner ?? ""}/${args.repo ?? ""}` }),
  async run(args, ctx): Promise<ToolOutput> {
    const token = getToken(ctx);
    const days = args.days ?? 7;

    const tasks: Task[] = [
      { id: "1", title: "Fetch merged PRs from GitHub", status: "pending" },
      { id: "2", title: "Determine latest version", status: "pending" },
      { id: "3", title: "Summarize changes with LLM", status: "pending" },
      { id: "4", title: "Render changelog image", status: "pending" },
      { id: "5", title: "Save PNG to file", status: "pending" },
    ];
    const setTask = (id: string, status: Task["status"]) => {
      const t = tasks.find((x) => x.id === id);
      if (t) t.status = status;
      ctx.onTasks?.(tasks.map((x) => ({ ...x })));
    };

    // 1. Fetch merged PRs
    setTask("1", "in_progress");
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
    const prs = await githubFetch(
      `/repos/${args.owner}/${args.repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100`,
      token,
    ) as MergedPr[];

    const merged = prs
      .filter((p) => p.merged_at && p.merged_at >= since)
      .sort((a, b) => (b.merged_at ?? "").localeCompare(a.merged_at ?? ""));

    if (merged.length === 0) {
      setTask("1", "completed");
      return {
        content: `No merged PRs in ${args.owner}/${args.repo} within the last ${days} day(s).`,
        rawBytes: 0,
        reducedBytes: 0,
      };
    }
    setTask("1", "completed");

    // 2. Fetch latest release
    setTask("2", "in_progress");
    let version = "latest";
    try {
      const releases = await githubFetch(
        `/repos/${args.owner}/${args.repo}/releases?per_page=1`,
        token,
      ) as Release[];
      if (releases.length > 0) {
        version = releases[0]!.tag_name;
      }
    } catch {
      try {
        const tags = await githubFetch(
          `/repos/${args.owner}/${args.repo}/tags?per_page=1`,
          token,
        ) as Array<{ name: string }>;
        if (tags.length > 0) {
          version = tags[0]!.name;
        }
      } catch {
        // leave as "latest"
      }
    }
    setTask("2", "completed");

    // 3. Summarize with LLM
    setTask("3", "in_progress");
    const writeUp = await summarizeWithLlm(merged, ctx);
    setTask("3", "completed");

    // 4. Load logo & build SVG
    setTask("4", "in_progress");
    const logoBase64 = await loadLogoBase64();
    const svg = buildChangelogSvg({ owner: args.owner, repo: args.repo, version, writeUp, logoBase64 });

    // 5. Render to PNG. resvg ships a per-platform native binary; load it only
    // here so a missing binary can't crash the whole CLI at startup.
    let resvgModule: typeof import("@resvg/resvg-js");
    try {
      resvgModule = await import("@resvg/resvg-js");
    } catch {
      const content = "PNG rendering is unavailable because the optional @resvg/resvg-js dependency is not installed.";
      setTask("4", "completed");
      const bytes = Buffer.byteLength(content, "utf8");
      return { content, rawBytes: bytes, reducedBytes: bytes };
    }
    const { Resvg } = resvgModule;
    const resvg = new Resvg(svg, {
      fitTo: { mode: "zoom", value: 2 },
      font: {
        defaultFontFamily: "system-ui",
      },
    });
    const pngData = resvg.render();
    const pngBuffer = pngData.asPng();
    setTask("4", "completed");

    // 6. Save
    setTask("5", "in_progress");
    const outputPath = args.output ?? `./changelog-${args.repo}-${version.replace(/[^a-zA-Z0-9._-]/g, "_")}.png`;
    await writeFile(outputPath, pngBuffer);
    setTask("5", "completed");

    const periodLabel = days === 1 ? "past day" : `past ${days} days`;
    const content = `✓ Changelog image saved to ${outputPath}\n  ${merged.length} PR${merged.length === 1 ? "" : "s"} from the ${periodLabel} · ${version} · ${resvg.width}×${resvg.height}`;

    const bytes = Buffer.byteLength(content, "utf8");
    return { content, rawBytes: bytes, reducedBytes: bytes };
  },
};
