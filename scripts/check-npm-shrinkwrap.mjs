#!/usr/bin/env node
/**
 * CI check: the published tarball carries a production-only npm-shrinkwrap.json
 * that matches package-lock.json.
 *
 * `npm pack` runs `prepack`, which writes the shrinkwrap, computes the packlist,
 * then runs `postpack`, which removes the file again. This checks both halves
 * of the guarantee: the tarball lists the file, and the file prepack writes is
 * the production subset of the lockfile at the version in package.json.
 *
 * Usage: node scripts/check-npm-shrinkwrap.mjs
 * Exit: 0 the tarball is pinned, 1 it is missing or stale.
 */

import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildShrinkwrap, readJson, validateShrinkwrap } from "./npm-shrinkwrap.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SHRINKWRAP = "npm-shrinkwrap.json";
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

const pkg = readJson(join(ROOT, "package.json"));
const lock = readJson(join(ROOT, "package-lock.json"));
const target = join(ROOT, SHRINKWRAP);
const problems = [];

try {
  const pack = spawnSync(NPM, ["pack", "--dry-run", "--json"], { cwd: ROOT, encoding: "utf8" });
  if (pack.status !== 0) {
    problems.push(`npm pack --dry-run failed:\n${(pack.stderr || pack.stdout || "").trim()}`);
  } else {
    let info;
    try {
      [info] = JSON.parse(pack.stdout);
    } catch {
      // A lifecycle script that writes to stdout would land before the JSON.
      try {
        [info] = JSON.parse(pack.stdout.slice(pack.stdout.indexOf("[")));
      } catch {
        problems.push("couldn't parse the output of npm pack --dry-run --json");
      }
    }
    if (info) {
      const paths = (info.files ?? []).map((file) => file.path);
      if (!paths.includes(SHRINKWRAP)) {
        problems.push(`npm pack --dry-run does not include ${SHRINKWRAP}; add it to "files" in package.json`);
      }
    }
  }

  // postpack has already removed the file, so write it the same way prepack
  // does and validate that.
  const write = spawnSync(process.execPath, [join(ROOT, "scripts", "npm-shrinkwrap.mjs"), "--write"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (write.status !== 0) {
    problems.push(`couldn't generate ${SHRINKWRAP}:\n${(write.stderr || write.stdout || "").trim()}`);
  } else {
    const actual = readJson(target);
    problems.push(...validateShrinkwrap(actual, pkg, lock));
    if (JSON.stringify(actual) !== JSON.stringify(buildShrinkwrap(pkg, lock))) {
      problems.push(`${SHRINKWRAP} is not the production subset of package-lock.json`);
    }
  }
} finally {
  // postpack removes it after a pack; a failed run must not leave it behind.
  rmSync(target, { force: true });
}

if (problems.length > 0) {
  console.error(`✗ ${SHRINKWRAP} check failed:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

const count = Object.keys(buildShrinkwrap(pkg, lock).packages).length - 1;
console.log(`✓ ${SHRINKWRAP} is in the tarball and matches package-lock.json: ${count} production packages at ${pkg.version}`);
