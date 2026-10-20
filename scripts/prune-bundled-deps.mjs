#!/usr/bin/env node
// Runs as `prepack`. bundleDependencies ships every production package in
// node_modules inside our tarball, including the test suites, benchmarks and
// examples some of them publish. Those files never run, but supply-chain
// scanners read them: fast-uri's benchmarks import `tinybench` and
// process-warning's import `benchmark`, so both showed up as dependencies of
// autopilot-ai. Delete those top-level folders/files from each production
// package before npm packs it.
//
//   node scripts/prune-bundled-deps.mjs            # prune
//   node scripts/prune-bundled-deps.mjs --dry-run  # list what would go
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Top-level entries of a package that are never loaded at runtime. */
export const PRUNABLE = [
  "__tests__",
  "bench",
  "bench.js",
  "benchmark",
  "benchmark.js",
  "benchmarks",
  "example",
  "example.js",
  "examples",
  "test",
  "test.js",
  "tests",
  "tests.js",
];

/** Folder names pruned at any depth inside a package (e.g. zod/src/v3/benchmarks). */
export const PRUNABLE_ANYWHERE = ["__tests__", "benchmark", "benchmarks"];

function nestedPrunable(root, dir, out) {
  let entries;
  try {
    entries = readdirSync(join(root, dir), { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    // Nested node_modules are packages of their own, with their own lock entry.
    if (!entry.isDirectory() || entry.name === "node_modules") continue;
    const rel = `${dir}/${entry.name}`;
    if (PRUNABLE_ANYWHERE.includes(entry.name)) out.push(rel);
    else nestedPrunable(root, rel, out);
  }
}

/**
 * Paths (relative to `root`) that pruning would delete: PRUNABLE top-level
 * entries and PRUNABLE_ANYWHERE folders of every non-dev package in
 * package-lock.json, except ones the package's own manifest mentions in
 * main, module, browser, bin or exports.
 */
export function prunablePaths(root) {
  const lock = JSON.parse(readFileSync(join(root, "package-lock.json"), "utf8"));
  const out = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("node_modules/") || meta.dev || meta.link) continue;
    const manifestPath = join(root, path, "package.json");
    if (!existsSync(manifestPath)) continue;
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const entryPoints = JSON.stringify([manifest.main, manifest.module, manifest.browser, manifest.bin, manifest.exports]);
    const found = [];
    for (const name of PRUNABLE) if (existsSync(join(root, path, name))) found.push(`${path}/${name}`);
    for (const entry of readdirSync(join(root, path), { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name !== "node_modules" && !PRUNABLE.includes(entry.name)) {
        nestedPrunable(root, `${path}/${entry.name}`, found);
      }
    }
    for (const rel of found) {
      if (entryPoints.includes(rel.slice(path.length + 1))) continue;
      out.push(rel);
    }
  }
  return out;
}

export function pruneBundledDeps(root, { dryRun = false } = {}) {
  const paths = prunablePaths(root);
  if (!dryRun) for (const p of paths) rmSync(join(root, p), { recursive: true, force: true });
  return paths;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const dryRun = process.argv.includes("--dry-run");
  const root = fileURLToPath(new URL("..", import.meta.url));
  const paths = pruneBundledDeps(root, { dryRun });
  if (dryRun) for (const p of paths) console.log(p);
  console.error(`prune-bundled-deps: ${dryRun ? "would remove" : "removed"} ${paths.length} test/benchmark/example paths`);
}
