import { describe, it } from "node:test";
import assert from "node:assert";
import { simpleCommands, writesFile } from "./shell-commands.js";
import { setupCommandOf } from "./setup-consent.js";

const argvs = (c: string) => simpleCommands(c).map((s) => s.argv.join(" "));

/** Every wrapper form, with `%` where the wrapped command goes. */
const WRAPPED = [
  "timeout 120 %",
  "timeout -s KILL 5m %",
  "timeout --signal=TERM --kill-after 10 30s %",
  "timeout --preserve-status 60 %",
  "nice %",
  "nice -n 10 %",
  "nice -n10 %",
  "nice -10 %",
  "nice --adjustment=5 %",
  "ionice -c 3 %",
  "ionice -c2 -n7 %",
  "stdbuf -oL %",
  "stdbuf -o L -e 0 %",
  "stdbuf --output=L %",
  "env CI=1 %",
  "env -i PATH=/usr/bin HOME=/tmp %",
  "env -u NODE_OPTIONS %",
  "env -C /tmp %",
  "env -S '%'",
  "sudo %",
  "sudo -u ci %",
  "sudo -E -H %",
  "sudo -u ci -g ci -- %",
  "sudo --user=ci %",
  "doas -u ci %",
  "nohup %",
  "time %",
  "time -p %",
  "command %",
  "command -p %",
  "exec %",
  "exec -a name %",
  "builtin %",
  "xargs %",
  "xargs -0 -n 1 -P 4 %",
  "xargs -I {} %",
  "xargs --max-args=1 %",
  "flock /tmp/lock %",
  "flock -w 10 /tmp/lock %",
  "flock -x /tmp/lock -c '%'",
  "flock /tmp/lock --command '%'",
  "chrt -f 10 %",
  "chrt --idle 0 %",
  "taskset 0x3 %",
  "taskset -c 0-3 %",
  "setsid %",
  "FOO=1 BAR='a b' %",
  "FOO=1 sudo -u ci env BAR=2 timeout 120 nice -n 5 %",
  "bash -c '%'",
  'sh -c "%"',
  "zsh -c '%'",
  "bash -lc '%'",
  "bash -e -o pipefail -c '%'",
  "/bin/sh -c '%'",
  "sudo bash -c 'cd /app && %'",
  "eval '%'",
  "cd app && %",
  "cd app; %",
  "false || %",
  "% | tail -5",
  "% 2>&1 | tail -5",
  "true & %",
  "( % )",
  "(cd app && %)",
  "{ %; }",
  "echo $(%)",
  'echo "$(%)"',
  "echo `%`",
  "diff <(%) /dev/null",
  "if true; then %; fi",
  "for d in a b; do %; done",
  "true\n%",
  "cat <<EOF\nnot a command\nEOF\n%",
];

const INSTALLS = ["npm install", "pip install -r requirements.txt"];

describe("simpleCommands", () => {
  it("takes wrappers and their options and arguments off", () => {
    assert.deepStrictEqual(argvs("timeout 120 npm install --no-audit --no-fund 2>&1 | tail -5"), ["npm install --no-audit --no-fund", "tail -5"]);
    const [sc] = simpleCommands("FOO=1 sudo -u ci timeout -k 5 60 /usr/bin/npm ci > log.txt");
    assert.deepStrictEqual(sc!.argv, ["/usr/bin/npm", "ci"]);
    assert.strictEqual(sc!.name, "npm");
    assert.deepStrictEqual(sc!.wrappers, ["sudo", "timeout"]);
    assert.deepStrictEqual(sc!.assignments, ["FOO=1"]);
    assert.deepStrictEqual(sc!.redirects, [{ op: ">", target: "log.txt" }]);
  });

  for (const form of WRAPPED) {
    for (const inner of [...INSTALLS, "rm -rf dist"]) {
      const c = form.replace("%", inner);
      it(`finds \`${inner}\` in ${JSON.stringify(c)}`, () => {
        assert.ok(argvs(c).includes(inner), `${JSON.stringify(c)} → ${JSON.stringify(argvs(c))}`);
      });
    }
  }

  it("does not see commands inside quoted text, comments or here-documents", () => {
    for (const c of ['echo "npm install"', "echo 'rm -rf dist'", "git commit -m 'npm install'", "echo hi # npm install", "cat <<'EOF'\nnpm install\nEOF", "grep -rn 'a > b' src"]) {
      assert.ok(!argvs(c).some((a) => a.startsWith("npm") || a.startsWith("rm")), `${JSON.stringify(c)} → ${JSON.stringify(argvs(c))}`);
    }
  });

  it("knows wrappers that run nothing", () => {
    for (const c of ["command -v npm", "ionice -p 123", "taskset -p 0x3 123", "chrt -p 10 123", "flock 9"]) assert.deepStrictEqual(argvs(c), [], c);
  });

  it("tells files from descriptors and /dev/null", () => {
    const r = (c: string) => simpleCommands(c).flatMap((s) => s.redirects).map(writesFile);
    assert.deepStrictEqual(r("a 2>&1 >/dev/null 2>/dev/stderr"), [false, false, false]);
    assert.deepStrictEqual(r("a > out &> both >> log 2> err"), [true, true, true, true]);
    assert.deepStrictEqual(r("a < in"), [false]);
  });
});

describe("the setup question with wrappers", () => {
  const kind = (c: string) => setupCommandOf(c)?.kind ?? null;

  for (const form of WRAPPED) {
    it(`asks for ${JSON.stringify(form)}`, () => {
      for (const inner of INSTALLS) assert.strictEqual(kind(form.replace("%", inner)), "install", form.replace("%", inner));
      assert.ok(kind(form.replace("%", "rm -rf dist")) !== null, form.replace("%", "rm -rf dist"));
    });
  }

  it("asks for the command a fresh-machine install test ran without a question", () => {
    assert.deepStrictEqual(setupCommandOf("timeout 120 npm install --no-audit --no-fund 2>&1 | tail -5"), {
      kind: "install",
      segment: "timeout 120 npm install --no-audit --no-fund",
    });
  });

  it("does not ask for tests, reads or quoted text, wrapped or not", () => {
    for (const c of [
      "timeout 5 npm test",
      "timeout 120 npm test 2>&1 | tail -5",
      "nice -n 5 npm run build",
      "sudo -u ci npm test",
      "env CI=1 npm test",
      "bash -c 'npm test && ls'",
      "xargs -n1 echo",
      "echo \"npm install\"",
      "echo 'pip install -r requirements.txt'",
      "printf '%s\\n' 'rm -rf dist'",
      "command -v npm",
      "(cd app && npm test)",
      "echo $(git rev-parse HEAD)",
    ]) {
      assert.strictEqual(kind(c), null, c);
    }
  });
});
