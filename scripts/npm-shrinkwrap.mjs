#!/usr/bin/env node
/**
 * Builds npm-shrinkwrap.json from package-lock.json, production dependencies
 * only.
 *
 * Why: dl installs autopilot-ai with an exact version, but npm resolves the
 * ~180 transitive dependencies from ranges, so a hijacked dependency release
 * reaches users on their next install. The shrinkwrap pins the whole
 * production tree to the versions package-lock.json already resolved.
 *
 * npm honors this file for consumers: arborist loads a dependency's shrinkwrap
 * only when the node's hasShrinkwrap flag is set, which comes from the
 * manifest's _hasShrinkwrap field (@npmcli/arborist lib/node.js and
 * lib/arborist/build-ideal-tree.js). The registry adds that field to the
 * packument when the tarball contains npm-shrinkwrap.json; pacote does not set
 * it for a local file/tarball install, so installing a packed tarball locally
 * cannot demonstrate the pinning. Check it against a published version.
 *
 * Why it is generated in `prepack` instead of committed: npm prefers
 * npm-shrinkwrap.json over package-lock.json, so a production-only shrinkwrap
 * at the repo root makes `npm ci` fail with "Missing: <dev dep> from lock
 * file" (npm compares package.json's devDependencies against the shrinkwrap).
 * Generating it at pack time keeps dev installs on package-lock.json and still
 * puts the pinned tree in the published tarball; "files" in package.json lists
 * it so npm includes it, and `postpack` removes it again so a local pack cannot
 * leave a production-only lockfile behind.
 *
 * Version fields come from package.json, so a release-please bump (which
 * updates package.json and package-lock.json together) can never leave the
 * shrinkwrap stale. release-please's node strategy also pushes an update for a
 * committed npm-shrinkwrap.json (it updates both lockfiles), so this stays
 * correct if the file is ever committed.
 *
 * Usage:
 *   node scripts/npm-shrinkwrap.mjs --write   # write npm-shrinkwrap.json
 *   node scripts/npm-shrinkwrap.mjs --clean   # remove it again (postpack)
 *   node scripts/npm-shrinkwrap.mjs --check   # verify it matches the lockfile
 *   node scripts/npm-shrinkwrap.mjs --json    # print the shrinkwrap
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHRINKWRAP = "npm-shrinkwrap.json";

/** Root-entry fields copied from package.json, in a stable order. */
const ROOT_FIELDS = ["name", "version", "license", "bin", "engines", "dependencies", "optionalDependencies"];

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

/**
 * True when npm installs this lockfile entry for a production install.
 *
 * `dev` entries are only reachable from devDependencies and are skipped by
 * `--omit=dev`. `devOptional` entries are kept: they are optional dependencies
 * of a non-dev dependency, so npm installs them with `--omit=dev` too, and
 * leaving them out would let them float.
 */
export function isProduction(entry) {
  return !entry.dev;
}

/**
 * The production subset of a lockfile, as an npm-shrinkwrap.json object.
 * Entries npm marks `dev` (only reachable from devDependencies) are dropped,
 * which is what `npm install --omit=dev` would skip.
 */
export function buildShrinkwrap(pkg, lock) {
  const packages = {};
  for (const path of Object.keys(lock.packages ?? {}).sort()) {
    if (path === "") continue;
    const entry = lock.packages[path];
    if (!isProduction(entry)) continue;
    packages[path] = entry;
  }

  const root = {};
  for (const field of ROOT_FIELDS) {
    if (pkg[field] !== undefined) root[field] = pkg[field];
  }

  return {
    name: pkg.name,
    version: pkg.version,
    lockfileVersion: lock.lockfileVersion,
    requires: true,
    packages: { "": root, ...packages },
  };
}

function sorted(value) {
  return Object.fromEntries(Object.entries(value ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/** Every way `shrinkwrap` disagrees with package.json and package-lock.json. */
export function validateShrinkwrap(shrinkwrap, pkg, lock) {
  const problems = [];
  const root = shrinkwrap.packages?.[""];

  if (shrinkwrap.name !== pkg.name) problems.push(`name is ${shrinkwrap.name}, package.json says ${pkg.name}`);
  if (shrinkwrap.version !== pkg.version) {
    problems.push(`version is ${shrinkwrap.version}, package.json says ${pkg.version}`);
  }
  if (shrinkwrap.lockfileVersion !== lock.lockfileVersion) {
    problems.push(`lockfileVersion is ${shrinkwrap.lockfileVersion}, package-lock.json says ${lock.lockfileVersion}`);
  }

  if (!root) {
    problems.push("the root package entry is missing");
  } else {
    if (root.name !== pkg.name) problems.push(`root name is ${root.name}, package.json says ${pkg.name}`);
    if (root.version !== pkg.version) problems.push(`root version is ${root.version}, package.json says ${pkg.version}`);
    if (root.devDependencies) problems.push("the root entry lists devDependencies; this shrinkwrap is production-only");
    for (const field of ["dependencies", "optionalDependencies"]) {
      const want = JSON.stringify(sorted(pkg[field]));
      const got = JSON.stringify(sorted(root[field]));
      if (want !== got) problems.push(`root ${field} does not match package.json`);
    }
  }

  // package-lock.json must describe the same production ranges, or the
  // shrinkwrap would pin a tree the lockfile no longer agrees with.
  for (const field of ["dependencies", "optionalDependencies"]) {
    const want = JSON.stringify(sorted(pkg[field]));
    const got = JSON.stringify(sorted(lock.packages?.[""]?.[field]));
    if (want !== got) problems.push(`package-lock.json's root ${field} is out of date; run npm install`);
  }

  const expected = new Set();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "") continue;
    if (!isProduction(entry)) continue;
    expected.add(path);
    const got = shrinkwrap.packages?.[path];
    if (!got) {
      problems.push(`${path} is missing`);
      continue;
    }
    for (const field of ["version", "resolved", "integrity"]) {
      if (got[field] !== entry[field]) {
        problems.push(`${path}: ${field} is ${got[field]}, package-lock.json says ${entry[field]}`);
      }
    }
  }

  for (const path of Object.keys(shrinkwrap.packages ?? {})) {
    if (path === "") continue;
    if (expected.has(path)) continue;
    const entry = lock.packages?.[path];
    problems.push(
      entry && !isProduction(entry)
        ? `${path} is a dev-only package`
        : `${path} is not in package-lock.json`,
    );
  }

  for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) {
    if (!shrinkwrap.packages?.[`node_modules/${name}`]) problems.push(`declared dependency ${name} is not pinned`);
  }

  return problems;
}

function main(argv) {
  const pkg = readJson(join(ROOT, "package.json"));
  const lock = readJson(join(ROOT, "package-lock.json"));
  const target = join(ROOT, SHRINKWRAP);
  const expected = buildShrinkwrap(pkg, lock);
  const count = Object.keys(expected.packages).length - 1;

  if (argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(expected, null, 2)}\n`);
    return 0;
  }

  if (argv.includes("--clean")) {
    rmSync(target, { force: true });
    return 0;
  }

  if (argv.includes("--write")) {
    const problems = validateShrinkwrap(expected, pkg, lock);
    if (problems.length > 0) {
      console.error(`✗ couldn't build ${SHRINKWRAP} from package-lock.json:`);
      for (const problem of problems) console.error(`  - ${problem}`);
      return 1;
    }
    writeFileSync(target, `${JSON.stringify(expected, null, 2)}\n`);
    // stderr: prepack runs inside `npm pack --json`, whose stdout must stay JSON.
    console.error(`✓ wrote ${SHRINKWRAP}: ${count} production packages pinned at ${pkg.version}`);
    return 0;
  }

  const problems = validateShrinkwrap(expected, pkg, lock);
  if (existsSync(target)) {
    const actual = readJson(target);
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      problems.push(`${SHRINKWRAP} on disk is stale; run node scripts/npm-shrinkwrap.mjs --write`);
    }
  }

  if (problems.length > 0) {
    console.error(`✗ ${SHRINKWRAP} is not in sync with package-lock.json:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    return 1;
  }

  console.error(`✓ ${SHRINKWRAP} matches package-lock.json: ${count} production packages at ${pkg.version}`);
  return 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  // exitCode, not process.exit(): --json writes ~80 KB, and process.exit()
  // truncates a stdout write that has not drained yet.
  process.exitCode = main(process.argv.slice(2));
}
