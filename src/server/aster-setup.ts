import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, link, mkdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { loadAsterServerConfig, localAsterConfigPath, type AsterServerConfig, type AsterWorkspace } from "./aster-workspaces.js";

export interface WriteLocalAsterConfigOptions {
  workspacePaths: string[];
  /** An empty list selects the live OpenRouter model catalog. */
  models?: string[];
  configPath?: string;
  env?: NodeJS.ProcessEnv;
}

export interface WrittenLocalAsterConfig {
  path: string;
  config: AsterServerConfig;
  selectedWorkspaces: AsterWorkspace[];
}

/** Create a private local config without credentials, or reuse it when it already
 * contains every requested Git root. Existing unrelated workspaces are preserved.
 */
export async function setupLocalAsterConfig(
  options: WriteLocalAsterConfigOptions,
): Promise<WrittenLocalAsterConfig> {
  if (options.workspacePaths.length === 0 || options.workspacePaths.length > 100) {
    throw new Error("provide between 1 and 100 Git workspace roots");
  }
  const models = [...new Set((options.models ?? []).map((model) => model.trim()))];
  if (models.some((model) => !model || model.length > 200) || models.length > 100) {
    throw new Error("models must contain at most 100 non-empty IDs of at most 200 characters");
  }

  const requestedWorkspaces = await createWorkspaceEntries(options.workspacePaths);
  const env = options.env ?? process.env;
  const requestedPath = options.configPath?.trim() || env.AUTOPILOT_ASTER_CONFIG?.trim() || localAsterConfigPath(env);
  const path = resolve(requestedPath);

  if (existsSync(path)) {
    const config = await loadAsterServerConfig(path);
    const selectedWorkspaces = requestedWorkspaces.map((requested) => {
      const existing = config.workspaces.find((workspace) => workspace.rootPath === requested.rootPath);
      if (!existing) {
        throw new Error(`Aster config already exists at ${path} and does not include ${requested.displayName}; it was left unchanged`);
      }
      return existing;
    });
    return { path, config, selectedWorkspaces };
  }

  const config = {
    models: models.length > 0 ? models : "openrouter",
    workspaces: requestedWorkspaces,
  };
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700).catch(() => {});

  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    await chmod(temporaryPath, 0o600);
    const validated = await loadAsterServerConfig(temporaryPath);
    // A hard link gives no-clobber semantics if another setup wins the race.
    await link(temporaryPath, path);
    await rm(temporaryPath);
    return { path, config: validated, selectedWorkspaces: validated.workspaces };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (isAlreadyExists(error)) {
      // Concurrent first-run setup: re-read and reuse only if the same roots won.
      return setupLocalAsterConfig(options);
    }
    throw error;
  }
}

async function createWorkspaceEntries(paths: string[]): Promise<AsterWorkspace[]> {
  const usedIds = new Set<string>();
  const workspaces: AsterWorkspace[] = [];
  for (const input of paths) {
    const requested = resolve(input);
    let root: string;
    try {
      root = await realpath(requested);
      if (!(await stat(root)).isDirectory()) throw new Error("not a directory");
      const output = execFileSync("git", ["-C", root, "rev-parse", "--show-toplevel"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const gitRoot = await realpath(output.trim());
      if (gitRoot !== root) {
        throw new Error(`workspace must be the Git repository root (received ${root}; repository root is ${gitRoot})`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("workspace must be the Git repository root")) throw error;
      throw new Error(`workspace must be an existing Git repository root: ${input}`);
    }

    const displayName = (basename(root) || root).slice(0, 100);
    const baseId = workspaceSlug(displayName);
    let id = baseId;
    for (let suffix = 2; usedIds.has(id); suffix++) {
      id = `${baseId.slice(0, 64 - String(suffix).length - 1)}-${suffix}`;
    }
    usedIds.add(id);
    workspaces.push({ id, displayName, rootPath: root });
  }
  return workspaces;
}

function workspaceSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_]+$/, "")
    .slice(0, 64);
  return slug || "workspace";
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}
