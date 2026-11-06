import { describe, it } from "node:test";
import assert from "node:assert";
import { DL_STATUS_OPEN, dlPausedLine, dlWaitlistText, fetchDlStatus, formatOpensAt, parseDlStatus, type DlFreeStatus } from "./dl-status.js";
import {
  DL_FREE_MODEL_LINE,
  DL_FREE_PAUSED_LABEL,
  firstRunChoices,
  firstRunSubtitle,
  freeChoosable,
  providerRows,
  rowsWithFreeStatus,
  statusMessage,
} from "./connect.js";

const waitlist: DlFreeStatus = { free: "waitlist", reason: "weekly_budget", message: "This week's free seats are taken; you'll be queued.", opensAt: "2026-11-09T03:00:00.000Z" };
const paused: DlFreeStatus = { free: "paused", reason: "kill_switch", message: "Free is paused while we fix something.", opensAt: null };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("free tier status", () => {
  it("reads waitlist and paused; anything else is open", () => {
    assert.deepStrictEqual(parseDlStatus({ ...waitlist, updatedAt: "2026-11-05T00:00:00Z" }), waitlist);
    assert.deepStrictEqual(parseDlStatus(paused), paused);
    assert.deepStrictEqual(parseDlStatus({ free: "open", reason: null, message: "", opensAt: null }), DL_STATUS_OPEN);
    assert.deepStrictEqual(parseDlStatus({ free: "closed-forever" }), DL_STATUS_OPEN);
    assert.deepStrictEqual(parseDlStatus(null), DL_STATUS_OPEN);
    assert.deepStrictEqual(parseDlStatus("paused"), DL_STATUS_OPEN);
    assert.strictEqual(parseDlStatus({ free: "waitlist", opensAt: "not a date" }).opensAt, null);
  });

  it("asks the provider's base URL (AUTOPILOT_DL_FREE_URL) for /v1/status", async () => {
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => (urls.push(url), json(paused))) as unknown as typeof fetch;
    assert.deepStrictEqual(await fetchDlStatus({ fetchImpl, env: { AUTOPILOT_DL_FREE_URL: "http://127.0.0.1:9/v1/" } }), paused);
    await fetchDlStatus({ fetchImpl, env: {} });
    assert.deepStrictEqual(urls, ["http://127.0.0.1:9/v1/status", "https://free.directionallylocal.com/v1/status"]);
  });

  it("falls back to open on an error, a non-2xx answer, bad JSON or a timeout", async () => {
    const env = { AUTOPILOT_DL_FREE_URL: "http://stub.invalid" };
    const failing = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    assert.deepStrictEqual(await fetchDlStatus({ fetchImpl: failing, env }), DL_STATUS_OPEN);
    assert.deepStrictEqual(await fetchDlStatus({ fetchImpl: (async () => json(paused, 503)) as unknown as typeof fetch, env }), DL_STATUS_OPEN);
    assert.deepStrictEqual(await fetchDlStatus({ fetchImpl: (async () => new Response("<html>")) as unknown as typeof fetch, env }), DL_STATUS_OPEN);
    const hanging = ((_u: string, init: RequestInit) =>
      new Promise((_r, reject) => {
        // Keep the event loop alive so the timeout can fire even when this is the only pending work.
        const keepAlive = setTimeout(() => {}, 60_000);
        init.signal?.addEventListener("abort", () => {
          clearTimeout(keepAlive);
          reject(init.signal?.reason);
        });
      })) as unknown as typeof fetch;
    const started = Date.now();
    assert.deepStrictEqual(await fetchDlStatus({ fetchImpl: hanging, env, timeoutMs: 50 }), DL_STATUS_OPEN);
    assert.ok(Date.now() - started < 1_000);
  });

  it("says when a waitlist opens as a local date", () => {
    assert.strictEqual(formatOpensAt("2026-11-09T03:00:00.000Z", "Asia/Tokyo"), "Mon 9 Nov");
    assert.strictEqual(formatOpensAt("2026-11-09T03:00:00.000Z", "America/Los_Angeles"), "Sun 8 Nov");
    assert.strictEqual(dlWaitlistText(waitlist, "UTC"), "waitlist, opens Mon 9 Nov");
    assert.strictEqual(dlWaitlistText({ opensAt: null }), "waitlist");
    assert.strictEqual(formatOpensAt(null), undefined);
  });

  it("says the service's message when paused, or a plain line without one", () => {
    assert.strictEqual(dlPausedLine(paused), paused.message);
    assert.match(dlPausedLine({ message: "" }), /paused/);
  });
});

describe("first-run choices under the free tier's status", () => {
  it("open: unchanged", () => {
    assert.deepStrictEqual(firstRunChoices(DL_STATUS_OPEN), firstRunChoices());
    assert.deepStrictEqual(
      firstRunChoices().map((c) => [c.value, c.label, c.description]),
      [
        ["free", "Free — sign in with GitHub", "GPT-6 Luna + DeepSeek, 50M tokens a week, no credit card"],
        ["own-key", "Use my own API key", "OpenRouter, Anthropic, OpenAI and more"],
      ],
    );
    assert.strictEqual(firstRunSubtitle(DL_STATUS_OPEN, "Esc to quit"), `${DL_FREE_MODEL_LINE} · Esc to quit`);
    assert.strictEqual(statusMessage(DL_STATUS_OPEN), undefined);
    assert.ok(freeChoosable(DL_STATUS_OPEN));
  });

  it("waitlist: Free stays first and choosable, says when it opens, and the subtitle is the service's message", () => {
    const choices = firstRunChoices(waitlist, "Asia/Tokyo");
    assert.deepStrictEqual(choices[0], { value: "free", label: "Free — sign in with GitHub", description: "waitlist, opens Mon 9 Nov" });
    assert.ok(freeChoosable(waitlist));
    assert.strictEqual(firstRunSubtitle(waitlist, "Esc to quit"), `${waitlist.message} · Esc to quit`);
  });

  it("starter: the Free row says DeepSeek only and the Starter allowance", () => {
    const choices = firstRunChoices(DL_STATUS_OPEN, undefined, true);
    assert.equal(choices[0]?.description, "Starter: DeepSeek only, 5M tokens a week");
    assert.strictEqual(firstRunSubtitle(DL_STATUS_OPEN, "Esc to quit", true), "Free: Starter — DeepSeek only, 5M tokens a week · Esc to quit");
  });

  it("paused: own key first (the default), Free last and not choosable, the subtitle is the service's message", () => {
    const choices = firstRunChoices(paused);
    assert.deepStrictEqual(choices.map((c) => c.value), ["own-key", "free"]);
    assert.strictEqual(choices[1]?.label, DL_FREE_PAUSED_LABEL);
    assert.ok(!freeChoosable(paused));
    assert.strictEqual(firstRunSubtitle(paused, "Esc to cancel"), `${paused.message} · Esc to cancel`);
  });
});

describe("/provider rows under the free tier's status", () => {
  const env = {} as NodeJS.ProcessEnv;
  it("open: unchanged", () => {
    const rows = providerRows(null, { env });
    assert.deepStrictEqual(rowsWithFreeStatus(rows, DL_STATUS_OPEN), rows);
  });

  it("waitlist: the free row says when it opens", () => {
    const rows = rowsWithFreeStatus(providerRows(null, { env }), waitlist, "UTC");
    assert.strictEqual(rows[0]?.id, "directionally-local");
    assert.match(rows[0]!.hint, /waitlist, opens Mon 9 Nov/);
  });

  it("paused: the free row goes last, named paused", () => {
    const rows = rowsWithFreeStatus(providerRows(null, { env }), paused);
    assert.strictEqual(rows.at(-1)?.id, "directionally-local");
    assert.match(rows.at(-1)!.name, /— paused$/);
    assert.notStrictEqual(rows[0]?.id, "directionally-local");
  });

  it("signed in: left alone", () => {
    const rows = providerRows(null, { env: { AUTOPILOT_DL_FREE_TOKEN: "at-1" } });
    const free = rows.find((r) => r.id === "directionally-local");
    assert.ok(free?.credentials, "the env token counts as signed in");
    assert.deepStrictEqual(rowsWithFreeStatus(rows, paused), rows);
  });
});
