/**
 * Request body size: what makes a request big, and the one-time warning when
 * it is (#826). Chat requests are stateless, so the whole body is uploaded on
 * every call; on a slow uplink a large body looks exactly like a slow model.
 */

import type { ChatMessage } from "./messages.js";

/** Bodies above this get the one-time warning. */
export const LARGE_BODY_BYTES = 1024 * 1024;

export interface BodyPart {
  label: string;
  bytes: number;
}

const utf8 = (s: string) => Buffer.byteLength(s, "utf8");

/** The biggest contributors to a request body: images (together), then individual tool results and messages. */
export function largestBodyParts(messages: ChatMessage[], limit = 3): BodyPart[] {
  const toolNames = new Map<string, string>();
  for (const m of messages) for (const tc of m.tool_calls ?? []) toolNames.set(tc.id, tc.function.name);

  let imageBytes = 0;
  let imageCount = 0;
  const parts: BodyPart[] = [];
  messages.forEach((m) => {
    let textBytes = 0;
    if (typeof m.content === "string") textBytes = utf8(m.content);
    else if (Array.isArray(m.content)) {
      for (const p of m.content) {
        if (p.type === "image_url") {
          imageCount++;
          imageBytes += utf8(p.image_url.url);
        } else if (p.type === "text") textBytes += utf8(p.text);
      }
    }
    if (textBytes === 0) return;
    const label =
      m.role === "tool"
        ? `${toolNames.get(m.tool_call_id ?? "") ?? "tool"} result`
        : m.role === "system"
          ? "system prompt"
          : `${m.role} message`;
    parts.push({ label, bytes: textBytes });
  });
  if (imageCount > 0) parts.push({ label: `${imageCount} image${imageCount === 1 ? "" : "s"}`, bytes: imageBytes });
  return parts.sort((a, b) => b.bytes - a.bytes).slice(0, limit);
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

/** The warning for a large body, naming its biggest parts. */
export function largeBodyWarning(bodyBytes: number, parts: BodyPart[]): string {
  const biggest = parts.map((p) => `${p.label} ${formatBytes(p.bytes)}`).join(", ");
  return (
    `Each model call uploads the whole conversation: this request is ${formatBytes(bodyBytes)}` +
    (biggest ? ` (largest parts: ${biggest})` : "") +
    `. On a slow connection the upload, not the model, makes calls slow — /compact or /fresh shrinks it.`
  );
}

const warned = new Set<string>();

/** True the first time a session crosses the threshold (so the warning shows once). */
export function shouldWarnLargeBody(sessionKey: string, bodyBytes: number): boolean {
  if (bodyBytes <= LARGE_BODY_BYTES || warned.has(sessionKey)) return false;
  warned.add(sessionKey);
  return true;
}
