/**
 * The project tour's one model call, on the session's own provider and model
 * (so it works with the free tier and with any key). Capped by the caller's
 * `maxTokens`, low reasoning, no tools, no retries: when it is slow or fails
 * the tour falls back to local suggestions.
 */
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { runKimi } from "../agent/client.js";
import type { Cfg } from "../app.js";
import type { AskModel } from "./project-tour.js";

export function tourAskModel(cfg: Pick<Cfg, "model"> & Parameters<typeof llmAuthFromConfig>[0]): AskModel | null {
  if (!cfg?.model) return null;
  const auth = llmAuthFromConfig(cfg);
  return async ({ system, user, maxTokens, signal }) => {
    let text = "";
    for await (const ev of runKimi({
      ...auth,
      model: cfg.model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      signal,
      temperature: 0.3,
      reasoningEffort: "low",
      maxCompletionTokens: maxTokens,
      networkRetries: 0,
      idleTimeoutMs: 10_000,
    })) {
      if (ev.type === "text") text += ev.delta;
    }
    return text;
  };
}
