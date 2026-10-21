import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** A paired Autopilot server. The token is an Aster client credential, never a provider key. */
export interface RemoteServer {
  name: string;
  url: string;
  token: string;
  credentialId: string;
  expiresAt: string;
  addedAt: string;
}

interface RemotesFile {
  version: 1;
  remotes: RemoteServer[];
}

export const REMOTE_NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function remotesPath(env: NodeJS.ProcessEnv = process.env): string {
  if (env.AUTOPILOT_REMOTES_FILE) return env.AUTOPILOT_REMOTES_FILE;
  const configHome = env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(configHome, "autopilot", "remotes.json");
}

export async function loadRemotes(path = remotesPath()): Promise<RemoteServer[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const parsed = JSON.parse(raw) as Partial<RemotesFile>;
  return Array.isArray(parsed.remotes) ? parsed.remotes.filter(isRemote) : [];
}

/** Adds or replaces a remote by name. The file holds bearer tokens, so it is 0600 in a 0700 directory. */
export async function saveRemote(remote: RemoteServer, path = remotesPath()): Promise<void> {
  const remotes = (await loadRemotes(path)).filter((entry) => entry.name !== remote.name);
  remotes.push(remote);
  await writeRemotes(remotes, path);
}

export async function removeRemote(name: string, path = remotesPath()): Promise<boolean> {
  const remotes = await loadRemotes(path);
  const kept = remotes.filter((entry) => entry.name !== name);
  if (kept.length === remotes.length) return false;
  await writeRemotes(kept, path);
  return true;
}

/** The named remote, or the only one when no name is given. */
export async function resolveRemote(name: string | undefined, path = remotesPath()): Promise<RemoteServer> {
  const remotes = await loadRemotes(path);
  if (remotes.length === 0) throw new Error("No servers paired yet. Run: autopilot remote add https://your-server");
  if (name === undefined) {
    if (remotes.length === 1) return remotes[0]!;
    throw new Error(`Several servers are paired; pick one with --on (${remotes.map((entry) => entry.name).join(", ")})`);
  }
  const remote = remotes.find((entry) => entry.name === name);
  if (!remote) throw new Error(`No server named "${name}". Paired: ${remotes.map((entry) => entry.name).join(", ")}`);
  return remote;
}

/** A short default name from the URL's host: https://acme.example.com -> acme. */
export function defaultRemoteName(url: string): string {
  const host = new URL(url).hostname.toLowerCase();
  const label = /^\d+(\.\d+){3}$/.test(host) ? host.replace(/\./g, "-") : host.split(".")[0] ?? "server";
  const name = label.replace(/[^a-z0-9-]/g, "-").replace(/^-+/, "").slice(0, 40);
  return REMOTE_NAME_RE.test(name) ? name : "server";
}

/** Server URLs must be HTTPS, except loopback (an SSH tunnel or local testing). */
export function normalizeServerUrl(input: string): string {
  let url: URL;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(input) ? input : `https://${input}`);
  } catch {
    throw new Error(`Not a URL: ${input}`);
  }
  const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || url.hostname.startsWith("127.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("Use an https:// server URL (http:// is only allowed for localhost)");
  }
  if (url.username || url.password || url.search || url.hash) throw new Error("The server URL must not include credentials, a query, or a fragment");
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

async function writeRemotes(remotes: RemoteServer[], path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify({ version: 1, remotes } satisfies RemotesFile, null, 2)}\n`, { mode: 0o600 });
  await chmod(temp, 0o600);
  await rename(temp, path);
}

function isRemote(value: unknown): value is RemoteServer {
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  return ["name", "url", "token", "credentialId", "expiresAt", "addedAt"].every((key) => typeof entry[key] === "string");
}
