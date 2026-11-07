import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { buildAudit } from "./audit.js";

function withTemp(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "ap-audit-"));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("reports allow rules, production-looking databases, and cloud accounts without leaking values", () => {
  withTemp((dir) => {
    writeFileSync(join(dir, ".env"), "PG_URL=postgres://u:secret@db.prod.example.com:5432/shop\nAWS_SECRET_ACCESS_KEY=abcd\n");
    const text = buildAudit({
      cwd: dir,
      env: {
        DATABASE_URL: "postgres://u:p@db.example.com/shop",
        REDIS_URL: "redis://localhost:6379",
        AWS_SECRET_ACCESS_KEY: "xyz",
      },
      permissions: { bash: { "**": "allow", "ls*": "allow" } },
      mcpServers: { prod_db: {} },
    });
    assert.match(text, /Allowed without asking/);
    assert.match(text, /bash: "\*\*"/);
    assert.match(text, /prod_db/);
    assert.match(text, /the database at db\.example\.com — via env DATABASE_URL/);
    assert.match(text, /db\.prod\.example\.com — via \.env: PG_URL — looks like PRODUCTION/);
    // A localhost database is not flagged as production.
    assert.doesNotMatch(text, /localhost:6379.*PRODUCTION/);
    assert.match(text, /AWS credentials/);
    // Never the values.
    assert.doesNotMatch(text, /u:secret|xyz|abcd|u:p@/);
    // A broad allow gets a narrowing suggestion.
    assert.match(text, /narrow the broad allow rule/);
  });
});

test("a clean non-git project suggests git and shows no recovery", () => {
  withTemp((dir) => {
    const text = buildAudit({ cwd: dir, env: {} });
    assert.match(text, /no allow rules/);
    assert.match(text, /no database URLs or cloud credentials/);
    assert.match(text, /not a git repo/);
    assert.match(text, /no recovery points yet/);
    assert.match(text, /put this project under git/);
  });
});

test("a clean git repo reports the branch and no suggestions", () => {
  withTemp((dir) => {
    execFileSync("git", ["init", "-q", "-b", "main", dir]);
    const text = buildAudit({ cwd: dir, env: {} });
    assert.match(text, /git repo on main, clean/);
    assert.match(text, /nothing to change/);
  });
});
