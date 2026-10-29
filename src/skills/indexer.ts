import type { SqliteDatabase } from "../util/sqlite.js";
import { pickLlmAuth, type LlmAuth } from "../agent/llm-auth.js";
import { embeddingModelFor, fetchEmbeddings } from "../memory/embeddings.js";
import { discoverSkills, readSkillFile } from "./discovery.js";
import { parseSkillFile, parseAgentsMd } from "./parser.js";
import type { ParsedSkill } from "./types.js";
import {
  initSkillsSchema,
  upsertSkill,
  insertSections,
  deleteOrphanedSkills,
  getSkillByPath,
  setSkillEmbeddingModel,
} from "./db.js";

export interface IndexerOpts extends LlmAuth {
  cwd: string;
  db: SqliteDatabase;
  embeddingModel?: string;
}

/**
 * Build the embedding input for a section.
 * Prepends skill name/description to give the embedding model context.
 */
function buildEmbeddingInput(skill: ParsedSkill, section: ParsedSkill["sections"][number]): string {
  return `${skill.name}: ${skill.description}\n\n${section.heading}\n${section.body}`;
}

/**
 * Index all discoverable skills into the database.
 * Skips files whose content_hash matches the stored hash.
 * Removes skills whose files no longer exist.
 */
export async function indexSkills(opts: IndexerOpts): Promise<{
  indexed: number;
  skipped: number;
  removed: number;
  errors: string[];
}> {
  initSkillsSchema(opts.db);

  const discovered = await discoverSkills(opts.cwd);
  const errors: string[] = [];
  const parsedSkills: ParsedSkill[] = [];

  // Parse all discovered files
  for (const file of discovered) {
    try {
      const { text } = await readSkillFile(file.filePath);
      if (file.source === "agents-md") {
        const skills = parseAgentsMd(file.filePath, text);
        parsedSkills.push(...skills);
      } else {
        const skill = parseSkillFile(file.filePath, text);
        parsedSkills.push(skill);
      }
    } catch (err) {
      errors.push(`Failed to parse ${file.filePath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Deduplicate by skill name (first wins based on discovery order)
  const seenNames = new Set<string>();
  const deduped: ParsedSkill[] = [];
  for (const skill of parsedSkills) {
    if (seenNames.has(skill.name)) continue;
    seenNames.add(skill.name);
    deduped.push(skill);
  }

  let indexed = 0;
  let skipped = 0;
  // Embeddings follow the provider: a changed provider/model re-embeds every
  // skill; a provider without embeddings stores sections for keyword search.
  const model = embeddingModelFor(opts, opts.embeddingModel);

  for (const skill of deduped) {
    const existing = getSkillByPath(opts.db, skill.filePath);
    if (
      existing &&
      existing.contentHash === skill.contentHash &&
      existing.parserVersion === skill.parserVersion &&
      existing.embeddingModel === model
    ) {
      skipped++;
      continue;
    }

    // Upsert skill (clears old sections)
    const skillId = upsertSkill(opts.db, skill);

    // Embed sections
    if (skill.sections.length > 0) {
      let embeddings: Float32Array[] = [];
      let embeddedWith: string | null = null;
      if (model) {
        const inputs = skill.sections.map((section) => buildEmbeddingInput(skill, section));
        try {
          embeddings = await fetchEmbeddings({ ...pickLlmAuth(opts), model, texts: inputs });
          embeddedWith = model;
        } catch (err) {
          errors.push(
            `Failed to embed sections for ${skill.filePath} (keyword search only until the next index): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
      insertSections(opts.db, skillId, skill.sections, embeddings);
      setSkillEmbeddingModel(opts.db, skillId, embeddedWith);
    }

    indexed++;
  }

  // Remove orphaned skills
  const existingPaths = deduped.map((s) => s.filePath);
  const removed = deleteOrphanedSkills(opts.db, existingPaths);

  return { indexed, skipped, removed, errors };
}
