import { readdir, stat, readFile } from "node:fs/promises";
import { join, basename, extname } from "node:path";
import { legacyProjectDir, projectDir } from "../util/app-dirs.js";

export interface DiscoveredFile {
  filePath: string;
  source: "agents" | "agents-md" | "github" | "autopilot" | "kimiflare";
}

const SKILL_EXTENSIONS = new Set([".md"]);

async function dirExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    return s.isFile();
  } catch {
    return false;
  }
}

async function scanSkillDir(dirPath: string, source: DiscoveredFile["source"]): Promise<DiscoveredFile[]> {
  if (!(await dirExists(dirPath))) return [];
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files: DiscoveredFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!SKILL_EXTENSIONS.has(extname(entry.name))) continue;
    files.push({ filePath: join(dirPath, entry.name), source });
  }
  return files;
}

/**
 * Discover all skill files across supported locations.
 *
 * Priority order (first match wins for deduplication):
 * 1. .agents/skills/*.md
 * 2. AGENTS.md
 * 3. .github/skills/*.md
 * 4. .autopilot/skills/*.md
 * 5. .kimiflare/skills/*.md (pre-rename location, still read)
 */
export async function discoverSkills(cwd: string): Promise<DiscoveredFile[]> {
  const agentsSkills = await scanSkillDir(join(cwd, ".agents", "skills"), "agents");
  const agentsMd: DiscoveredFile[] = (await fileExists(join(cwd, "AGENTS.md")))
    ? [{ filePath: join(cwd, "AGENTS.md"), source: "agents-md" }]
    : [];
  const githubSkills = await scanSkillDir(join(cwd, ".github", "skills"), "github");
  const autopilotSkills = await scanSkillDir(join(projectDir(cwd), "skills"), "autopilot");
  const kimiflareSkills = await scanSkillDir(join(legacyProjectDir(cwd), "skills"), "kimiflare");

  // Deduplicate by skill name (derived from filename or section heading).
  // We defer name extraction to the parser; here we just order by priority.
  const ordered = [...agentsSkills, ...agentsMd, ...githubSkills, ...autopilotSkills, ...kimiflareSkills];
  return ordered;
}

/**
 * Read raw file content as bytes and as UTF-8 string.
 */
export async function readSkillFile(filePath: string): Promise<{ bytes: Buffer; text: string }> {
  const bytes = await readFile(filePath);
  return { bytes, text: bytes.toString("utf-8") };
}
