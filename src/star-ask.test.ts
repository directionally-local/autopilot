import { describe, it } from "node:test";
import assert from "node:assert";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  STAR_API_PATH,
  STAR_URL,
  STARRED_LINE,
  isStarKey,
  localDay,
  noteDayOfUse,
  readStarTipState,
  runStarAsk,
  starAskAfterWin,
  starAskLine,
  starIt,
  starTipStatePath,
  type StarAskDeps,
} from "./star-ask.js";
import type { GhResult, GhRun } from "./util/gh-cli.js";

const DAY = 24 * 60 * 60 * 1000;
const T0 = new Date(2026, 10, 1, 12, 0, 0).getTime();

function tmpState(): string {
  return join(mkdtempSync(join(tmpdir(), "star-tip-")), "star-tip.json");
}

/** A fake gh: answers by the joined args; records every call. */
function fakeGh(answers: Record<string, Partial<GhResult>>, o: { missing?: boolean } = {}) {
  const calls: { args: string[]; timeoutMs?: number }[] = [];
  const run: GhRun = async (args, opts) => {
    calls.push({ args, ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    if (o.missing) return { code: null, stdout: "", stderr: "", missing: true };
    const a = answers[args.join(" ")];
    return { code: a?.code ?? 1, stdout: a?.stdout ?? "", stderr: a?.stderr ?? "" };
  };
  return { run, calls };
}

const SIGNED_IN = { "auth token": { code: 0, stdout: "gho_x\n" } };

function usedOn(days: number, path: string): void {
  for (let i = 0; i < days; i++) noteDayOfUse(path, T0 + i * DAY);
}

describe("star ask: the line", () => {
  it("names dl when dl launched it, Autopilot otherwise", () => {
    assert.strictEqual(
      starAskLine({ AUTOPILOT_LAUNCHED_BY: "dl" }),
      "⭐ Enjoying dl? Star it on GitHub: https://github.com/directionally-local/autopilot  (press s to star · any other key to dismiss)",
    );
    assert.strictEqual(
      starAskLine({}),
      "⭐ Enjoying Autopilot? Star it on GitHub: https://github.com/directionally-local/autopilot  (press s to star · any other key to dismiss)",
    );
  });

  it("s stars, raw or kitty-encoded; other keys don't", () => {
    for (const k of ["s", "S", "\x1b[115u", "\x1b[115;1u"]) assert.ok(isStarKey(k), JSON.stringify(k));
    for (const k of ["a", "\r", "\x1b", "\x03", " ", "\x1b[13u"]) assert.ok(!isStarKey(k), JSON.stringify(k));
  });
});

describe("star ask: days of use", () => {
  it("counts each local day once", () => {
    const path = tmpState();
    noteDayOfUse(path, T0);
    noteDayOfUse(path, T0 + 60_000);
    assert.strictEqual(readStarTipState(path).days, 1);
    noteDayOfUse(path, T0 + DAY);
    noteDayOfUse(path, T0 + 3 * DAY);
    assert.deepStrictEqual(readStarTipState(path), { days: 3, lastDay: localDay(T0 + 3 * DAY) });
  });

  it("reads a missing or broken file as no days", () => {
    const path = tmpState();
    assert.deepStrictEqual(readStarTipState(path), { days: 0 });
    writeFileSync(path, "{nope");
    assert.deepStrictEqual(readStarTipState(path), { days: 0 });
  });
});

describe("star ask: when it shows", () => {
  it("not before 3 distinct days of use", async () => {
    const path = tmpState();
    const gh = fakeGh({}, { missing: true });
    usedOn(2, path);
    assert.strictEqual(await starAskAfterWin({ enabled: true, statePath: path, gh: gh.run, env: {} }), undefined);
    noteDayOfUse(path, T0 + 2 * DAY);
    assert.strictEqual(await starAskAfterWin({ enabled: true, statePath: path, gh: gh.run, env: {} }), starAskLine({}));
  });

  it("once: never again after it was shown", async () => {
    const path = tmpState();
    usedOn(3, path);
    const gh = fakeGh({}, { missing: true });
    assert.ok(await starAskAfterWin({ enabled: true, statePath: path, gh: gh.run, now: T0 }));
    assert.ok(readStarTipState(path).shownAt);
    assert.strictEqual(await starAskAfterWin({ enabled: true, statePath: path, gh: gh.run }), undefined);
    noteDayOfUse(path, T0 + 10 * DAY);
    assert.strictEqual(await starAskAfterWin({ enabled: true, statePath: path, gh: gh.run }), undefined, "a new day doesn't reset it");
  });

  it("not when turned off (/settings star-tip off), and nothing is called", async () => {
    const path = tmpState();
    usedOn(5, path);
    const gh = fakeGh(SIGNED_IN);
    assert.strictEqual(await starAskAfterWin({ enabled: false, statePath: path, gh: gh.run }), undefined);
    assert.strictEqual(gh.calls.length, 0);
    assert.strictEqual(readStarTipState(path).shownAt, undefined);
  });

  it("without gh signed in: no check against GitHub, only the local `gh auth token`", async () => {
    const path = tmpState();
    usedOn(3, path);
    const gh = fakeGh({ "auth token": { code: 1 } });
    assert.ok(await starAskAfterWin({ enabled: true, statePath: path, gh: gh.run }));
    assert.deepStrictEqual(gh.calls.map((c) => c.args.join(" ")), ["auth token"]);
  });

  it("skipped when gh says it's already starred (1 s timeout), and never checked again", async () => {
    const path = tmpState();
    usedOn(3, path);
    const gh = fakeGh({ ...SIGNED_IN, [`api ${STAR_API_PATH}`]: { code: 0 } });
    assert.strictEqual(await starAskAfterWin({ enabled: true, statePath: path, gh: gh.run }), undefined);
    const check = gh.calls.find((c) => c.args[0] === "api");
    assert.deepStrictEqual(check, { args: ["api", STAR_API_PATH], timeoutMs: 1000 });
    assert.ok(readStarTipState(path).starredAt);
    const again = fakeGh(SIGNED_IN);
    assert.strictEqual(await starAskAfterWin({ enabled: true, statePath: path, gh: again.run }), undefined);
    assert.strictEqual(again.calls.length, 0);
  });

  it("shown when gh says not starred (404) or the check times out", async () => {
    for (const answer of [{ code: 1, stderr: "gh: Not Found (HTTP 404)" }, { code: null }]) {
      const path = tmpState();
      usedOn(3, path);
      const gh = fakeGh({ ...SIGNED_IN, [`api ${STAR_API_PATH}`]: answer as Partial<GhResult> });
      assert.ok(await starAskAfterWin({ enabled: true, statePath: path, gh: gh.run }));
    }
  });

  it("keeps the state in Autopilot's state directory", () => {
    assert.match(starTipStatePath(), /autopilot[\\/]star-tip\.json$/);
  });
});

function deps(o: { key?: string | null; select?: string | null; gh?: GhRun; browser?: boolean } = {}) {
  const said: string[] = [];
  const opened: string[] = [];
  const selects: string[] = [];
  const d: StarAskDeps = {
    readKey: async () => (o.key === undefined ? "x" : o.key),
    select: async (title) => (selects.push(title), o.select ?? null),
    say: (m) => said.push(m),
    openBrowser: (url) => (opened.push(url), o.browser ?? false),
    gh: o.gh ?? fakeGh({}, { missing: true }).run,
  };
  return { d, said, opened, selects };
}

describe("star ask: answering", () => {
  it("s with gh signed in stars it with `gh api -X PUT` and thanks", async () => {
    const gh = fakeGh({ ...SIGNED_IN, [`api -X PUT ${STAR_API_PATH}`]: { code: 0 } });
    const { d, said, opened } = deps({ key: "s", gh: gh.run });
    assert.strictEqual(await runStarAsk(starAskLine({}), d), "starred");
    assert.deepStrictEqual(said, [STARRED_LINE]);
    assert.strictEqual(STARRED_LINE, "✓ Starred. Thank you!");
    assert.deepStrictEqual(opened, []);
    assert.ok(gh.calls.some((c) => c.args.join(" ") === "api -X PUT /user/starred/directionally-local/autopilot"));
  });

  it("s without gh opens the page in the browser", async () => {
    const { d, said, opened } = deps({ key: "s", browser: true });
    assert.strictEqual(await runStarAsk(starAskLine({}), d), "opened");
    assert.deepStrictEqual(opened, [STAR_URL]);
    assert.deepStrictEqual(said, [`Opened ${STAR_URL} in your browser.`]);
  });

  it("s with no browser prints the URL", async () => {
    const { d, said } = deps({ key: "s", browser: false });
    assert.strictEqual(await runStarAsk(starAskLine({}), d), "printed");
    assert.deepStrictEqual(said, [`Star it here: ${STAR_URL}`]);
  });

  it("s with gh signed in but the star failing falls back to the browser", async () => {
    const gh = fakeGh({ ...SIGNED_IN, [`api -X PUT ${STAR_API_PATH}`]: { code: 1 } });
    const { d, opened } = deps({ key: "s", gh: gh.run, browser: true });
    assert.strictEqual(await starIt(d), "opened");
    assert.deepStrictEqual(opened, [STAR_URL]);
  });

  it("any other key dismisses it without calling anything", async () => {
    const gh = fakeGh(SIGNED_IN);
    for (const key of ["x", "\r", "\x1b", "n"]) {
      const { d, said, opened } = deps({ key, gh: gh.run });
      assert.strictEqual(await runStarAsk(starAskLine({}), d), "dismissed");
      assert.deepStrictEqual([said, opened], [[], []]);
    }
    assert.strictEqual(gh.calls.length, 0);
  });

  it("where no key can be read: a two-choice list without the key hint", async () => {
    const star = deps({ key: null, select: "star", browser: true });
    assert.strictEqual(await runStarAsk(starAskLine({ AUTOPILOT_LAUNCHED_BY: "dl" }), star.d), "opened");
    assert.deepStrictEqual(star.selects, ["⭐ Enjoying dl? Star it on GitHub: https://github.com/directionally-local/autopilot"]);
    const esc = deps({ key: null, select: null });
    assert.strictEqual(await runStarAsk(starAskLine({}), esc.d), "dismissed");
  });
});

describe("star ask: state file", () => {
  it("records shownAt as an ISO time", async () => {
    const path = tmpState();
    usedOn(3, path);
    await starAskAfterWin({ enabled: true, statePath: path, gh: fakeGh({}, { missing: true }).run, now: T0 + 5 * DAY });
    const raw = JSON.parse(readFileSync(path, "utf8")) as { shownAt: string; days: number };
    assert.strictEqual(raw.shownAt, new Date(T0 + 5 * DAY).toISOString());
    assert.strictEqual(raw.days, 3);
  });
});

describe("star ask and invite tip: never in the same session", () => {
  function session() {
    let state: import("./star-ask.js").WinTipState = null;
    return { get: () => state, set: (s: typeof state) => void (state = s) };
  }

  it("the invite tip wins a session: no star ask after it, even on later wins", async () => {
    const { winTipAfterWin } = await import("./star-ask.js");
    const s = session();
    let starAsked = 0;
    const star = async () => (starAsked++, "star");
    assert.deepStrictEqual(await winTipAfterWin({ ...s, inviteTip: async () => "invite", starAsk: star }), { kind: "invite", line: "invite" });
    assert.strictEqual(await winTipAfterWin({ ...s, inviteTip: async () => undefined, starAsk: star }), undefined);
    assert.strictEqual(starAsked, 0);
  });

  it("the star ask wins a session: the invite tip isn't even checked afterwards", async () => {
    const { winTipAfterWin } = await import("./star-ask.js");
    const s = session();
    let invites = 0;
    assert.deepStrictEqual(await winTipAfterWin({ ...s, inviteTip: async () => undefined, starAsk: async () => "star" }), { kind: "star", line: "star" });
    assert.strictEqual(await winTipAfterWin({ ...s, inviteTip: async () => (invites++, "invite"), starAsk: async () => "star" }), undefined);
    assert.strictEqual(invites, 0);
  });

  it("neither due: a later win in the session may still show one", async () => {
    const { winTipAfterWin } = await import("./star-ask.js");
    const s = session();
    assert.strictEqual(await winTipAfterWin({ ...s, inviteTip: async () => undefined, starAsk: async () => undefined }), undefined);
    assert.deepStrictEqual(await winTipAfterWin({ ...s, inviteTip: async () => undefined, starAsk: async () => "star" }), { kind: "star", line: "star" });
  });

  it("two wins at once show at most one", async () => {
    const { winTipAfterWin } = await import("./star-ask.js");
    const s = session();
    const both = await Promise.all([
      winTipAfterWin({ ...s, inviteTip: async () => "invite", starAsk: async () => "star" }),
      winTipAfterWin({ ...s, inviteTip: async () => "invite", starAsk: async () => "star" }),
    ]);
    assert.strictEqual(both.filter(Boolean).length, 1);
  });
});
