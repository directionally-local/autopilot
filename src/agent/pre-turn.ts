import type { AgentTurnOpts } from "./loop.js";
import { pickLlmAuth } from "./llm-auth.js";
import type { ChatMessage } from "./messages.js";
import { hasRecalledMemory, injectRecalledMemoryOnce } from "../memory/recall-inject.js";
import type { MemoryRecallDebug } from "../cost-debug.js";
import { selectSkills } from "../skills/router.js";
import type { SemanticSkillRoutingResult } from "../skills/types.js";
import { buildSessionPrefix, buildSystemPrompt } from "./system-prompt.js";

/**
 * Pre-turn phase of the agent loop (#951): everything that happens before the
 * first model request of a turn — session-start memory recall, semantic skill
 * routing with the resulting system-prompt rebuild, and the per-turn
 * delegation directive. All three run in parallel and are non-fatal except
 * abort, which propagates. Mutates `opts.messages` in place (memory
 * injection, skill-aware system prompt) exactly as the inline loop did.
 */

export interface PreTurnResult {
  /** Plain text of the last user message ("" when none). */
  lastUserPrompt: string;
  /** Per-turn harness delegation recommendation, resolved. */
  delegationDirective: string | undefined;
  /** Semantic skill routing outcome, when routing ran and found skills. */
  skillResult: SemanticSkillRoutingResult | undefined;
  /** Cost-debug gate decision for session-start memory recall. */
  memoryRecallDebug: MemoryRecallDebug;
  /** How many memories were injected this turn (0 when recall was skipped). */
  memoryRecalledCount: number;
  /** Wall-clock milliseconds spent in the pre-turn phase. */
  preTurnMs: number;
}

function extractLastUserText(messages: ChatMessage[]): string {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) return "";
  if (typeof lastUser.content === "string") return lastUser.content;
  if (Array.isArray(lastUser.content)) {
    return lastUser.content
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join(" ");
  }
  return "";
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new DOMException("aborted", "AbortError"));
      } else {
        signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      }
    }),
  ]);
}

export async function prepareTurn(opts: AgentTurnOpts): Promise<PreTurnResult> {
  const preTurnStart = performance.now();
  let memoryRecalledCount = 0;
  let skillResult: SemanticSkillRoutingResult | undefined;

  const lastUserPrompt = extractLastUserText(opts.messages);

  // Light + trivially short prompts skip skill routing entirely. These almost
  // never benefit from injected skills and the embeddings round-trip dominates
  // their wall-clock time. Threshold is conservative — anything substantive
  // crosses 40 chars quickly.
  const skipSkillRouting =
    opts.intentClassification?.tier === "light" &&
    lastUserPrompt.length < 40;

  // Session-start recall is a ONE-SHOT: the supervisor reuses the same recall
  // promise across every runAgentTurn invocation, so without this guard we
  // re-synthesize (a byte-different paraphrase) and re-splice a recall block on
  // every turn, stacking duplicates at the front of the array and busting the
  // prompt-prefix cache. Skip entirely once a block is already present.
  //
  // `memoryRecallDebug` records the gate decision for cost-debug.jsonl —
  // "memory never fires" was undebuggable when only a boolean was logged.
  const memoryRecallDebug: MemoryRecallDebug = { attempted: false, candidates: 0, injected: false };
  if (!opts.sessionStartRecall || !opts.memoryManager) memoryRecallDebug.reason = "disabled";
  else if (hasRecalledMemory(opts.messages)) memoryRecallDebug.reason = "already-present";
  const recallPromise: Promise<{ text: string; count: number } | null> =
    opts.sessionStartRecall && opts.memoryManager && !hasRecalledMemory(opts.messages)
      ? (async () => {
          memoryRecallDebug.attempted = true;
          const results = await opts.sessionStartRecall!(lastUserPrompt || opts.cwd);
          memoryRecallDebug.candidates = results.length;
          if (results.length === 0 || !opts.memoryManager) {
            memoryRecallDebug.reason = "no-results";
            return null;
          }
          const text = await opts.memoryManager.synthesizeRecalled(results, opts.signal);
          if (!text) {
            memoryRecallDebug.reason = "synthesis-empty";
            return null;
          }
          return { text, count: results.length };
        })()
      : Promise.resolve(null);

  const skillsPromise: Promise<SemanticSkillRoutingResult | undefined> =
    opts.skillsDb && opts.skillRoutingConfig && opts.intentClassification && lastUserPrompt && !skipSkillRouting
      ? selectSkills(
          {
            prompt: lastUserPrompt,
            tier: opts.intentClassification.tier,
            maxSkillTokens: opts.skillRoutingConfig.maxSkillTokens ?? 250_000 - 10_000,
          },
          {
            db: opts.skillsDb,
            ...(opts.skillRoutingConfig.embeddingAuth ?? pickLlmAuth(opts)),
            embeddingModel: opts.skillRoutingConfig.embeddingModel,
          },
        )
      : Promise.resolve(undefined);

  const [recallSettled, skillsSettled, directiveSettled] = await Promise.allSettled([
    raceWithSignal(recallPromise, opts.signal),
    raceWithSignal(skillsPromise, opts.signal),
    raceWithSignal(Promise.resolve(opts.delegationDirective), opts.signal),
  ]);
  const delegationDirective = directiveSettled.status === "fulfilled" ? directiveSettled.value : undefined;

  // Propagate abort; swallow other failures (all paths are non-fatal).
  for (const settled of [recallSettled, skillsSettled, directiveSettled]) {
    if (
      settled.status === "rejected" &&
      settled.reason instanceof DOMException &&
      settled.reason.name === "AbortError"
    ) {
      throw settled.reason;
    }
  }

  if (recallSettled.status === "fulfilled" && recallSettled.value) {
    const { text, count } = recallSettled.value;
    if (injectRecalledMemoryOnce(opts.messages, text)) {
      memoryRecalledCount = count;
      memoryRecallDebug.injected = true;
      delete memoryRecallDebug.reason;
      opts.callbacks.onMemoryRecalled?.(count);
    }
  } else if (recallSettled.status === "rejected") {
    // Abort rejections rethrow above; only genuine recall errors land here.
    memoryRecallDebug.reason = "error";
  }

  if (skillsSettled.status === "fulfilled" && skillsSettled.value) {
    skillResult = skillsSettled.value;
    opts.callbacks.onSkillsSelected?.(skillResult);

    const allTools = opts.tools;
    if (opts.cacheStable) {
      opts.messages[1] = {
        role: "system",
        content: buildSessionPrefix({
          cwd: opts.cwd,
          tools: allTools,
          model: opts.model,
          mode: opts.mode,
          skillContext: skillResult.skillContext,
          preferPullRequests: opts.preferPullRequests,
          ...(opts.headless ? { headless: true } : {}),
        }),
      };
    } else {
      opts.messages[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: opts.cwd,
          tools: allTools,
          model: opts.model,
          mode: opts.mode,
          skillContext: skillResult.skillContext,
          preferPullRequests: opts.preferPullRequests,
          ...(opts.headless ? { headless: true } : {}),
        }),
      };
    }
  }

  if (opts.signal.aborted) {
    throw new DOMException("aborted", "AbortError");
  }

  const preTurnMs = Math.round(performance.now() - preTurnStart);

  opts.callbacks.onMetaBanner?.({
    intentTier: opts.intentClassification?.tier ?? "medium",
    skillsActive: skillResult?.sectionCount ?? 0,
    memoryRecalled: memoryRecalledCount > 0,
  });

  return {
    lastUserPrompt,
    delegationDirective,
    skillResult,
    memoryRecallDebug,
    memoryRecalledCount,
    preTurnMs,
  };
}
