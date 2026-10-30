import { mkdir, writeFile, unlink, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parseFrontmatter } from "../util/frontmatter.js";
import type { Skill } from "./types.js";
import { loadSkillsFromDir } from "./loader.js";
import { configPath, legacyProjectDir, projectDir } from "../util/app-dirs.js";

export interface SkillDirInfo {
  /** Where new project skills are created (`.autopilot/skills`). */
  projectDir: string;
  /** Pre-rename project skills (`.kimiflare/skills`): still listed. */
  legacyProjectDir: string;
  globalDir: string;
}

export function getSkillDirs(cwd: string): SkillDirInfo {
  return {
    projectDir: join(projectDir(cwd), "skills"),
    legacyProjectDir: join(legacyProjectDir(cwd), "skills"),
    globalDir: configPath("skills"),
  };
}

export async function listAllSkills(cwd: string): Promise<{
  project: Skill[];
  global: Skill[];
}> {
  const dirs = getSkillDirs(cwd);
  const [project, legacy, global] = await Promise.all([
    loadSkillsFromDir(dirs.projectDir).catch(() => [] as Skill[]),
    loadSkillsFromDir(dirs.legacyProjectDir).catch(() => [] as Skill[]),
    loadSkillsFromDir(dirs.globalDir).catch(() => [] as Skill[]),
  ]);
  const seen = new Set(project.map((s) => s.name));
  return { project: [...project, ...legacy.filter((s) => !seen.has(s.name))], global };
}

export interface CreateSkillOptions {
  name: string;
  description?: string;
  match?: string[];
  scope: "project" | "global";
  cwd: string;
}

export async function createSkill(opts: CreateSkillOptions): Promise<{ filepath: string }> {
  const dirs = getSkillDirs(opts.cwd);
  const dir = opts.scope === "project" ? dirs.projectDir : dirs.globalDir;
  const filepath = join(dir, `${opts.name}.md`);

  const frontmatter: Record<string, unknown> = {
    name: opts.name,
    enabled: true,
    priority: 0,
  };
  if (opts.description) frontmatter.description = opts.description;
  if (opts.match && opts.match.length > 0) frontmatter.match = opts.match;

  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((item) => `  - ${item}`).join("\n")}`;
      return `${k}: ${v}`;
    })
    .join("\n");

  const content = `---\n${yaml}\n---\n\n# ${opts.name}\n\nAdd your instructions here.\n`;

  await mkdir(dir, { recursive: true });
  await writeFile(filepath, content, "utf8");

  return { filepath };
}

export async function deleteSkill(name: string, cwd: string): Promise<{ filepath: string }> {
  const all = await listAllSkills(cwd);
  const skill =
    all.project.find((s) => s.name === name) ?? all.global.find((s) => s.name === name);
  if (!skill) throw new Error(`skill "${name}" not found`);
  await unlink(skill.filePath);
  return { filepath: skill.filePath };
}

export async function setSkillEnabled(
  name: string,
  enabled: boolean,
  cwd: string,
): Promise<{ filepath: string }> {
  const all = await listAllSkills(cwd);
  const skill =
    all.project.find((s) => s.name === name) ?? all.global.find((s) => s.name === name);
  if (!skill) throw new Error(`skill "${name}" not found`);

  const raw = await readFile(skill.filePath, "utf-8");
  const parsed = parseFrontmatter(raw);
  parsed.data.enabled = enabled;

  const yaml = Object.entries(parsed.data)
    .map(([k, v]) => {
      if (Array.isArray(v)) return `${k}:\n${v.map((item) => `  - ${item}`).join("\n")}`;
      return `${k}: ${v}`;
    })
    .join("\n");

  const content = `---\n${yaml}\n---\n${parsed.content}`;
  await writeFile(skill.filePath, content, "utf8");

  return { filepath: skill.filePath };
}

export async function findSkillFile(name: string, cwd: string): Promise<string | null> {
  const all = await listAllSkills(cwd);
  const skill =
    all.project.find((s) => s.name === name) ?? all.global.find((s) => s.name === name);
  return skill?.filePath ?? null;
}
