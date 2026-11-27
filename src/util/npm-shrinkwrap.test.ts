import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// These exercise scripts/npm-shrinkwrap.mjs, which pins the published tarball's
// production tree (see the header of that script for why it is generated in
// prepack rather than committed).
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function readJson(path: string): any {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("the generated shrinkwrap pins the production tree at the package version", () => {
  const result = spawnSync(process.execPath, [join(repoRoot, "scripts", "npm-shrinkwrap.mjs"), "--json"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  assert.equal(result.status, 0, result.stderr);

  const shrinkwrap = JSON.parse(result.stdout);
  const pkg = readJson(join(repoRoot, "package.json"));
  const lock = readJson(join(repoRoot, "package-lock.json"));

  assert.equal(shrinkwrap.name, pkg.name);
  assert.equal(shrinkwrap.version, pkg.version);
  assert.equal(shrinkwrap.packages[""].version, pkg.version);
  assert.equal(shrinkwrap.packages[""].devDependencies, undefined);

  const expectedPaths = Object.entries<any>(lock.packages)
    .filter(([path, entry]) => path !== "" && !entry.dev)
    .map(([path]) => path)
    .sort();
  const actualPaths = Object.keys(shrinkwrap.packages)
    .filter((path) => path !== "")
    .sort();
  assert.deepEqual(actualPaths, expectedPaths);

  for (const [path, entry] of Object.entries<any>(shrinkwrap.packages)) {
    if (path === "") continue;
    assert.equal(entry.dev, undefined, `${path} is a dev dependency`);
    assert.equal(entry.version, lock.packages[path].version, `${path} is not pinned to the lockfile version`);
  }

  // devOptional entries are optional dependencies of a non-dev dependency, so
  // npm installs them with --omit=dev; they must stay pinned.
  for (const [path, entry] of Object.entries<any>(lock.packages)) {
    if (path === "" || !entry.devOptional) continue;
    assert.ok(shrinkwrap.packages[path], `${path} is a devOptional dependency and must be pinned`);
  }

  for (const name of [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]) {
    assert.ok(shrinkwrap.packages[`node_modules/${name}`], `${name} is not pinned`);
  }
});

test("npm pack includes npm-shrinkwrap.json and postpack removes it", () => {
  const dir = mkdtempSync(join(tmpdir(), "autopilot-pack-"));
  try {
    cpSync(join(repoRoot, "package.json"), join(dir, "package.json"));
    cpSync(join(repoRoot, "package-lock.json"), join(dir, "package-lock.json"));
    mkdirSync(join(dir, "scripts"), { recursive: true });
    cpSync(join(repoRoot, "scripts", "npm-shrinkwrap.mjs"), join(dir, "scripts", "npm-shrinkwrap.mjs"));
    mkdirSync(join(dir, "bin"), { recursive: true });
    writeFileSync(join(dir, "bin", "autopilot.mjs"), "#!/usr/bin/env node\n");
    mkdirSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist", "index.js"), "export {};\n");

    const result = spawnSync(npm, ["pack", "--dry-run", "--json"], { cwd: dir, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);

    const [info] = JSON.parse(result.stdout);
    const paths = (info.files ?? []).map((file: { path: string }) => file.path);
    assert.ok(paths.includes("npm-shrinkwrap.json"), `tarball files: ${paths.join(", ")}`);

    // postpack removes the generated file so a local pack cannot leave a
    // production-only lockfile behind for the next npm install/npm ci.
    assert.equal(existsSync(join(dir, "npm-shrinkwrap.json")), false, "postpack left npm-shrinkwrap.json behind");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
