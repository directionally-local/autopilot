import type { SqliteDatabase } from "../util/sqlite.js";
import type { LlmAuth } from "../agent/llm-auth.js";
import type { SemanticSkillRoutingResult, SectionResult } from "./types.js";
import { searchSections } from "./search.js";
import { buildSkillContext } from "./format.js";

export interface RouterOptions {
  /** User's raw prompt */
  prompt: string;
  /** Budget tier: light = 2k, medium = 8k, heavy = 24k */
  tier: "light" | "medium" | "heavy";
  /** Hard ceiling for this turn */
  maxSkillTokens?: number;
}

export interface RouterDeps extends LlmAuth {
  db: SqliteDatabase;
  embeddingModel?: string;
}

/**
 * Select relevant skill sections using semantic search and pack them
 * into the token budget.
 */
export async function selectSkills(
  opts: RouterOptions,
  deps: RouterDeps
): Promise<SemanticSkillRoutingResult> {
  const { db, embeddingModel, ...auth } = deps;
  const sections = await searchSections(opts.prompt, db, { ...auth, model: embeddingModel });

  return buildSkillContext(sections, opts.tier, opts.maxSkillTokens);
}

/**
 * Synchronous version for testing packing logic without embeddings.
 */
export function selectSkillsFromSections(
  sections: SectionResult[],
  opts: Pick<RouterOptions, "tier" | "maxSkillTokens">
): SemanticSkillRoutingResult {
  return buildSkillContext(sections, opts.tier, opts.maxSkillTokens);
}
