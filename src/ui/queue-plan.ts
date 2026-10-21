// `/queue plan`: coordinating several queued follow-ups.

import type { QueuedPrompt } from "../agent/queue-batch.js";

export type QueuePlanChoice = "group" | "separate" | null;

/** The individual follow-ups a `/queue plan` covers (a grouped batch counts
 *  as its parts). Shared with the Camouflage view. */
export function queuePlanPreview(prompts: QueuedPrompt[]): { key: string; text: string }[] {
  return prompts.flatMap((prompt) =>
    prompt.batchPrompts
      ? prompt.batchPrompts.map((text, index) => ({ key: `${prompt.key}-${index}`, text }))
      : [{ key: prompt.key, text: prompt.display }],
  );
}
