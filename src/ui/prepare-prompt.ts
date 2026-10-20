/**
 * Turning what the user typed into the turn's user message, extracted from
 * App.processMessage: custom slash-command expansion (with per-turn model
 * and effort overrides), image attachments, and the reasoning effort the
 * request's tier asks for. Plain async functions with injected IO, tested
 * without rendering the app.
 */

import type { ContentPart } from "../agent/messages.js";
import { sanitizeString } from "../agent/messages.js";
import type { CustomCommand, RenderResult } from "../commands/types.js";
import type { ReasoningEffort } from "../config.js";
import { describeImageChange, imageNote, type EncodedImage } from "../util/image.js";
import { findImagePaths, MAX_IMAGES_PER_MESSAGE } from "./app-helpers.js";

export interface ExpandedCommand {
  /** The rendered template (the prompt sent to the model). Empty → nothing to send. */
  prompt: string;
  /** Notices for the user (template warnings, shell execution, overrides). */
  notices: string[];
  model?: string;
  effort?: ReasoningEffort;
}

/**
 * Expand `/name args` when `name` is a custom command; null otherwise.
 * Built-in slash commands are handled before this.
 */
export async function expandCustomCommand(
  input: string,
  commands: CustomCommand[],
  render: (cmd: CustomCommand, input: string) => Promise<RenderResult>,
): Promise<ExpandedCommand | null> {
  if (!input.startsWith("/")) return null;
  const name = input.split(/\s+/)[0]!.slice(1).toLowerCase();
  const custom = commands.find((c) => c.name === name);
  if (!custom) return null;
  const { prompt, warnings } = await render(custom, input);
  const notices = warnings.map((w) => `/${custom.name}: ${w}`);
  if (custom.shell) notices.push(`/${custom.name}: executing shell code from template`);
  if (!prompt.trim()) return { prompt: "", notices };
  const overrides: string[] = [];
  if (custom.model) overrides.push(`model=${custom.model}`);
  if (custom.effort) overrides.push(`effort=${custom.effort}`);
  if (overrides.length > 0) notices.push(`command '${custom.name}' → ${overrides.join(", ")} (this turn)`);
  if (custom.mode) notices.push(`note: mode override (${custom.mode}) is not yet wired; current mode applies`);
  return {
    prompt,
    notices,
    ...(custom.model ? { model: custom.model } : {}),
    ...(custom.effort ? { effort: custom.effort } : {}),
  };
}

export interface PromptContent {
  content: string | ContentPart[];
  /** Filenames of the attached images (shown on the user's chat event). */
  images: string[];
  /** Images that couldn't be encoded (path + reason). */
  errors: string[];
  /** Size savings from downscaling, for the user (e.g. `image a.png: 595 KB → 112 KB (1568×985 jpeg)`). */
  notices: string[];
}

/** The user message content: the text, plus any image paths it mentions (up to the per-message cap), normalized by `encode`. */
export async function buildPromptContent(text: string, encode: (path: string) => Promise<EncodedImage>): Promise<PromptContent> {
  const errors: string[] = [];
  const notices: string[] = [];
  const notes: string[] = [];
  const encoded = await Promise.all(
    findImagePaths(text)
      .slice(0, MAX_IMAGES_PER_MESSAGE)
      .map(async (path) => {
        try {
          const img = await encode(path);
          if (img.change) {
            notices.push(describeImageChange(img.filename, img.change));
            notes.push(imageNote(path, img.change));
          }
          return img;
        } catch (e) {
          errors.push(`failed to encode image ${path}: ${(e as Error).message}`);
          return null;
        }
      }),
  );
  const valid = encoded.filter((img): img is EncodedImage => img !== null);
  if (valid.length === 0) return { content: sanitizeString(text), images: [], errors, notices };
  // Downscaled images: tell the model where the full-resolution original is.
  const withNotes = notes.length > 0 ? `${text}\n\n${notes.join("\n")}` : text;
  return {
    content: [
      { type: "text", text: sanitizeString(withNotes) },
      ...valid.map((img) => ({ type: "image_url" as const, image_url: { url: img.dataUrl } })),
    ],
    images: valid.map((img) => img.filename),
    errors,
    notices,
  };
}

const EFFORT_FOR_TIER: Record<string, ReasoningEffort> = { light: "low", medium: "medium", heavy: "high" };

/** A command override wins, then the request's tier, then the session's effort. */
export function turnReasoningEffort(tier: string, override: ReasoningEffort | undefined, fallback: ReasoningEffort): ReasoningEffort {
  return override ?? EFFORT_FOR_TIER[tier] ?? fallback;
}
