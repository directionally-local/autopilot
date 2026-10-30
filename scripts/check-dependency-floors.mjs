#!/usr/bin/env node
/**
 * Fails when a dependency on one of our own packages has a floor below the
 * latest published version.
 *
 * Why: dl pins autopilot-ai exactly, and autopilot pins camouflage-tui and
 * @hotcell/sdk by range. A range like `^2.10.1` still *allows* 2.10.2, which
 * predates a fix we depend on, and a lockfile can hold it. Dependabot moves
 * these within a day; this check makes the drift visible the moment it exists,
 * instead of at the next first run that fails.
 *
 * Usage: node scripts/check-dependency-floors.mjs [--json]
 * Exit: 0 all floors current (or the registry couldn't be reached), 1 stale.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Our own packages, per repo. A dependency not listed here is ignored. */
const OWN_PACKAGES = ["camouflage-tui", "@hotcell/sdk"];

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const declared = { ...(pkg.dependencies ?? {}), ...(pkg.optionalDependencies ?? {}), ...(pkg.devDependencies ?? {}) };

/** The lowest version a range allows, or undefined when it names none (`*`, `latest`, a git URL). */
export function floorOf(range) {
  if (typeof range !== "string") return undefined;
  const match = range.trim().match(/^(?:[~^]|>=|>|=)?\s*v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/);
  return match ? match[1] : undefined;
}

/** Compare two x.y.z[-pre] versions: -1, 0 or 1. A prerelease sorts below its release. */
export function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = v.split("-", 2);
    return { parts: core.split(".").map(Number), pre: pre ?? null };
  };
  const left = split(a);
  const right = split(b);
  for (let i = 0; i < 3; i++) {
    const diff = (left.parts[i] ?? 0) - (right.parts[i] ?? 0);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (left.pre === right.pre) return 0;
  if (left.pre === null) return 1;
  if (right.pre === null) return -1;
  return left.pre < right.pre ? -1 : 1;
}

async function latestVersion(name, fetchImpl = fetch) {
  const res = await fetchImpl(`https://registry.npmjs.org/${name.replace("/", "%2F")}/latest`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`registry answered ${res.status}`);
  const body = await res.json();
  return typeof body.version === "string" ? body.version : undefined;
}

async function main() {
  const json = process.argv.includes("--json");
  const rows = [];
  let unreachable = false;

  for (const name of OWN_PACKAGES) {
    const range = declared[name];
    if (!range) continue;
    const floor = floorOf(range);
    if (!floor) {
      rows.push({ name, range, floor: null, latest: null, stale: false, note: "no floor to compare" });
      continue;
    }
    let latest;
    try {
      latest = await latestVersion(name);
    } catch (error) {
      unreachable = true;
      rows.push({ name, range, floor, latest: null, stale: false, note: `couldn't reach the registry (${error.message})` });
      continue;
    }
    if (!latest) {
      unreachable = true;
      rows.push({ name, range, floor, latest: null, stale: false, note: "registry named no version" });
      continue;
    }
    rows.push({ name, range, floor, latest, stale: compareVersions(floor, latest) < 0, note: "" });
  }

  const stale = rows.filter((row) => row.stale);

  if (json) {
    console.log(JSON.stringify({ stale: stale.length, unreachable, rows }, null, 2));
  } else {
    for (const row of rows) {
      const mark = row.stale ? "✗" : "✓";
      const detail = row.latest ? `${row.floor} → latest ${row.latest}` : row.note;
      console.log(`  ${mark} ${row.name.padEnd(18)} ${String(row.range).padEnd(10)} ${detail}`);
    }
    if (stale.length > 0) {
      console.log("");
      console.log(`  ${stale.length} of our own packages has a newer release than the floor allows:`);
      for (const row of stale) console.log(`    ${row.name}: ${row.range} allows ${row.floor}, latest is ${row.latest}`);
      console.log("");
      console.log("  Raise the floor (Dependabot does this daily; trigger it by hand from");
      console.log("  Insights → Dependency graph → Dependabot if you need it now).");
    }
    if (unreachable) console.log("\n  (the registry couldn't be reached for some packages; not failing on that)");
  }

  return stale.length > 0 ? 1 : 0;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exit(await main());
}
