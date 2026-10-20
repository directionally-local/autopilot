/**
 * The user message for a prompt plus attached files (print mode and the
 * HTTP server): text files are inlined, images are normalized (#823) and
 * attached as image parts.
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import type { ContentPart } from "../agent/messages.js";
import { describeImageChange, encodeImageFile, imageNote, isImagePath, type ImageNormalizeOptions } from "./image.js";

export interface AttachmentMessage {
  content: string | ContentPart[];
  /** Image size savings, e.g. `image a.png: 595 KB → 112 KB (1568×985 jpeg)`. */
  notices: string[];
}

export async function buildAttachmentMessage(
  prompt: string,
  files: string[],
  cwd: string,
  imageOptions: ImageNormalizeOptions = {},
): Promise<AttachmentMessage> {
  let text = prompt;
  const imageParts: ContentPart[] = [];
  const fileContents: string[] = [];
  const notices: string[] = [];

  for (const filePath of files) {
    if (isImagePath(filePath)) {
      try {
        const img = await encodeImageFile(filePath, imageOptions);
        imageParts.push({ type: "image_url", image_url: { url: img.dataUrl } });
        if (img.change) {
          notices.push(describeImageChange(img.filename, img.change));
          fileContents.push(imageNote(filePath, img.change));
        }
      } catch (e) {
        fileContents.push(`\n<!-- failed to attach image ${basename(filePath)}: ${(e as Error).message} -->\n`);
      }
    } else {
      try {
        const content = await readFile(filePath, "utf8");
        const relPath = filePath.startsWith(cwd) ? filePath.slice(cwd.length + 1) : filePath;
        fileContents.push(`\n--- ${relPath} ---\n${content}\n--- end ${relPath} ---\n`);
      } catch (e) {
        fileContents.push(`\n<!-- failed to read ${basename(filePath)}: ${(e as Error).message} -->\n`);
      }
    }
  }

  if (fileContents.length > 0) text += "\n\n" + fileContents.join("\n");
  if (imageParts.length === 0) return { content: text, notices };
  return { content: [{ type: "text", text }, ...imageParts], notices };
}
