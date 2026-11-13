import { describe, it } from "node:test";
import assert from "node:assert";
import { FIRST_RUN_QUESTION, firstRunChoices } from "./connect.js";
import {
  DL_DEEPSEEK_MODEL,
  DL_GPT_LIMIT_HINT,
  dlBudgetText,
  dlHeaderLine,
  dlModelAllowanceLine,
  normalizeDlMe,
  parseDlError,
  renderDlUsage,
  type DlMe,
} from "./directionally-local.js";
import { DL_SWITCH_DEEPSEEK_LABEL, dlHeadlessLine, dlScreenChoices, dlScreenFollowUp, dlScreenFor, runDlScreen, type DlScreenDeps } from "./dl-growth.js";

/**
 * Two weekly budgets on the free tier: GPT-6 (every GPT-6 model) and DeepSeek. /usage, the header
 * and the model picker show both, dollars first (the limit that binds) and tokens counted the
 * normal way; a 402 gpt_limit offers DeepSeek in one keypress.
 */

const NOW = Date.parse("2026-11-12T03:00:00Z"); // a Thursday
const RESETS = "2026-11-16T00:00:00.000Z"; // Mon 09:00 in Tokyo
const TZ = { timeZone: "Asia/Tokyo" };

function me(budgets: Record<string, unknown>, extra: Record<string, unknown> = {}): DlMe {
  return normalizeDlMe({
    login: "octo",
    plan: "free",
    allowance: { tokensPerWeek: 50_000_000, usedThisWeek: 0, remaining: 50_000_000, resetsAt: RESETS, usdPerWeek: 2, spentUsdThisWeek: 0.4 },
    budgets,
    ...extra,
  })!;
}

const BOTH = {
  gpt6: { usdPerWeek: 2, spentUsd: 0.4, tokensThisWeek: 6_000_000 },
  deepseek: { usdPerWeek: 8, spentUsd: 1.2, tokensThisWeek: 58_000_000 },
};

describe("two weekly budgets in /v1/me", () => {
  it("reads both budgets, from the top level or under allowance, and keeps only well-formed ones", () => {
    assert.deepStrictEqual(me(BOTH).budgets, BOTH);
    const nested = normalizeDlMe({ login: "o", allowance: { tokensPerWeek: 1, usedThisWeek: 0, remaining: 1, resetsAt: RESETS, budgets: BOTH } })!;
    assert.deepStrictEqual(nested.budgets, BOTH);
    assert.deepStrictEqual(me({ gpt6: { usdPerWeek: "2", spentUsd: 0 }, deepseek: { usdPerWeek: null, spentUsd: 1 } }).budgets, { deepseek: { usdPerWeek: null, spentUsd: 1 } });
    // An older server: no budgets at all.
    assert.strictEqual(normalizeDlMe({ login: "o", allowance: { tokensPerWeek: 1, usedThisWeek: 0, remaining: 1, resetsAt: RESETS } })!.budgets, undefined);
  });

  it("words one budget as dollars first, then every token processed, or the reset once spent", () => {
    assert.strictEqual(dlBudgetText(BOTH.deepseek, RESETS, { now: NOW, ...TZ }), "$1.20 of $8 this week · 58M tokens");
    assert.strictEqual(dlBudgetText(BOTH.gpt6, RESETS, { now: NOW, ...TZ }), "$0.40 of $2 this week · 6M tokens");
    assert.strictEqual(dlBudgetText({ usdPerWeek: 2, spentUsd: 2, tokensThisWeek: 9_000_000 }, RESETS, { now: NOW, ...TZ }), "limit reached, resets Mon 09:00");
    assert.strictEqual(dlBudgetText({ usdPerWeek: 8, spentUsd: 1.2 }, RESETS, { now: NOW, ...TZ }), "$1.20 of $8 this week", "an older count without tokens");
  });

  it("shows both budgets in /usage, GPT-6 first", () => {
    const text = renderDlUsage(me(BOTH), NOW, TZ.timeZone);
    assert.match(text, /^ {2}gpt-6 {11}\$0\.40 of \$2 this week · 6M tokens$/m);
    assert.match(text, /^ {2}deepseek {8}\$1\.20 of \$8 this week · 58M tokens$/m);
    assert.doesNotMatch(text, /tokens {10}/, "no separate charged-token line");
    assert.doesNotMatch(text, /limit reached/);
  });

  it("says GPT-6 is used up and points at DeepSeek while DeepSeek has room", () => {
    const text = renderDlUsage(me({ ...BOTH, gpt6: { usdPerWeek: 2, spentUsd: 2, tokensThisWeek: 7_000_000 } }), NOW, TZ.timeZone);
    assert.match(text, /^ {2}gpt-6 {11}limit reached, resets Mon 09:00$/m);
    assert.match(text, /^ {2}deepseek {8}\$1\.20 of \$8 this week · 58M tokens$/m);
    assert.ok(text.includes(DL_GPT_LIMIT_HINT));
  });

  it("shows both budgets in the header, and limit reached only when both are spent", () => {
    assert.strictEqual(dlHeaderLine(me(BOTH)), "free · gpt-6 $1.60 left · deepseek $6.80 left");
    assert.strictEqual(dlHeaderLine(me({ ...BOTH, gpt6: { usdPerWeek: 2, spentUsd: 2 } })), "free · gpt-6 limit reached · deepseek $6.80 left");
    assert.strictEqual(dlHeaderLine(me({ gpt6: { usdPerWeek: 2, spentUsd: 2 }, deepseek: { usdPerWeek: 8, spentUsd: 8 } })), "free · limit reached");
  });

  it("shows each model's own budget in the model picker", () => {
    const account = me(BOTH);
    assert.strictEqual(dlModelAllowanceLine(DL_DEEPSEEK_MODEL, account)?.replace(/resets .*/, ""), "$1.20 of $8 this week · 58M tokens");
    assert.strictEqual(dlModelAllowanceLine("gpt-6.1-sol", account), "$0.40 of $2 this week · 6M tokens");
    const spent = me({ ...BOTH, gpt6: { usdPerWeek: 2, spentUsd: 2 } });
    assert.match(dlModelAllowanceLine("gpt-6-luna", spent)!, /^limit reached, resets /);
    assert.strictEqual(dlModelAllowanceLine(DL_DEEPSEEK_MODEL, spent), "$1.20 of $8 this week · 58M tokens");
  });
});

describe("402 gpt_limit", () => {
  const body = {
    error: {
      code: "gpt_limit",
      message: "You've used this week's GPT-6 allowance. DeepSeek V4.1 Flash still has free usage this week: switch with /model, or get dl Pro.",
      family: "gpt6",
      resetsAt: RESETS,
      alternative: DL_DEEPSEEK_MODEL,
      offers: { pro: { priceUsdMonthly: 3.99, price: "$3.99/month", usdPerWeek: 6, valueLine: "Lots of DeepSeek every week, plus more GPT-6." } },
    },
  };

  it("reads the family and the alternative", () => {
    const e = parseDlError(body)!;
    assert.strictEqual(e.code, "gpt_limit");
    assert.strictEqual(e.family, "gpt6");
    assert.strictEqual(e.alternative, DL_DEEPSEEK_MODEL);
  });

  it("offers DeepSeek first, one keypress, then Pro and your own key", () => {
    const e = parseDlError(body)!;
    const screen = dlScreenFor(e.code, e, undefined, "free")!;
    assert.strictEqual(screen.kind, "gpt");
    const choices = dlScreenChoices(screen.kind, screen);
    assert.deepStrictEqual(
      choices.map((c) => c.value),
      ["deepseek", "pro", "own-key"],
    );
    assert.strictEqual(choices[0]!.label, DL_SWITCH_DEEPSEEK_LABEL);
    // On Pro: no Pro offer.
    assert.deepStrictEqual(
      dlScreenChoices("gpt", { ...screen, plan: "pro" }).map((c) => c.value),
      ["deepseek", "own-key"],
    );
  });

  it("switches to DeepSeek and sends the blocked request again", async () => {
    const e = parseDlError(body)!;
    const screen = dlScreenFor(e.code, e, undefined, "free")!;
    let title = "";
    const deps = {
      now: () => NOW,
      timeZone: TZ.timeZone,
      say: () => {},
      copy: () => true,
      select: async (t: string, options: Array<{ value: string }>) => {
        title = t;
        return options[0]!.value;
      },
    } as unknown as DlScreenDeps;
    const outcome = await runDlScreen(screen, deps);
    assert.strictEqual(outcome, "deepseek");
    assert.strictEqual(title, "You've used this week's GPT-6 allowance (back Mon 09:00). DeepSeek V4.1 Flash still has free usage this week.");
    assert.deepStrictEqual(dlScreenFollowUp(outcome, "line", { text: "fix it", display: "fix it" }), {
      kind: "switch-model",
      model: DL_DEEPSEEK_MODEL,
      retry: { text: "fix it", display: "fix it" },
    });
    assert.deepStrictEqual(dlScreenFollowUp(outcome, null, null), { kind: "switch-model", model: DL_DEEPSEEK_MODEL });
  });

  it("gives headless runs one line with the model to run on", () => {
    const e = parseDlError(body)!;
    assert.strictEqual(
      dlHeadlessLine(e.code, e, { now: NOW, ...TZ }),
      `You've used this week's GPT-6 allowance (back Mon 09:00). DeepSeek V4.1 Flash still has free usage this week. Run with \`-m ${DL_DEEPSEEK_MODEL}\` to use it.`,
    );
  });
});

describe("the first run is unchanged", () => {
  it("offers the free tier (the default), your own key, then your own GPUs, in that order", () => {
    const choices = firstRunChoices();
    assert.deepStrictEqual(
      choices.map((c) => c.value),
      ["free", "own-key", "gpus"],
    );
    assert.deepStrictEqual(
      choices.map((c) => c.label),
      ["Free — sign in with GitHub", "Use my own API key", "Use your own GPUs"],
    );
    assert.ok(FIRST_RUN_QUESTION.length > 0);
  });
});
