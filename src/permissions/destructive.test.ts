import { after, before, describe, it } from "node:test";
import assert from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { analyzeSql, classifyCommand, classifyToolCall, isLocalHost, type ClassifyContext } from "./destructive.js";

let T: string;
let R: string;
let OUTSIDE: string;
let OUTSIDE_REL: string;
let ctx: ClassifyContext;

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", "-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

const verdict = (command: string, extra: Partial<ClassifyContext> = {}) => classifyCommand(command, { ...ctx, ...extra }).verdict;
const first = (command: string, extra: Partial<ClassifyContext> = {}) => classifyCommand(command, { ...ctx, ...extra }).findings[0];

before(() => {
  // Resolve the temp root once: git reports the /private/var realpath on macOS,
  // and every path the classifier compares must use the same form.
  T = realpathSync(mkdtempSync(join(tmpdir(), "ap-destructive-")));
  R = join(T, "repo");
  mkdirSync(R);
  git(R, "init", "-q");
  writeFileSync(join(R, ".gitignore"), "node_modules/\n.env\n");
  writeFileSync(join(R, "committed.txt"), "v1\n");
  writeFileSync(join(R, "changed.txt"), "v1\n");
  mkdirSync(join(R, "src"));
  writeFileSync(join(R, "src", "a.ts"), "export {};\n");
  writeFileSync(join(R, "reset.sql"), "-- wipe\nDROP TABLE orders;\n");
  writeFileSync(join(R, "seed.sql"), "INSERT INTO users (name) VALUES ('drop table x');\n");
  writeFileSync(join(R, "package.json"), JSON.stringify({ scripts: { "db:reset": "prisma migrate reset --force", test: "node --test" } }));
  git(R, "add", ".");
  git(R, "commit", "-qm", "init");
  git(R, "branch", "feature");
  writeFileSync(join(R, "changed.txt"), "v2, not committed\n");
  mkdirSync(join(R, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(R, "node_modules", "dep", "index.js"), "x");
  mkdirSync(join(R, "build-cache"));
  writeFileSync(join(R, "build-cache", "notes.txt"), "untracked work");
  writeFileSync(join(R, "scratch.txt"), "untracked");
  writeFileSync(join(R, "app.log"), "log");
  writeFileSync(join(R, ".env"), "SECRET=1\n");
  // A sibling of the temp root: outside the project and outside the scratch
  // dirs, so deleting it is irreversible on every platform.
  OUTSIDE = join(dirname(T), `ap-outside-${basename(T)}`);
  mkdirSync(OUTSIDE);
  writeFileSync(join(OUTSIDE, "f"), "x");
  OUTSIDE_REL = relative(R, OUTSIDE);
  // The temp root is scratch: on macOS it lives under /var, which SYSTEM_DIRS
  // treats as dangerous unless a scratch dir contains it.
  ctx = { cwd: R, env: {}, scratchDirs: [T, realpathSync(T)] };
});

after(() => {
  rmSync(T, { recursive: true, force: true });
  rmSync(OUTSIDE, { recursive: true, force: true });
});

describe("databases", () => {
  it("tags destructive SQL through every client as irreversible", () => {
    for (const c of [
      `psql "$DATABASE_URL" -c 'DROP TABLE orders'`,
      `psql -c "TRUNCATE users"`,
      `psql -c "DELETE FROM users"`,
      `psql -c "DELETE FROM users WHERE 1=1"`,
      `mysql -e "UPDATE users SET admin = 1"`,
      `mysql -u root -e "DROP DATABASE shop"`,
      `psql -c "ALTER TABLE users DROP COLUMN email"`,
      `sqlite3 app.db "DROP TABLE t"`,
      `mongosh --eval "db.orders.drop()"`,
      `mongosh shop --eval "db.dropDatabase()"`,
      `mongosh --eval "db.users.deleteMany({})"`,
      `redis-cli FLUSHALL`,
      `redis-cli -n 2 flushdb`,
      `psql -f reset.sql`,
      `psql --file=reset.sql`,
      `psql < reset.sql`,
      `cat reset.sql | psql`,
      `echo "DROP TABLE x" | psql`,
      "psql <<SQL\nDELETE FROM users;\nSQL",
      `psql <<< "truncate table events"`,
    ]) {
      assert.strictEqual(verdict(c), "irreversible", c);
      assert.strictEqual(first(c)?.category, "database", c);
    }
  });

  it("tags ORM and framework resets as irreversible", () => {
    for (const c of [
      "npx prisma migrate reset --force",
      "prisma db push --accept-data-loss",
      "pnpm exec prisma db push --force-reset",
      "bin/rails db:drop",
      "rails db:reset",
      "bundle exec rake db:drop",
      "python manage.py flush --noinput",
      "./manage.py flush",
      "django-admin flush",
      "python3 manage.py migrate shop zero",
      "npx knex migrate:rollback --all",
      "npx sequelize db:migrate:undo:all",
      "npm run db:reset",
    ]) {
      assert.strictEqual(verdict(c), "irreversible", c);
    }
  });

  it("leaves reads, scoped changes and quoted text alone", () => {
    for (const c of [
      `echo "drop table users"`,
      `echo "DROP TABLE users" > /dev/null`,
      `grep -ri "truncate table" src`,
      `git commit -m "drop table users"`,
      `psql -c "SELECT * FROM users"`,
      `psql -c "DELETE FROM users WHERE id = 1"`,
      `mysql -e "UPDATE users SET admin = 0 WHERE id = 7"`,
      `psql -f seed.sql`,
      `psql -f missing.sql`,
      `prisma db push`,
      `prisma migrate dev`,
      `rails db:migrate`,
      `npx knex migrate:rollback`,
      `redis-cli GET key`,
      `npm test`,
    ]) {
      assert.strictEqual(verdict(c), "safe", c);
    }
  });

  it("names what is lost", () => {
    assert.deepStrictEqual(analyzeSql("DROP TABLE IF EXISTS orders, items CASCADE; TRUNCATE events"), ["drops table `orders`, `items`", "empties table `events`"]);
    assert.deepStrictEqual(analyzeSql("delete from users"), ["deletes every row in `users`"]);
    assert.deepStrictEqual(analyzeSql("-- DROP TABLE x\nSELECT 'DROP TABLE y'"), []);
    assert.deepStrictEqual(analyzeSql("CREATE TABLE t (id int REFERENCES u ON DELETE CASCADE ON UPDATE SET NULL)"), []);
  });

  it("flags a DATABASE_URL host that isn't local as production, and needs its name typed", () => {
    const f = first(`DATABASE_URL=postgres://app:s3cret@db.example.com:5432/shop psql "$DATABASE_URL" -c 'DROP TABLE orders'`)!;
    assert.strictEqual(f.target?.production, true);
    assert.strictEqual(f.target?.confirmName, "shop");
    assert.match(f.target!.label, /db\.example\.com\/shop/);
    assert.doesNotMatch(f.target!.label, /s3cret|app:/);
    const env = { DATABASE_URL: "postgres://u:p@db.internal.example.com/prod_db" };
    assert.strictEqual(first("npx prisma migrate reset --force", { env })?.target?.production, true);
    for (const host of ["localhost", "127.0.0.1", "[::1]", "db", "postgres"]) {
      const t = first("npx prisma migrate reset --force", { env: { DATABASE_URL: `postgres://u:p@${host}:5432/app` } })?.target;
      assert.strictEqual(t?.production, false, host);
    }
    assert.ok(isLocalHost("db") && isLocalHost("::1") && !isLocalHost("10.0.0.5") && !isLocalHost("db.example.com"));
  });

  it("reads DATABASE_URL from the project's .env when it isn't in the environment", () => {
    const dir = join(T, "envproj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ".env"), 'DATABASE_URL="mysql://u:p@shop.cluster.example.com/shop"\n');
    const f = first("npx prisma migrate reset --force", { cwd: dir })!;
    assert.strictEqual(f.target?.production, true);
  });

  it("flags production environment names", () => {
    const f = first("RAILS_ENV=production bin/rails db:drop")!;
    assert.strictEqual(f.target?.production, true);
    assert.strictEqual(f.target?.confirmName, "production");
    assert.strictEqual(first("bin/rails db:drop", { env: { RAILS_ENV: "development" } })?.target?.production, false);
  });

  it("treats SQL in MCP tool input as a database action", () => {
    assert.strictEqual(classifyToolCall("mcp_postgres_query", { sql: "DROP TABLE orders" }, ctx).verdict, "irreversible");
    assert.strictEqual(classifyToolCall("mcp_db_execute", { input: { statements: ["UPDATE users SET plan = 'free'"] } }, ctx).verdict, "irreversible");
    assert.strictEqual(classifyToolCall("mcp_postgres_query", { sql: "SELECT 1" }, ctx).verdict, "safe");
    assert.strictEqual(classifyToolCall("mcp_mongo_run", { code: "db.users.deleteMany({})" }, ctx).verdict, "irreversible");
  });
});

describe("files", () => {
  it("rm -rf node_modules inside the repo is recoverable, not irreversible", () => {
    assert.strictEqual(verdict("rm -rf node_modules"), "recoverable");
    assert.match(first("rm -rf node_modules")!.recovery, /build or install/);
  });

  it("deleting untracked work inside the project is recoverable with a copy", () => {
    const f = first("rm -rf build-cache")!;
    assert.strictEqual(f.verdict, "recoverable");
    assert.strictEqual(f.plan?.kind, "files");
    assert.match(f.recovery, /keeps a copy of 1 file/);
    assert.strictEqual(verdict("rm scratch.txt"), "recoverable");
    assert.strictEqual(verdict("rm .env"), "recoverable");
    assert.strictEqual(verdict("rm committed.txt"), "recoverable");
    assert.match(first("rm committed.txt")!.recovery, /come back with git/);
  });

  it("is irreversible above the copy limit", () => {
    assert.strictEqual(verdict("rm -rf build-cache", { maxCopyBytes: 4 }), "irreversible");
    assert.match(first("rm -rf build-cache", { maxCopyBytes: 4 })!.recovery, /No copy/);
  });

  it("deleting outside the project, the project itself, home, root or a .git is irreversible", () => {
    for (const c of [
      `rm -rf ${OUTSIDE_REL}`,
      `timeout 60 rm -rf ${OUTSIDE_REL}`,
      "rm -rf /",
      "rm -rf ~",
      "rm -rf .",
      "rm -rf .git",
      `rm -rf "${R}"`,
    ]) {
      assert.strictEqual(verdict(c), "irreversible", c);
    }
  });

  it("can't tell what a variable, a remote list or xargs deletes, so it's irreversible", () => {
    assert.strictEqual(verdict(`rm -rf "$BUILD_DIR"`), "irreversible");
    assert.strictEqual(verdict("rm -rf $(cat dirs.txt)"), "irreversible");
    assert.strictEqual(verdict("find . -name '*.tmp' | xargs rm -rf"), "irreversible");
    assert.strictEqual(verdict("xargs rm -rf < list.txt"), "irreversible");
    assert.strictEqual(verdict("xargs rm -rf"), "irreversible");
  });

  it("resolves a variable or a common substitution before giving up", () => {
    // The temp root counts as scratch here: on macOS it lives under /var, and
    // git reports the /private/var realpath.
    const scratch = { scratchDirs: [T, realpathSync(T)] };
    assert.strictEqual(verdict(`rm -rf "$BUILD_DIR"`, { ...scratch, env: { BUILD_DIR: "build-cache" } }), "recoverable");
    assert.strictEqual(verdict("rm -rf ${BUILD_DIR}", { ...scratch, env: { BUILD_DIR: "build-cache" } }), "recoverable");
    assert.strictEqual(verdict("DIR=build-cache; rm -rf $DIR", scratch), "recoverable");
    assert.strictEqual(verdict("export DIR=build-cache && rm -rf $DIR", scratch), "recoverable");
    assert.strictEqual(verdict("rm -rf $(pwd)/build-cache", scratch), "recoverable");
    assert.strictEqual(verdict("rm -rf $(git rev-parse --show-toplevel)/build-cache", scratch), "recoverable");
    // Still unknown: an unset variable, a command substitution, a default.
    assert.strictEqual(verdict("rm -rf $UNSET_DIR", scratch), "irreversible");
    assert.strictEqual(verdict("rm -rf $(cat dirs.txt)", scratch), "irreversible");
    assert.strictEqual(verdict("rm -rf ${UNSET_DIR:-build-cache}", scratch), "irreversible");
    // A resolved target outside the project is still irreversible.
    assert.strictEqual(verdict("rm -rf $OUT", { ...scratch, env: { OUT: join(T, "..") } }), "irreversible");
  });

  it("find -delete lists its matches with a dry run", () => {
    assert.strictEqual(verdict("find . -name '*.log' -delete"), "recoverable");
    assert.match(first("find . -name '*.log' -delete")!.loss, /app\.log/);
    assert.strictEqual(verdict("find . -name '*.nothing' -delete"), "safe");
    assert.strictEqual(verdict("find . -name '*.log'"), "safe");
    assert.strictEqual(verdict(`find ${OUTSIDE_REL} -type f -exec rm {} +`), "irreversible");
  });

  it("globs expand to what they match", () => {
    assert.strictEqual(verdict("rm -rf node_modules/*"), "recoverable");
    assert.strictEqual(verdict("rm -f *.nothing"), "safe");
  });

  it("overwriting untracked or changed files is recoverable with a copy; committed or new files are safe", () => {
    assert.strictEqual(classifyToolCall("write", { path: "scratch.txt", content: "x" }, ctx).verdict, "recoverable");
    assert.strictEqual(classifyToolCall("write", { path: "changed.txt", content: "x" }, ctx).verdict, "recoverable");
    assert.strictEqual(classifyToolCall("write", { path: "committed.txt", content: "x" }, ctx).verdict, "safe");
    assert.strictEqual(classifyToolCall("write", { path: "brand-new.txt", content: "x" }, ctx).verdict, "safe");
    assert.strictEqual(verdict("echo hi > scratch.txt"), "recoverable");
    assert.strictEqual(verdict("echo hi >> scratch.txt"), "safe");
    assert.strictEqual(verdict("cp committed.txt scratch.txt"), "recoverable");
    assert.strictEqual(verdict("rm -f nothing-here.txt"), "safe");
  });
});

describe("git", () => {
  it("force push without a lease is irreversible; with a lease it's recoverable", () => {
    for (const c of ["git push --force origin feature", "git push -f", "git push origin +feature", "git push --force --force-with-lease origin feature"]) {
      assert.strictEqual(verdict(c), "irreversible", c);
    }
    assert.strictEqual(verdict("git push --force-with-lease origin feature"), "recoverable");
    assert.strictEqual(verdict("git push origin feature"), "safe");
    assert.strictEqual(verdict("git push --dry-run --force origin feature"), "safe");
  });

  it("deleting a remote branch is irreversible", () => {
    for (const c of ["git push origin --delete feature", "git push origin :feature", "git push -d origin feature"]) {
      assert.strictEqual(verdict(c), "irreversible", c);
      assert.match(first(c)!.loss, /deletes branch `feature` on `origin`/);
    }
  });

  it("reset --hard over uncommitted work keeps a copy and the old commit", () => {
    const f = first("git reset --hard")!;
    assert.strictEqual(f.verdict, "recoverable");
    assert.strictEqual(f.plan?.kind, "git-head");
    assert.match(f.loss, /changed\.txt/);
    assert.strictEqual(verdict("git reset --hard", { maxCopyBytes: 2 }), "irreversible");
    assert.strictEqual(verdict("git reset --soft HEAD~1"), "safe");
  });

  it("clean -fd, branch -D and checkout/restore over uncommitted work", () => {
    assert.strictEqual(verdict("git clean -fd"), "recoverable");
    assert.strictEqual(verdict("git clean -n -d"), "safe");
    assert.strictEqual(verdict("git branch -D feature"), "recoverable");
    assert.strictEqual(first("git branch -D feature")?.plan?.kind, "git-branch");
    assert.strictEqual(verdict("git branch -d feature"), "safe");
    assert.strictEqual(verdict("git checkout -- ."), "recoverable");
    assert.strictEqual(verdict("git checkout changed.txt"), "recoverable");
    assert.strictEqual(verdict("git restore ."), "recoverable");
    assert.strictEqual(verdict("git restore --staged changed.txt"), "safe");
    assert.strictEqual(verdict("git checkout -- committed.txt"), "safe");
    assert.strictEqual(verdict("git checkout feature"), "safe");
    assert.strictEqual(verdict("git status"), "safe");
  });
});

describe("cloud and infrastructure", () => {
  it("tags destroy and delete commands as irreversible", () => {
    for (const c of [
      "terraform destroy",
      "terraform apply -destroy -auto-approve",
      "kubectl delete deployment web",
      "docker volume rm pgdata",
      "docker volume prune -f",
      "docker system prune --volumes -f",
      "docker compose down -v",
      "aws s3 rm s3://bucket/data --recursive",
      "aws s3 rb s3://bucket --force",
      "gcloud sql instances delete main-db",
      "gcloud compute instances delete vm-1 --zone us-central1-a",
      "gh repo delete owner/repo --yes",
      "gh release delete v1.2.0",
    ]) {
      assert.strictEqual(verdict(c), "irreversible", c);
      assert.strictEqual(first(c)?.category, "cloud", c);
    }
    for (const c of ["terraform plan", "kubectl get pods", "docker system prune -f", "docker compose down", "aws s3 ls s3://bucket", "gcloud sql instances list", "gh release view v1"]) {
      assert.strictEqual(verdict(c), "safe", c);
    }
  });

  it("flags production workspaces, contexts, profiles and projects", () => {
    assert.strictEqual(first("terraform destroy", { env: { TF_WORKSPACE: "prod" } })?.target?.confirmName, "prod");
    const tf = join(T, "tf");
    mkdirSync(join(tf, ".terraform"), { recursive: true });
    writeFileSync(join(tf, ".terraform", "environment"), "production\n");
    assert.strictEqual(first("terraform destroy", { cwd: tf })?.target?.confirmName, "production");
    assert.strictEqual(first(`terraform -chdir=${tf} destroy`)?.target?.production, true);
    assert.strictEqual(first("terraform destroy", { env: { TF_WORKSPACE: "staging" } })?.target?.production, false);
    assert.strictEqual(first("kubectl delete ns web --context prod-eu")?.target?.confirmName, "prod-eu");
    const kube = join(T, "kubeconfig");
    writeFileSync(kube, "apiVersion: v1\ncurrent-context: gke_acme_production\n");
    assert.strictEqual(first("kubectl delete pod x", { env: { KUBECONFIG: kube } })?.target?.production, true);
    assert.strictEqual(first("kubectl delete pod x --context kind-dev")?.target?.production, false);
    assert.strictEqual(first("aws s3 rm s3://b --recursive --profile prod")?.target?.production, true);
    assert.strictEqual(first("gcloud sql instances delete db --project acme-prod")?.target?.production, true);
  });
});

describe("compound commands, subshells and wrappers", () => {
  it("finds the destructive command wherever it hides", () => {
    for (const c of [
      `bash -c "psql \\$DATABASE_URL -c 'DROP TABLE users'"`,
      `sh -c 'redis-cli FLUSHALL'`,
      `cd /tmp && terraform destroy`,
      `npm test && git push --force origin feature`,
      `true || git push -f`,
      `ls; docker volume rm pgdata`,
      `(kubectl delete ns web)`,
      `echo $(psql -c "DROP TABLE x")`,
      "echo `redis-cli flushall`",
      `sudo -u postgres psql -c "DROP DATABASE app"`,
      `env FOO=1 nice -n 10 ionice -c3 stdbuf -oL nohup terraform destroy`,
      `time command terraform destroy`,
      `flock /tmp/tf.lock -c "terraform destroy"`,
      `chrt 10 kubectl delete ns web`,
      `taskset 0x1 rm -rf /`,
      `exec gh repo delete o/r --yes`,
      `eval "terraform destroy"`,
      `PGPASSWORD=x psql -h db.example.com -c "TRUNCATE users"`,
      `ssh prod-1 "psql -c 'DROP TABLE users'"`,
      `docker exec db psql -U postgres -c "TRUNCATE users"`,
      `docker compose exec db psql -c "DROP TABLE t"`,
      `kubectl exec -it pg-0 -- psql -c "DROP TABLE t"`,
      "if true; then\n  terraform destroy\nfi",
    ]) {
      assert.strictEqual(verdict(c), "irreversible", c);
    }
  });

  it("follows cd into another directory", () => {
    assert.strictEqual(verdict("cd src && rm -rf ../node_modules"), "recoverable");
    assert.strictEqual(verdict(`cd ${relative(R, dirname(OUTSIDE))} && rm -rf ${basename(OUTSIDE)}`), "irreversible");
  });

  it("reports every destructive part, worst first", () => {
    const a = classifyCommand("rm -rf node_modules && psql -c 'DROP TABLE t'", ctx);
    assert.strictEqual(a.verdict, "irreversible");
    assert.deepStrictEqual(a.findings.map((f) => f.category).sort(), ["database", "files"]);
  });
});
