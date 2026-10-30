import { open, realpath } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { MODES, type Mode } from "../mode.js";
import { glob } from "../util/glob.js";
import { EFFORTS, type ReasoningEffort } from "../config.js";
import { isPathOutside } from "../util/paths.js";
import { parseFrontmatter } from "./frontmatter.js";
import type { CommandSource, CustomCommand, LoadResult } from "./types.js";
import { configPath, legacyProjectDir, projectDir } from "../util/app-dirs.js";

const MAX_COMMAND_FILE_BYTES = 256 * 1024;

/** Where new project commands are saved (`.autopilot/commands`). */
export function projectCommandsDir(cwd: string = process.cwd()): string {
  return join(projectDir(cwd), "commands");
}

/** Pre-rename project commands (`.kimiflare/commands`): still read. */
export function legacyProjectCommandsDir(cwd: string = process.cwd()): string {
  return join(legacyProjectDir(cwd), "commands");
}

export function globalCommandsDir(): string {
  return configPath("commands");
}

export async function loadCustomCommands(
  cwd: string = process.cwd(),
): Promise<LoadResult> {
  const warnings: string[] = [];
  const byName = new Map<string, CustomCommand>();

  const sources: Array<{ dir: string; source: CommandSource }> = [
    { dir: globalCommandsDir(), source: "global" },
    { dir: legacyProjectCommandsDir(cwd), source: "project" },
    { dir: projectCommandsDir(cwd), source: "project" },
  ];

  const perSource = await Promise.all(
    sources.map(async ({ dir, source }) => {
      const safeDir = await resolveSafeDir(dir, source, cwd, warnings);
      if (safeDir === null) return [] as Array<CustomCommand | null>;
      const files = await glob("**/*.md", {
        cwd: safeDir,
        absolute: true,
        onlyFiles: true,
        suppressErrors: true,
      });
      return Promise.all(files.map((file) => loadOne(file, safeDir, source, warnings)));
    }),
  );
  for (const loaded of perSource) {
    for (const cmd of loaded) {
      if (!cmd) continue;
      if (byName.has(cmd.name) && byName.get(cmd.name)!.source === "global" && cmd.source === "project") {
        warnings.push(`project command /${cmd.name} shadows global command — project version will be used`);
      }
      byName.set(cmd.name, cmd);
    }
  }

  return {
    commands: [...byName.values()].sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
  };
}

async function resolveSafeDir(
  dir: string,
  source: CommandSource,
  cwd: string,
  warnings: string[],
): Promise<string | null> {
  let realDir: string;
  try {
    realDir = await realpath(dir);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      warnings.push(`commands dir ${dir} unreadable: ${(err as Error).message}`);
    }
    return null;
  }
  if (source === "project") {
    let realCwd: string;
    try {
      realCwd = await realpath(cwd);
    } catch {
      return null;
    }
    const rel = relative(realCwd, realDir);
    if (rel !== "" && isPathOutside(rel)) {
      warnings.push(`commands dir ${dir} escapes workspace via symlink — skipped`);
      return null;
    }
  }
  return realDir;
}

async function loadOne(
  file: string,
  rootDir: string,
  source: CommandSource,
  warnings: string[],
): Promise<CustomCommand | null> {
  let content: string;
  try {
    const handle = await open(file, "r");
    try {
      const stats = await handle.stat();
      if (stats.size > MAX_COMMAND_FILE_BYTES) {
        warnings.push(`command file ${file} exceeds ${MAX_COMMAND_FILE_BYTES} bytes — skipped`);
        return null;
      }
      content = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
  } catch (e) {
    warnings.push(`failed to read command file ${file}: ${(e as Error).message}`);
    return null;
  }

  const name = filenameToCommandName(file, rootDir);
  if (!name) {
    warnings.push(`invalid command name from ${file}`);
    return null;
  }

  const { data, body, errors } = parseFrontmatter(content);
  if (errors.length > 0) {
    warnings.push(`frontmatter errors in ${file}: ${errors.join("; ")} — skipped`);
    return null;
  }

  const cmd: CustomCommand = {
    name,
    template: body,
    source,
    filepath: file,
  };
  if (data.description) cmd.description = data.description;

  const modeRaw = data.mode ?? data.agent;
  if (modeRaw !== undefined) {
    const normalized = modeRaw === "build" ? "edit" : modeRaw;
    if ((MODES as readonly string[]).includes(normalized)) {
      cmd.mode = normalized as Mode;
    } else {
      warnings.push(`unknown mode "${modeRaw}" in ${file} — ignored`);
    }
  }

  if (data.model !== undefined && data.model !== "") {
    cmd.model = data.model;
  }

  if (data.effort !== undefined) {
    if ((EFFORTS as readonly string[]).includes(data.effort)) {
      cmd.effort = data.effort as ReasoningEffort;
    } else {
      warnings.push(`unknown effort "${data.effort}" in ${file} — ignored`);
    }
  }

  if (data.shell === "true" || data.shell === "yes") cmd.shell = true;
  if (data.files === "true" || data.files === "yes") cmd.files = true;

  const hasShell = /!`[^`]+`/.test(cmd.template);
  const hasFiles = /(?<![\w`])@(\.?[^\s`,]+?)/.test(cmd.template);

  if (hasShell && !cmd.shell) {
    warnings.push(`command /${cmd.name} contains shell substitution but 'shell: true' is not set — shell code will be treated as literal text`);
  }
  if (hasFiles && !cmd.files) {
    warnings.push(`command /${cmd.name} contains file inclusion but 'files: true' is not set — @file references will be treated as literal text`);
  }

  return cmd;
}

export function filenameToCommandName(file: string, rootDir: string): string | null {
  const rel = relative(rootDir, file);
  if (!rel || isPathOutside(rel)) return null;
  const noExt = rel.replace(/\.md$/i, "");
  const parts = noExt.split(sep).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  if (parts.some((p) => !/^[\w.-]+$/.test(p))) return null;
  return parts.join("/");
}
