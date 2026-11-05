import { describe, it } from "node:test";
import assert from "node:assert";
import {
  FEEDBACK_FALLBACK_LINE,
  FEEDBACK_MAX_CHARS,
  FEEDBACK_NOT_SENT_LINE,
  feedbackClient,
  runFeedback,
  type FeedbackDeps,
} from "./feedback.js";
import { dispatchSlashCommand, type SlashContext } from "./ui/slash-commands.js";
import { BUILTIN_COMMANDS } from "./commands/builtins.js";
import { CATEGORIES, SINGLE_COMMANDS } from "./ui/help-catalog.js";

const ORIGIN = "http://feedback.test";
const ENV = { AUTOPILOT_DL_FREE_URL: ORIGIN, DL_VERSION: "0.17.0" } as NodeJS.ProcessEnv;
const CLIENT = { dl: "0.17.0", autopilot: "3.10.1", os: "linux", arch: "arm64" };

type Call = { url: string; method: string; headers: Record<string, string>; body?: unknown };

/** A stub service: answers by path, records every request exactly as sent. */
function stubFetch(o: { replyAddress?: { status: number; body: unknown }; post?: { status: number; body: unknown; headers?: Record<string, string> } | "network" } = {}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = { ...(init.headers as Record<string, string>) };
    calls.push({ url, method: init.method ?? "GET", headers, ...(init.body ? { body: JSON.parse(String(init.body)) } : {}) });
    const json = (status: number, body: unknown, extra: Record<string, string> = {}) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json", ...extra } });
    if (url === `${ORIGIN}/v1/feedback/reply-address`) {
      const r = o.replyAddress ?? { status: 200, body: { email: null } };
      return json(r.status, r.body);
    }
    if (url === `${ORIGIN}/v1/feedback`) {
      if (o.post === "network") throw new TypeError("fetch failed");
      const r = o.post ?? { status: 200, body: { ok: true, replyTo: null } };
      return json(r.status, r.body, r.headers);
    }
    return json(404, { error: { code: "not_found" } });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** Deps with scripted answers; records what each prompt was shown. */
function deps(o: {
  fetchImpl: typeof fetch;
  token?: string;
  provider?: string;
  messages?: (string | null)[];
  emails?: (string | null)[];
}) {
  const shown = { message: [] as { problem?: string; draft?: string }[], email: [] as { suggested: string | null; problem?: string }[], status: [] as string[] };
  const messages = [...(o.messages ?? [])];
  const emails = [...(o.emails ?? [])];
  const d: FeedbackDeps = {
    askMessage: async (x) => (shown.message.push(x), messages.length ? messages.shift()! : null),
    askEmail: async (x) => (shown.email.push(x), emails.length ? emails.shift()! : null),
    token: async () => o.token,
    providerId: o.provider ?? (o.token ? "directionally-local" : "openrouter"),
    autopilotVersion: "3.10.1",
    status: (t) => void shown.status.push(t),
    fetchImpl: o.fetchImpl,
    env: ENV,
    platform: "linux",
    arch: "arm64",
  };
  return { d, shown };
}

const posts = (calls: Call[]) => calls.filter((c) => c.method === "POST");

describe("/feedback flow", () => {
  it("signed in with a public email: suggests it, Enter keeps it, and the POST carries the token", async () => {
    const { fetchImpl, calls } = stubFetch({
      replyAddress: { status: 200, body: { email: "ana@example.com" } },
      post: { status: 200, body: { ok: true, replyTo: "ana@example.com" } },
    });
    // The input is prefilled with the suggestion, so Enter hands it back unchanged.
    const { d, shown } = deps({ fetchImpl, token: "tok-1", messages: ["The diff view is great.\nBut /model is slow."], emails: ["ana@example.com"] });
    const line = await runFeedback({}, d);
    assert.deepStrictEqual(line, { text: "✓ Sent. Thanks — replies go to ana@example.com.", severity: "info" });
    assert.deepStrictEqual(shown.email, [{ suggested: "ana@example.com" }]);
    assert.strictEqual(calls[0]!.url, `${ORIGIN}/v1/feedback/reply-address`);
    assert.strictEqual(calls[0]!.headers.Authorization, "Bearer tok-1");
    const [post] = posts(calls);
    assert.strictEqual(post!.headers.Authorization, "Bearer tok-1");
    assert.deepStrictEqual(post!.body, {
      message: "The diff view is great.\nBut /model is slow.",
      email: "ana@example.com",
      client: { ...CLIENT, provider: "free" },
    });
  });

  it("signed in with a public email: typing another address sends that one instead", async () => {
    const { fetchImpl, calls } = stubFetch({ replyAddress: { status: 200, body: { email: "ana@example.com" } }, post: { status: 200, body: { ok: true, replyTo: "work@example.org" } } });
    const { d } = deps({ fetchImpl, token: "tok-1", messages: ["hi"], emails: ["work@example.org"] });
    const line = await runFeedback({}, d);
    assert.strictEqual(line.text, "✓ Sent. Thanks — replies go to work@example.org.");
    assert.strictEqual((posts(calls)[0]!.body as { email: string }).email, "work@example.org");
  });

  it("signed in without a public email: asks for an optional one; Enter skips and nothing is promised", async () => {
    const { fetchImpl, calls } = stubFetch({ replyAddress: { status: 200, body: { email: null } }, post: { status: 200, body: { ok: true, replyTo: null } } });
    const { d, shown } = deps({ fetchImpl, token: "tok-2", messages: ["love it"], emails: [""] });
    const line = await runFeedback({}, d);
    assert.deepStrictEqual(line, { text: "✓ Sent. Thanks — (no reply address, so we can't answer by email)", severity: "info" });
    assert.deepStrictEqual(shown.email, [{ suggested: null }]);
    const [post] = posts(calls);
    assert.strictEqual(post!.headers.Authorization, "Bearer tok-2");
    assert.deepStrictEqual(post!.body, { message: "love it", client: { ...CLIENT, provider: "free" } });
  });

  it("own key, not signed in: no reply-address lookup and an anonymous POST", async () => {
    const { fetchImpl, calls } = stubFetch({ post: { status: 200, body: { ok: true, replyTo: "me@example.net" } } });
    const { d, shown } = deps({ fetchImpl, messages: ["works with my own key"], emails: ["me@example.net"] });
    const line = await runFeedback({}, d);
    assert.strictEqual(line.text, "✓ Sent. Thanks — replies go to me@example.net.");
    assert.deepStrictEqual(shown.email, [{ suggested: null }]);
    assert.deepStrictEqual(calls.map((c) => `${c.method} ${c.url}`), [`POST ${ORIGIN}/v1/feedback`]);
    const [post] = posts(calls);
    assert.strictEqual(post!.headers.Authorization, undefined);
    assert.deepStrictEqual(post!.body, { message: "works with my own key", email: "me@example.net", client: { ...CLIENT, provider: "own-key" } });
  });

  it("text typed after the command skips the message input", async () => {
    const { fetchImpl, calls } = stubFetch();
    const { d, shown } = deps({ fetchImpl, emails: [""] });
    await runFeedback({ inline: "  please add vim keys  " }, d);
    assert.strictEqual(shown.message.length, 0);
    assert.strictEqual((posts(calls)[0]!.body as { message: string }).message, "please add vim keys");
  });

  it("429: says how long to wait, in minutes", async () => {
    const { fetchImpl } = stubFetch({ post: { status: 429, body: { error: { code: "rate_limited", retryAfter: 600 } } } });
    const { d } = deps({ fetchImpl, messages: ["again"], emails: [""] });
    assert.deepStrictEqual(await runFeedback({}, d), { text: "You've sent a lot of feedback recently; try again in 10 minutes.", severity: "error" });
    const one = stubFetch({ post: { status: 429, body: { error: { code: "rate_limited", retryAfter: 30 } } } });
    assert.strictEqual((await runFeedback({ inline: "x" }, deps({ fetchImpl: one.fetchImpl, emails: [""] }).d)).text, "You've sent a lot of feedback recently; try again in 1 minute.");
  });

  it("network error (and a 5xx): falls back to the email address and the issues page", async () => {
    for (const post of ["network", { status: 502, body: { error: "bad gateway" } }] as const) {
      const { fetchImpl } = stubFetch({ post });
      const { d } = deps({ fetchImpl, messages: ["hello"], emails: [""] });
      assert.deepStrictEqual(await runFeedback({}, d), { text: FEEDBACK_FALLBACK_LINE, severity: "error" });
    }
    assert.strictEqual(FEEDBACK_FALLBACK_LINE, "Couldn't send. Email contact@directionallylocal.com or open https://github.com/directionally-local/autopilot/issues/new");
  });

  it("a failed reply-address lookup still lets the person send (and type an address)", async () => {
    const { fetchImpl, calls } = stubFetch({ replyAddress: { status: 500, body: {} } });
    const { d, shown } = deps({ fetchImpl, token: "tok", messages: ["hi"], emails: [""] });
    assert.match((await runFeedback({}, d)).text, /^✓ Sent/);
    assert.deepStrictEqual(shown.email, [{ suggested: null }]);
    assert.strictEqual(posts(calls).length, 1);
  });

  it("a rejected token: the message still goes out, anonymously", async () => {
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init: RequestInit = {}) => {
      const headers = init.headers as Record<string, string>;
      calls.push({ url, method: init.method ?? "GET", headers });
      if (init.method === "POST" && headers.Authorization) return new Response(JSON.stringify({ error: { code: "invalid_token" } }), { status: 401 });
      if (init.method === "POST") return new Response(JSON.stringify({ ok: true, replyTo: null }), { status: 200 });
      return new Response(JSON.stringify({ email: null }), { status: 200 });
    }) as typeof fetch;
    const { d } = deps({ fetchImpl, token: "stale", messages: ["hi"], emails: [""] });
    assert.match((await runFeedback({}, d)).text, /^✓ Sent/);
    assert.deepStrictEqual(posts(calls).map((c) => c.headers.Authorization), ["Bearer stale", undefined]);
  });

  it("Esc at either input sends nothing", async () => {
    for (const [messages, emails] of [[[null], []], [["hi"], [null]]] as const) {
      const { fetchImpl, calls } = stubFetch();
      const { d } = deps({ fetchImpl, messages: [...messages], emails: [...emails] });
      assert.deepStrictEqual(await runFeedback({}, d), { text: FEEDBACK_NOT_SENT_LINE, severity: "info" });
      assert.strictEqual(posts(calls).length, 0);
    }
  });

  it("an empty message sends nothing; one over the limit is asked again with the draft kept", async () => {
    const empty = stubFetch();
    assert.strictEqual((await runFeedback({}, deps({ fetchImpl: empty.fetchImpl, messages: ["   "] }).d)).text, FEEDBACK_NOT_SENT_LINE);
    assert.strictEqual(empty.calls.length, 0);

    const long = "x".repeat(FEEDBACK_MAX_CHARS + 1);
    const { fetchImpl, calls } = stubFetch();
    const { d, shown } = deps({ fetchImpl, messages: [long, "short now"], emails: [""] });
    await runFeedback({}, d);
    assert.match(shown.message[1]!.problem!, /5001 characters; shorten it to 5000/);
    assert.strictEqual(shown.message[1]!.draft, long);
    assert.strictEqual((posts(calls)[0]!.body as { message: string }).message, "short now");

    const inline = stubFetch();
    assert.match((await runFeedback({ inline: long }, deps({ fetchImpl: inline.fetchImpl }).d)).text, /fits in 5000/);
    assert.strictEqual(inline.calls.length, 0);
  });

  it("a mistyped reply address is asked again", async () => {
    const { fetchImpl, calls } = stubFetch();
    const { d, shown } = deps({ fetchImpl, messages: ["hi"], emails: ["ana at example", "ana@example.com"] });
    await runFeedback({}, d);
    assert.match(shown.email[1]!.problem!, /doesn't look like an email address/);
    assert.strictEqual((posts(calls)[0]!.body as { email: string }).email, "ana@example.com");
  });

  it("sends only the typed message, the reply address and the client fields", async () => {
    const { fetchImpl, calls } = stubFetch({ replyAddress: { status: 200, body: { email: "ana@example.com" } } });
    const { d } = deps({ fetchImpl, token: "t", messages: ["only this"], emails: ["ana@example.com"] });
    await runFeedback({}, d);
    const [post] = posts(calls);
    assert.deepStrictEqual(Object.keys(post!.body as object).sort(), ["client", "email", "message"]);
    assert.deepStrictEqual(Object.keys((post!.body as { client: object }).client).sort(), ["arch", "autopilot", "dl", "os", "provider"]);
    assert.deepStrictEqual(Object.keys(post!.headers).sort(), ["Accept", "Authorization", "Content-Type"]);
  });
});

describe("feedbackClient", () => {
  it("reads dl's version from DL_VERSION and leaves it out when dl didn't start Autopilot", () => {
    assert.deepStrictEqual(feedbackClient({ providerId: "directionally-local", autopilotVersion: "3.10.1", env: { DL_VERSION: "0.17.0" }, platform: "darwin", arch: "arm64" }), {
      dl: "0.17.0",
      autopilot: "3.10.1",
      os: "darwin",
      arch: "arm64",
      provider: "free",
    });
    const standalone = feedbackClient({ providerId: "anthropic", autopilotVersion: "3.10.1", env: {} });
    assert.strictEqual("dl" in standalone, false);
    assert.strictEqual(standalone.provider, "own-key");
    assert.strictEqual(standalone.os, process.platform);
    assert.strictEqual(standalone.arch, process.arch);
  });
});

describe("/feedback command", () => {
  const ctxWith = (cfg: Record<string, unknown> | null) => {
    const opened: unknown[] = [];
    const ctx = { cfg, busy: false, mkKey: () => "k", setEvents: () => {}, openFeedback: (o: unknown) => void opened.push(o) } as unknown as SlashContext;
    return { ctx, opened };
  };

  it("opens the flow with the active provider and the text typed after it, as typed", async () => {
    const free = ctxWith({ provider: "directionally-local", model: "deepseek/deepseek-v4.1-flash-1017" });
    assert.strictEqual(await dispatchSlashCommand(free.ctx, "/feedback"), true);
    assert.deepStrictEqual(free.opened, [{ providerId: "directionally-local" }]);
    const own = ctxWith({ provider: "openrouter", model: "vendor/model", openrouterApiKey: "sk-or" });
    await dispatchSlashCommand(own.ctx, "/feedback The Diff view is Great");
    assert.deepStrictEqual(own.opened, [{ providerId: "openrouter", inline: "The Diff view is Great" }]);
  });

  it("is in the slash picker and /help", () => {
    assert.ok(BUILTIN_COMMANDS.some((c) => c.name === "feedback"));
    assert.ok([...CATEGORIES.flatMap((c) => c.commands), ...SINGLE_COMMANDS].some((x) => x.command === "/feedback"));
  });
});
