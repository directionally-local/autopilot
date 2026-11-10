import { describe, it, beforeEach } from "node:test";
import assert from "node:assert";
import {
  ACCESS_BUILDING_MAX,
  ACCESS_CANCELLED_LINE,
  ACCESS_CHECK_FAILED_LINE,
  ACCESS_FAILED_LINE,
  ACCESS_GRANTED_LINE,
  ACCESS_PENDING_LINE,
  ACCESS_REQUEST_HINT,
  ACCESS_SENT_LINE,
  ACCESS_UNAVAILABLE_LINE,
  accessNotFreeTierLine,
  buildingProblem,
  cleanLink,
  runAccessRequest,
  type AccessRequestDeps,
} from "./access-request.js";
import { describeDlError, parseDlError } from "./providers/directionally-local.js";
import { dlHeadlessLine, dlScreenFor, runDlScreen, type DlScreenDeps } from "./providers/dl-growth.js";
import { queuedDlEvents, resetDlEventsForTesting } from "./providers/dl-events.js";
import { dispatchSlashCommand, type SlashContext } from "./ui/slash-commands.js";
import { BUILTIN_COMMANDS } from "./commands/builtins.js";
import { CATEGORIES, SINGLE_COMMANDS } from "./ui/help-catalog.js";

const ORIGIN = "http://free.test";
const ENV = { AUTOPILOT_DL_FREE_URL: ORIGIN } as NodeJS.ProcessEnv;
const PATH = `${ORIGIN}/v1/access-request`;
const BUILDING = "a local-first notes app for my team";

type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | "network";
type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A fake free tier: answers GET and POST /v1/access-request from scripts, records every request. */
function fakeServer(o: { get?: Reply | Reply[]; post?: Reply | Reply[] } = {}) {
  const calls: Call[] = [];
  const gets = Array.isArray(o.get) ? [...o.get] : [o.get ?? { status: 200, body: { status: "none" } }];
  const postReplies = Array.isArray(o.post) ? [...o.post] : [o.post ?? { status: 201, body: { status: "pending" } }];
  const next = (list: Reply[]) => (list.length > 1 ? list.shift()! : list[0]!);
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const method = init.method ?? "GET";
    calls.push({ url, method, headers: { ...(init.headers as Record<string, string>) }, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    if (url !== PATH) return new Response(JSON.stringify({ error: { code: "not_found" } }), { status: 404 });
    const r = next(method === "POST" ? postReplies : gets);
    if (r === "network") throw new TypeError("fetch failed");
    return new Response(r.body === undefined ? "" : JSON.stringify(r.body), { status: r.status, headers: { "Content-Type": "application/json", ...r.headers } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Deps with scripted answers (null is Esc); records what each question was shown. */
function deps(fetchImpl: typeof fetch, answers: { building?: (string | null)[]; link?: (string | null)[] } = {}, over: Partial<AccessRequestDeps> = {}) {
  const asked: { field: string; problem?: string; draft?: string }[] = [];
  const tokens: (boolean | undefined)[] = [];
  const building = [...(answers.building ?? [])];
  const link = [...(answers.link ?? [])];
  const d: AccessRequestDeps = {
    providerId: "directionally-local",
    token: async (force) => (tokens.push(force), force ? "tok-fresh" : "tok-1"),
    ask: async (field, x) => {
      asked.push({ field, ...x });
      const list = field === "building" ? building : link;
      return list.length ? list.shift()! : null;
    },
    fetchImpl,
    env: ENV,
    ...over,
  };
  return { d, asked, tokens };
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

describe("/request flow: status", () => {
  it("pending: says the request is in, asks nothing and sends nothing", async () => {
    const { fetchImpl, calls } = fakeServer({ get: { status: 200, body: { status: "pending", at: "2026-11-09T10:00:00Z" } } });
    const { d, asked } = deps(fetchImpl);
    assert.deepStrictEqual(await runAccessRequest(d), { text: ACCESS_PENDING_LINE, severity: "info" });
    assert.strictEqual(ACCESS_PENDING_LINE, "your request is in, sina reviews them by hand, usually within a day");
    assert.strictEqual(asked.length, 0);
    assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.url}`), [`GET ${PATH}`]);
    assert.strictEqual(calls[0]!.headers.Authorization, "Bearer tok-1");
  });

  it("granted: says the full free tier is already on, and to restart if limits look stale", async () => {
    const { fetchImpl, calls } = fakeServer({ get: { status: 200, body: { status: "granted" } } });
    const { d, asked } = deps(fetchImpl);
    const line = await runAccessRequest(d);
    assert.strictEqual(line.text, ACCESS_GRANTED_LINE);
    assert.match(line.text, /full free tier.*restart the session/);
    assert.strictEqual(asked.length, 0);
    assert.strictEqual(posts(calls).length, 0);
  });

  for (const status of ["none", "declined"]) {
    it(`${status}: asks both questions, sends them with the token, and confirms`, async () => {
      const { fetchImpl, calls } = fakeServer({ get: { status: 200, body: { status } } });
      const { d, asked } = deps(fetchImpl, { building: [`  ${BUILDING}  `], link: ["https://github.com/ana"] });
      assert.deepStrictEqual(await runAccessRequest(d), { text: ACCESS_SENT_LINE, severity: "info" });
      assert.strictEqual(ACCESS_SENT_LINE, "sent. sina reviews these by hand, usually within a day. you'll get an email when it's done.");
      assert.deepStrictEqual(asked.map((a) => a.field), ["building", "link"]);
      const [post] = posts(calls);
      assert.strictEqual(post!.url, PATH);
      assert.strictEqual(post!.headers.Authorization, "Bearer tok-1");
      assert.strictEqual(post!.headers["Content-Type"], "application/json");
      assert.deepStrictEqual(post!.body, { building: BUILDING, link: "https://github.com/ana" });
    });
  }

  it("Enter on the link skips it: the body has no link", async () => {
    const { fetchImpl, calls } = fakeServer();
    const { d } = deps(fetchImpl, { building: [BUILDING], link: [""] });
    assert.strictEqual((await runAccessRequest(d)).text, ACCESS_SENT_LINE);
    assert.deepStrictEqual(posts(calls)[0]!.body, { building: BUILDING });
  });

  it("a bare github.com/me link is sent as https://", async () => {
    const { fetchImpl, calls } = fakeServer();
    const { d } = deps(fetchImpl, { building: [BUILDING], link: ["github.com/ana"] });
    await runAccessRequest(d);
    assert.deepStrictEqual(posts(calls)[0]!.body, { building: BUILDING, link: "https://github.com/ana" });
  });

  it("an older server (404 on GET) says the feature isn't available yet and asks nothing", async () => {
    const { fetchImpl, calls } = fakeServer({ get: { status: 404, body: { error: { code: "not_found" } } } });
    const { d, asked } = deps(fetchImpl);
    assert.deepStrictEqual(await runAccessRequest(d), { text: ACCESS_UNAVAILABLE_LINE, severity: "error" });
    assert.strictEqual(asked.length, 0);
    assert.strictEqual(posts(calls).length, 0);
  });

  it("the status check failing (network, 5xx, a body it can't read) stops before asking", async () => {
    for (const get of ["network", { status: 502, body: { error: { code: "bad_gateway" } } }, { status: 200, body: { status: "maybe" } }] as Reply[]) {
      const { fetchImpl, calls } = fakeServer({ get });
      const { d, asked } = deps(fetchImpl);
      assert.deepStrictEqual(await runAccessRequest(d), { text: ACCESS_CHECK_FAILED_LINE, severity: "error" });
      assert.strictEqual(asked.length, 0);
      assert.strictEqual(posts(calls).length, 0);
    }
  });

  it("a rejected token is refreshed once and the call made again", async () => {
    const { fetchImpl, calls } = fakeServer({ get: [{ status: 401, body: { error: { code: "invalid_token" } } }, { status: 200, body: { status: "pending" } }] });
    const { d, tokens } = deps(fetchImpl);
    assert.strictEqual((await runAccessRequest(d)).text, ACCESS_PENDING_LINE);
    assert.deepStrictEqual(tokens, [undefined, true]);
    assert.deepStrictEqual(calls.map((c) => c.headers.Authorization), ["Bearer tok-1", "Bearer tok-fresh"]);
  });

  it("a token still rejected after the refresh: says to sign in again, asks nothing", async () => {
    const { fetchImpl, calls } = fakeServer({ get: { status: 401, body: { error: { code: "invalid_token" } } } });
    const { d, asked } = deps(fetchImpl);
    const line = await runAccessRequest(d);
    assert.strictEqual(line.severity, "error");
    assert.match(line.text, /sign in again/);
    assert.strictEqual(calls.length, 2);
    assert.strictEqual(asked.length, 0);
  });

  it("not signed in: says how to sign in and calls nothing", async () => {
    const { fetchImpl, calls } = fakeServer();
    const { d } = deps(fetchImpl, {}, { token: async () => undefined });
    const line = await runAccessRequest(d);
    assert.strictEqual(line.severity, "error");
    assert.match(line.text, /sign/i);
    assert.strictEqual(calls.length, 0);
  });

  it("off the free tier: says /request is for the free tier and calls nothing", async () => {
    const { fetchImpl, calls } = fakeServer();
    const { d } = deps(fetchImpl, {}, { providerId: "openrouter", providerName: "OpenRouter" });
    assert.deepStrictEqual(await runAccessRequest(d), { text: accessNotFreeTierLine("OpenRouter"), severity: "info" });
    assert.match(accessNotFreeTierLine("OpenRouter"), /^\/request is for the Directionally Local free tier; you're on OpenRouter\./);
    assert.strictEqual(calls.length, 0);
  });
});

describe("/request flow: send errors", () => {
  const send = async (post: Reply) => {
    const { fetchImpl, calls } = fakeServer({ post });
    const { d } = deps(fetchImpl, { building: [BUILDING], link: [""] });
    const line = await runAccessRequest(d);
    assert.strictEqual(posts(calls).length, 1);
    return line;
  };

  it("409 already_pending: the request is already in", async () => {
    assert.deepStrictEqual(await send({ status: 409, body: { error: { code: "already_pending" } } }), { text: ACCESS_PENDING_LINE, severity: "info" });
  });

  it("409 already_full: the full free tier is already on", async () => {
    assert.deepStrictEqual(await send({ status: 409, body: { error: { code: "already_full" } } }), { text: ACCESS_GRANTED_LINE, severity: "info" });
  });

  it("429: says when to try again (body, header, or later)", async () => {
    assert.deepStrictEqual(await send({ status: 429, body: { error: { code: "rate_limited", retryAfter: 600 } } }), {
      text: "too many requests from this account; try /request again in 10 minutes.",
      severity: "error",
    });
    assert.strictEqual((await send({ status: 429, body: {}, headers: { "Retry-After": "30" } })).text, "too many requests from this account; try /request again in 1 minute.");
    assert.strictEqual((await send({ status: 429 })).text, "too many requests from this account; try /request again later.");
  });

  it("400 invalid_request: shows the service's message", async () => {
    assert.deepStrictEqual(await send({ status: 400, body: { error: { code: "invalid_request", message: "link must be an http(s) URL" } } }), {
      text: "not sent: link must be an http(s) URL.",
      severity: "error",
    });
    assert.strictEqual((await send({ status: 400, body: {} })).text, "not sent: the free tier didn't accept the request.");
  });

  it("404 on POST (an older server): the feature isn't available yet", async () => {
    assert.deepStrictEqual(await send({ status: 404 }), { text: ACCESS_UNAVAILABLE_LINE, severity: "error" });
    assert.strictEqual(ACCESS_UNAVAILABLE_LINE, "asking for more free tokens isn't available on this free tier server yet.");
  });

  it("network error and 5xx: nothing was sent, try again", async () => {
    assert.deepStrictEqual(await send("network"), { text: ACCESS_FAILED_LINE, severity: "error" });
    assert.deepStrictEqual(await send({ status: 500 }), { text: ACCESS_FAILED_LINE, severity: "error" });
  });

  it("a known free tier code (suspended) gets its own sentence", async () => {
    const line = await send({ status: 403, body: { error: { code: "suspended" } } });
    assert.match(line.text, /suspended/);
  });
});

describe("/request flow: Esc and validation", () => {
  it("Esc at either question sends nothing", async () => {
    for (const answers of [{ building: [null] }, { building: [BUILDING], link: [null] }]) {
      const { fetchImpl, calls } = fakeServer();
      const { d } = deps(fetchImpl, answers);
      assert.deepStrictEqual(await runAccessRequest(d), { text: ACCESS_CANCELLED_LINE, severity: "info" });
      assert.strictEqual(posts(calls).length, 0);
    }
  });

  it("an answer under 10 or over 600 characters is asked again, keeping the draft", async () => {
    const long = "x".repeat(ACCESS_BUILDING_MAX + 1);
    const { fetchImpl, calls } = fakeServer();
    const { d, asked } = deps(fetchImpl, { building: ["  short  ", "", long, BUILDING], link: [""] });
    assert.strictEqual((await runAccessRequest(d)).text, ACCESS_SENT_LINE);
    assert.deepStrictEqual(
      asked.filter((a) => a.field === "building"),
      [
        { field: "building" },
        { field: "building", problem: "at least 10 characters, please", draft: "  short  " },
        { field: "building", problem: "at least 10 characters, please" },
        { field: "building", problem: "601 characters; keep it to 600", draft: long },
      ],
    );
    assert.deepStrictEqual(posts(calls)[0]!.body, { building: BUILDING });
  });

  it("a link that isn't http(s), or is too long, is asked again", async () => {
    const tooLong = `https://example.com/${"a".repeat(300)}`;
    const { fetchImpl, calls } = fakeServer();
    const { d, asked } = deps(fetchImpl, { building: [BUILDING], link: ["ftp://x.org", "not a link", tooLong, "https://ana.dev"] });
    assert.strictEqual((await runAccessRequest(d)).text, ACCESS_SENT_LINE);
    assert.deepStrictEqual(
      asked.filter((a) => a.field === "link").map((a) => a.problem),
      [undefined, "that doesn't look like a link (http or https)", "that doesn't look like a link (http or https)", `that link is ${tooLong.length} characters; keep it to 300`],
    );
    assert.deepStrictEqual(posts(calls)[0]!.body, { building: BUILDING, link: "https://ana.dev" });
  });

  it("the checks themselves", () => {
    assert.strictEqual(buildingProblem("x".repeat(10)), undefined);
    assert.strictEqual(buildingProblem(` ${"x".repeat(9)} `), "at least 10 characters, please");
    assert.strictEqual(buildingProblem("x".repeat(600)), undefined);
    assert.deepStrictEqual(cleanLink("   "), {});
    assert.deepStrictEqual(cleanLink(" http://a.io/x "), { link: "http://a.io/x" });
    assert.ok(cleanLink("javascript:alert(1)").problem);
  });
});

describe("/request keeps what's typed private", () => {
  beforeEach(() => resetDlEventsForTesting());

  it("emits no usage events and calls nothing but /v1/access-request", async () => {
    const { fetchImpl, calls } = fakeServer();
    const { d } = deps(fetchImpl, { building: [BUILDING], link: ["https://github.com/ana"] });
    const logged: string[] = [];
    const orig = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
    try {
      await runAccessRequest(d);
    } finally {
      Object.assign(console, orig);
    }
    assert.strictEqual(queuedDlEvents().length, 0);
    assert.ok(calls.every((c) => c.url === PATH));
    assert.ok(!logged.some((l) => l.includes(BUILDING) || l.includes("github.com/ana")));
  });
});

describe("the /request hint on free tier refusals", () => {
  const request = "/v1/access-request";

  it("parseDlError keeps `request`", () => {
    assert.strictEqual(parseDlError({ error: { code: "below_bar", request } })?.request, request);
    assert.strictEqual(parseDlError({ error: { code: "below_bar" } })?.request, undefined);
  });

  it("below_bar: one more line only when the service sent `request`", () => {
    const message = "Free tokens are for established GitHub accounts.";
    assert.strictEqual(describeDlError("below_bar", { message, request }), `${message}\n${ACCESS_REQUEST_HINT}`);
    assert.strictEqual(describeDlError("below_bar", { message }), message);
    assert.ok(!describeDlError("below_bar", {})!.includes("/request"));
    assert.strictEqual(ACCESS_REQUEST_HINT, "type /request to ask for more free tokens.");
  });

  it("basic_limit reads like the weekly limit, plus the hint when `request` is there", () => {
    const resetsAt = "2026-11-16T00:00:00Z";
    const quota = describeDlError("quota_exceeded", { resetsAt, timeZone: "UTC", now: Date.parse("2026-11-10T00:00:00Z") })!;
    assert.strictEqual(describeDlError("basic_limit", { resetsAt, timeZone: "UTC", now: Date.parse("2026-11-10T00:00:00Z") }), quota);
    assert.strictEqual(describeDlError("basic_limit", { resetsAt, request, timeZone: "UTC", now: Date.parse("2026-11-10T00:00:00Z") }), `${quota}\n${ACCESS_REQUEST_HINT}`);
  });

  it("no hint outside a session (the CLI has no /request)", () => {
    assert.ok(!describeDlError("below_bar", { request, where: "cli" })!.includes("/request"));
    assert.ok(!describeDlError("basic_limit", { request, where: "cli" })!.includes("/request"));
  });

  it("basic_limit opens the weekly limit screen, which shows the hint only with `request`", async () => {
    assert.deepStrictEqual(dlScreenFor("basic_limit", { request }), { kind: "quota", request });
    assert.deepStrictEqual(dlScreenFor("basic_limit", {}), { kind: "quota" });
    assert.ok(dlHeadlessLine("basic_limit", {})?.length);
    const subtitles: (string | undefined)[] = [];
    const screenDeps = {
      select: async (_t: string, _o: unknown, subtitle?: string) => (subtitles.push(subtitle), null),
      copy: () => false,
      now: () => Date.parse("2026-11-10T00:00:00Z"),
      timeZone: "UTC",
    } as unknown as DlScreenDeps;
    await runDlScreen({ kind: "quota", request }, screenDeps);
    await runDlScreen({ kind: "quota" }, screenDeps);
    assert.deepStrictEqual(subtitles, [`${ACCESS_REQUEST_HINT} · Enter to choose · Esc to close`, "Enter to choose · Esc to close"]);
  });
});

describe("/request command", () => {
  const ctxWith = (cfg: Record<string, unknown> | null, open = true) => {
    const opened: unknown[] = [];
    const said: string[] = [];
    const ctx = {
      cfg,
      busy: false,
      mkKey: () => "k",
      setEvents: (f: (e: { text: string }[]) => { text: string }[]) => void said.push(...f([]).map((e) => e.text)),
      ...(open ? { openAccessRequest: (o: unknown) => void opened.push(o) } : {}),
    } as unknown as SlashContext;
    return { ctx, opened, said };
  };

  it("on the free tier opens the flow; text after it is not passed on", async () => {
    const free = ctxWith({ provider: "directionally-local", model: "deepseek/deepseek-v4.1-flash-1017" });
    assert.strictEqual(await dispatchSlashCommand(free.ctx, "/request I build things"), true);
    assert.strictEqual(free.opened.length, 1);
    assert.strictEqual((free.opened[0] as { providerId: string }).providerId, "directionally-local");
    assert.ok(!JSON.stringify(free.opened).includes("I build things"));
    assert.deepStrictEqual(free.said, []);
  });

  it("on another provider says it's for the free tier and opens nothing", async () => {
    const own = ctxWith({ provider: "openrouter", model: "vendor/model", openrouterApiKey: "sk-or" });
    await dispatchSlashCommand(own.ctx, "/request");
    assert.deepStrictEqual(own.opened, []);
    assert.strictEqual(own.said.length, 1);
    assert.match(own.said[0]!, /^\/request is for the Directionally Local free tier/);
  });

  it("is in the slash picker and /help", () => {
    assert.ok(BUILTIN_COMMANDS.some((c) => c.name === "request"));
    assert.ok([...CATEGORIES.flatMap((c) => c.commands), ...SINGLE_COMMANDS].some((x) => x.command === "/request"));
  });
});
