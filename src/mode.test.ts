import { describe, it } from "node:test";
import assert from "node:assert";
import {
  isReadOnlyBash,
  isBlockedInPlanMode,
  nextMode,
  modeDescription,
  MODES,
} from "./mode.js";

describe("isReadOnlyBash", () => {
  it("still allows everyday research commands", () => {
    for (const cmd of [
      "ls -la", "ls *.ts", "cat src/*.ts", "du -sh *", "wc -l src/*.ts", "head -n 20 README.md",
      "grep -rn foo src", "rg foo src", "rg foo -g '*.ts'", "rg foo src/*.ts", "find . -name '*.ts' -type f",
      "git log --oneline -5", "git diff HEAD~1 -- src", "git show HEAD:package.json", "git branch", "git branch -a",
      "git branch --show-current", "git branch --contains abc123", "git tag", "git tag -l 'v1.*'", "git remote -v",
      "git config --get user.name", "git config --list", "git stash list", "git reflog -5", "git grep -n foo",
      "sort file | uniq -c | sort -rn", "date -u", "hostname", "hostname -f", "ps aux | grep node", "jq .name package.json",
      "xxd package.json | head", "fd -e ts", "ss -tlnp", "git log --format='%h %s' | head",
    ]) {
      assert.strictEqual(isReadOnlyBash(cmd), true, cmd);
    }
  });

  it("rejects the separators and escapes bash honours but the splitter did not", () => {
    for (const cmd of [
      "ls\nrm -rf /tmp/x", "ls\rrm -rf /tmp/x", "ls\u0000", "ls & rm -rf /tmp/x", "ls |& rm x", "ls &",
      "cat a\\ b", "echo \\$(id)", "echo 'unterminated", "ls |", "&& ls", "cat {a,b}", "ls\u0085rm",
    ]) {
      assert.strictEqual(isReadOnlyBash(cmd), false, JSON.stringify(cmd));
    }
  });

  it("rejects allowlisted-looking commands that run programs or write files", () => {
    for (const cmd of [
      "env rm -rf /tmp/x", "printenv", "man -P 'rm -rf /tmp/x' ls", "less file", "more file", "history",
      "rg --pre sh x .", "rg --pre=sh x .", "rg --hostname-bin=sh x", "ag --pager=sh x", "fd -x rm", "fd --exec rm", "fd -X rm",
      "sort -o /tmp/out in", "sort -uo /tmp/out in", "sort --output=/tmp/out in", "sort --compress-program=sh in",
      "uniq in /tmp/out", "xxd -r in", "xxd in /tmp/out", "file -C -m magic", "date -s 2020-01-01", "date --set=x",
      "hostname evil", "hostname -F /tmp/name", "ss -K dst 1.2.3.4", "ss -D /tmp/out", "find . -fls /tmp/out",
      "git log --output=/tmp/pwned", "git diff --output /tmp/pwned", "git grep -Osh foo", "git grep --open-files-in-pager=sh foo",
      "git diff --ext-diff", "git branch evil", "git branch -D main", "git tag v9", "git tag -l -d v1", "git reflog expire --all",
      "git reflog delete HEAD@1", "git config core.pager sh", "git config --add a.b c", "git remote add x y", "git -c core.pager=sh log",
    ]) {
      assert.strictEqual(isReadOnlyBash(cmd), false, cmd);
    }
  });

  it("rejects globs that a hostile file name could turn into an option", () => {
    // A repository can contain a file named `--pre=sh`.
    for (const cmd of ["rg x *", "rg x -*", "rg x ?pre=sh", "sort *", "fd . [-]*", "git log *", "find *"]) {
      assert.strictEqual(isReadOnlyBash(cmd), false, cmd);
    }
  });

  it("allows simple read commands", () => {
    assert.strictEqual(isReadOnlyBash("ls"), true);
    assert.strictEqual(isReadOnlyBash("cat file.txt"), true);
    assert.strictEqual(isReadOnlyBash("pwd"), true);
    assert.strictEqual(isReadOnlyBash("git log"), true);
    assert.strictEqual(isReadOnlyBash("git diff HEAD~1"), true);
  });

  it("allows piped read commands", () => {
    assert.strictEqual(isReadOnlyBash("cat file.txt | grep foo"), true);
    assert.strictEqual(isReadOnlyBash("ps | grep node"), true);
    assert.strictEqual(isReadOnlyBash("git log | head -n 5"), true);
  });

  it("allows chained read commands with &&", () => {
    assert.strictEqual(isReadOnlyBash("git status && git diff"), true);
    assert.strictEqual(isReadOnlyBash("ls && cat file.txt"), true);
  });

  it("blocks chained commands with a mutating one", () => {
    assert.strictEqual(isReadOnlyBash("git status && rm file.txt"), false);
    assert.strictEqual(isReadOnlyBash("cat file.txt | rm -"), false);
  });

  it("blocks commands with dangerous patterns", () => {
    assert.strictEqual(isReadOnlyBash("echo hello > file.txt"), false);
    assert.strictEqual(isReadOnlyBash("cat file < input.txt"), false);
    assert.strictEqual(isReadOnlyBash("echo $(rm -rf /)"), false);
    assert.strictEqual(isReadOnlyBash("echo `rm -rf /`"), false);
    assert.strictEqual(isReadOnlyBash("echo $HOME"), false);
    assert.strictEqual(isReadOnlyBash("git status || echo fail"), false);
    assert.strictEqual(isReadOnlyBash("git status ; echo done"), false);
  });

  it("handles quoted strings correctly", () => {
    assert.strictEqual(isReadOnlyBash('echo "hello world"'), true);
    assert.strictEqual(isReadOnlyBash("echo 'hello world'"), true);
    assert.strictEqual(isReadOnlyBash('git log --format="foo | bar"'), true);
    assert.strictEqual(isReadOnlyBash('echo "a && b"'), true);
    // pipe inside quotes should not split
    assert.strictEqual(isReadOnlyBash('echo "a | b"'), true);
  });

  it("blocks mutating commands", () => {
    assert.strictEqual(isReadOnlyBash("rm file.txt"), false);
    assert.strictEqual(isReadOnlyBash("mv a b"), false);
    assert.strictEqual(isReadOnlyBash("cp a b"), false);
    assert.strictEqual(isReadOnlyBash("touch file.txt"), false);
    assert.strictEqual(isReadOnlyBash("mkdir dir"), false);
  });

  it("blocks empty commands", () => {
    assert.strictEqual(isReadOnlyBash(""), false);
    assert.strictEqual(isReadOnlyBash("   "), false);
  });

  it("validates find with deny-list of mutating primaries", () => {
    assert.strictEqual(isReadOnlyBash("find . -name '*.ts'"), true);
    assert.strictEqual(isReadOnlyBash("find node_modules/camouflage -type f"), true);
    assert.strictEqual(isReadOnlyBash("find . -type f | head"), true);
    assert.strictEqual(isReadOnlyBash("find . -name '*.tmp' -delete"), false);
    assert.strictEqual(isReadOnlyBash("find . -exec rm {} +"), false);
    assert.strictEqual(isReadOnlyBash("find . -execdir touch x \\;"), false);
    assert.strictEqual(isReadOnlyBash("find . -ok rm {} \\;"), false);
    assert.strictEqual(isReadOnlyBash("find . -fprint /tmp/out"), false);
  });

  it("validates git subcommands", () => {
    assert.strictEqual(isReadOnlyBash("git branch"), true);
    assert.strictEqual(isReadOnlyBash("git branch -d foo"), false);
    assert.strictEqual(isReadOnlyBash("git stash list"), true);
    assert.strictEqual(isReadOnlyBash("git stash push"), false);
    assert.strictEqual(isReadOnlyBash("git remote -v"), true);
    assert.strictEqual(isReadOnlyBash("git remote add origin foo"), false);
    assert.strictEqual(isReadOnlyBash("git tag -l"), true);
    assert.strictEqual(isReadOnlyBash("git tag v1.0"), false);
    assert.strictEqual(isReadOnlyBash("git config --list"), true);
    assert.strictEqual(isReadOnlyBash("git config user.name foo"), false);
  });
});

describe("isBlockedInPlanMode", () => {
  it("blocks mutating tools", () => {
    assert.strictEqual(isBlockedInPlanMode("write"), true);
    assert.strictEqual(isBlockedInPlanMode("edit"), true);
    assert.strictEqual(isBlockedInPlanMode("bash"), true);
    assert.strictEqual(isBlockedInPlanMode("mcp_fs"), true);
    assert.strictEqual(isBlockedInPlanMode("lsp_rename"), true);
    assert.strictEqual(isBlockedInPlanMode("browser_fetch"), true);
  });

  it("allows read-only tools", () => {
    assert.strictEqual(isBlockedInPlanMode("read"), false);
    assert.strictEqual(isBlockedInPlanMode("grep"), false);
    assert.strictEqual(isBlockedInPlanMode("glob"), false);
    assert.strictEqual(isBlockedInPlanMode("web_fetch"), false);
  });
});

describe("nextMode", () => {
  it("cycles through modes", () => {
    assert.strictEqual(nextMode("edit"), "plan");
    assert.strictEqual(nextMode("plan"), "auto");
    assert.strictEqual(nextMode("auto"), "edit");
  });
});

describe("modeDescription", () => {
  it("returns descriptions for all modes", () => {
    for (const mode of MODES) {
      assert.ok(modeDescription(mode).length > 0);
    }
  });
});
