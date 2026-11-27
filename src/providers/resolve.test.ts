import { describe, it, mock } from "node:test";
import assert from "node:assert";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { classifyHttpHost, clearDispatcherCache, detectEnvProviders, dispatcherCacheSize, gatedFetch, HttpResolutionError, isProviderUsable, PrivateHttpWarningTracker, providerDestinationLabel, resolveActiveProvider, resolveHttpHostGate, resolveProviderId } from "./resolve.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { PROVIDER_IDS, PROVIDER_PRESETS } from "./presets.js";
import { logger } from "../util/logger.js";

describe("AUTOPILOT_* env names (#911)", () => {
  it("AUTOPILOT_BASE_URL + AUTOPILOT_API_KEY select the custom endpoint, winning over the KIMIFLARE_* names", () => {
    assert.strictEqual(resolveProviderId({ provider: "openai" }, { AUTOPILOT_BASE_URL: "https://new/v1" }), "custom");
    const p = resolveActiveProvider(null, {
      AUTOPILOT_BASE_URL: "https://new/v1",
      KIMIFLARE_BASE_URL: "https://old/v1",
      AUTOPILOT_API_KEY: "new-key",
      KIMIFLARE_API_KEY: "old-key",
    });
    assert.strictEqual(p.id, "custom");
    assert.strictEqual(p.baseUrl, "https://new/v1");
    assert.strictEqual(p.apiKey, "new-key");
  });

  it("still honours the KIMIFLARE_* names alone", () => {
    const p = resolveActiveProvider(null, { KIMIFLARE_BASE_URL: "https://old/v1", KIMIFLARE_API_KEY: "old-key" });
    assert.strictEqual(p.baseUrl, "https://old/v1");
    assert.strictEqual(p.apiKey, "old-key");
  });

  it("AUTOPILOT_OPENROUTER_KEY is an OpenRouter key", () => {
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_OPENROUTER_KEY: "sk-or-new" }).apiKey, "sk-or-new");
  });
});

describe("resolveProviderId", () => {
  it("keeps the pre-provider precedence for old configs: custom, then OpenRouter, then Requesty", () => {
    assert.strictEqual(resolveProviderId({ baseUrl: "https://gw/v1", openrouterApiKey: "k" }, {}), "custom");
    assert.strictEqual(resolveProviderId({ openrouterApiKey: "k", requestyApiKey: "r" }, {}), "openrouter");
    assert.strictEqual(resolveProviderId({ requestyApiKey: "r" }, {}), "requesty");
    assert.strictEqual(resolveProviderId({}, {}), "openrouter");
  });

  it("lets an explicit provider win over leftover credentials", () => {
    assert.strictEqual(resolveProviderId({ provider: "openai", openrouterApiKey: "k", baseUrl: "https://gw/v1" }, {}), "openai");
  });

  it("lets a host app's KIMIFLARE_BASE_URL win over the config file, and AUTOPILOT_PROVIDER over both", () => {
    assert.strictEqual(resolveProviderId({ provider: "openai" }, { KIMIFLARE_BASE_URL: "https://host/v1" }), "custom");
    assert.strictEqual(resolveProviderId({ provider: "openai" }, { KIMIFLARE_BASE_URL: "https://host/v1", AUTOPILOT_PROVIDER: "deepseek" }), "deepseek");
  });

  it("ignores unknown provider names", () => {
    assert.strictEqual(resolveProviderId({ provider: "nope" as never, openrouterApiKey: "k" }, { AUTOPILOT_PROVIDER: "also-nope" }), "openrouter");
  });
});

describe("resolveActiveProvider", () => {
  it("reads a preset's key from its env var before the config file", () => {
    const p = resolveActiveProvider({ provider: "openai", providers: { openai: { apiKey: "file" } } }, { OPENAI_API_KEY: "env" });
    assert.strictEqual(p.apiKey, "env");
    assert.strictEqual(p.baseUrl, "https://api.openai.com/v1");
  });

  it("honours a loopback base URL override (e.g. Ollama on this machine)", () => {
    const p = resolveActiveProvider({ provider: "ollama", providers: { ollama: { baseUrl: "http://localhost:11434/v1" } } }, {});
    assert.strictEqual(p.baseUrl, "http://localhost:11434/v1");
    assert.ok(isProviderUsable(p), "Ollama needs no key");
  });

  it("accepts a dotless LAN host for Ollama", () => {
    const p = resolveActiveProvider({ provider: "ollama", providers: { ollama: { baseUrl: "http://gpu-box:11434/v1" } } }, {});
    assert.strictEqual(p.baseUrl, "http://gpu-box:11434/v1");
    assert.strictEqual(p.baseUrlRefusal, undefined);
  });

  it("routes a preset through AUTOPILOT_BASE_URL when AUTOPILOT_PROVIDER names it (a gateway in front of the provider)", () => {
    const env = { AUTOPILOT_PROVIDER: "deepseek", AUTOPILOT_BASE_URL: "https://gw:4752/deepseek", DEEPSEEK_API_KEY: "egress-token" };
    const p = resolveActiveProvider({ provider: "openai", providers: { deepseek: { baseUrl: "https://api.deepseek.com" } } }, env);
    assert.strictEqual(p.id, "deepseek");
    assert.strictEqual(p.baseUrl, "https://gw:4752/deepseek", "the env URL wins over config and the preset");
    assert.strictEqual(p.apiKey, "egress-token");
    assert.ok(isProviderUsable(p));
    // The legacy spelling works too; a keyless preset needs no key behind the gateway.
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "ollama", KIMIFLARE_BASE_URL: "https://gw:4752/ollama/v1" }).baseUrl, "https://gw:4752/ollama/v1");
    assert.ok(isProviderUsable(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "ollama", AUTOPILOT_BASE_URL: "https://gw:4752/ollama/v1" })));
    // Without AUTOPILOT_PROVIDER the URL still means a custom endpoint, and without the URL the preset's own base holds.
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "https://gw:4752/deepseek" }).id, "custom");
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_PROVIDER: "deepseek" }).baseUrl, "https://api.deepseek.com");
  });

  it("is unusable when a provider that needs a key has none", () => {
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "deepseek" }, {})), false);
    assert.strictEqual(isProviderUsable(resolveActiveProvider({ provider: "custom" }, {})), false);
  });
});

describe("base URL scheme guard (T3-F2 re-scope)", () => {
  it("accepts https and loopback http", () => {
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "https://api.example.com/v1", AUTOPILOT_API_KEY: "k" }).baseUrl, "https://api.example.com/v1");
    for (const url of ["http://localhost:11434/v1", "http://127.0.0.1:11434/v1", "http://[::1]:11434/v1"]) {
      assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: url, AUTOPILOT_API_KEY: "k" }).baseUrl, url);
    }
  });

  it("marks public http literals for request-time refusal without throwing from resolution", () => {
    const p = resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "http://203.0.113.9/v1", AUTOPILOT_API_KEY: "k" });
    assert.strictEqual(p.baseUrl, "http://203.0.113.9/v1");
    assert.strictEqual(p.baseUrlRefusal, "base URL must use https (got http://203.0.113.9) — use https or an ssh tunnel to 127.0.0.1");
    assert.strictEqual(providerDestinationLabel(p), "203.0.113.9");
  });

  it("defers a non-literal http host to the request-time resolution gate", () => {
    // A name is not refused by shape: it is resolved at request time.
    const p = resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "http://example.com/v1", AUTOPILOT_API_KEY: "k" });
    assert.strictEqual(p.baseUrl, "http://example.com/v1");
    assert.strictEqual(p.baseUrlRefusal, undefined);
  });

  it("does not allowlist hosts: any https host is accepted", () => {
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "https://any-host.example/v1", AUTOPILOT_API_KEY: "k" }).baseUrl, "https://any-host.example/v1");
  });

  it("does not treat a 127.* DNS name as loopback (T1-01)", async () => {
    for (const url of ["http://127.0.0.1.evil.com/v1", "http://127.1.evil.com/v1"]) {
      // A name that looks like an address is not one: resolution decides.
      const gate = await resolveHttpHostGate(url, { hasKey: true, resolver: async () => [{ address: "203.0.113.9", family: 4 }] });
      assert.match(gate.refusal ?? "", /base URL must use https/, url);
    }
  });

  it("labels the destination host, or nothing when the module owns the URL", () => {
    assert.strictEqual(providerDestinationLabel(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "https://api.example.com/v1", AUTOPILOT_API_KEY: "k" })), "api.example.com");
    assert.strictEqual(providerDestinationLabel(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "http://localhost:11434/v1", AUTOPILOT_API_KEY: "k" })), "localhost");
    assert.strictEqual(providerDestinationLabel(resolveActiveProvider(null, { AUTOPILOT_OPENROUTER_KEY: "sk-or" })), "", "never the <preset> placeholder");
  });
});

describe("base URL scheme guard (private ranges and key-travel warning)", () => {
  const resolve = (url: string, key = "k") => resolveActiveProvider(null, { AUTOPILOT_BASE_URL: url, AUTOPILOT_API_KEY: key });

  it("classifies hosts without treating lookalike DNS names as addresses", async () => {
    assert.strictEqual(await classifyHttpHost("127.0.0.1"), "loopback");
    assert.strictEqual(await classifyHttpHost("192.168.1.5"), "private");
    // A name is not trusted by shape: it is resolved before it is classified.
    const publicResolver = async () => [{ address: "203.0.113.9", family: 4 }];
    assert.strictEqual(await classifyHttpHost("127.0.0.1.evil.com", publicResolver), "public");
    assert.strictEqual(await classifyHttpHost("notlocal.example", publicResolver), "public");
    assert.strictEqual(await classifyHttpHost("example.com", publicResolver), "public");
  });

  it("accepts http to each private range", () => {
    for (const url of ["http://192.168.1.5/v1", "http://10.0.0.7/v1", "http://172.16.0.9/v1", "http://100.64.1.2/v1"]) {
      assert.strictEqual(resolve(url).baseUrl, url, url);
      assert.strictEqual(resolve(url).baseUrlRefusal, undefined, url);
    }
  });

  it("accepts exactly within the CIDR ranges and refuses the edges", () => {
    const accepted = ["http://172.16.255.255/v1", "http://172.31.255.255/v1", "http://100.64.0.0/v1", "http://100.127.255.255/v1", "http://192.168.255.255/v1", "http://10.255.255.255/v1"];
    for (const url of accepted) assert.strictEqual(resolve(url).baseUrl, url, url);
    const refused = ["http://172.15.0.1/v1", "http://172.32.0.1/v1", "http://100.128.0.1/v1", "http://192.169.0.1/v1", "http://11.0.0.1/v1"];
    for (const url of refused) assert.match(resolve(url).baseUrlRefusal ?? "", /base URL must use https/, url);
    for (const url of accepted) assert.strictEqual(resolve(url).baseUrlRefusal, undefined, url);
  });

  it("accepts .local names, case-insensitively", () => {
    for (const url of ["http://ollama-box.local:11434/v1", "http://NAS.LOCAL/v1"]) {
      assert.strictEqual(resolve(url).baseUrl, url, url);
    }
  });

  it("accepts IPv6 ULA and link-local, stripping brackets and respecting boundaries", async () => {
    for (const host of ["fc00::1", "fd00::1", "fdff:ffff::1", "fe80::1", "febf:ffff::1"]) {
      const url = `http://[${host}]:11434/v1`;
      assert.strictEqual(await classifyHttpHost(`[${host}]`), "private", host);
      assert.strictEqual(resolve(url).baseUrlRefusal, undefined, host);
    }
    for (const host of ["fbff::1", "fe00::1", "fe7f::1", "fec0::1", "2001:db8::1"]) {
      assert.strictEqual(await classifyHttpHost(host), "public", host);
      assert.match(resolve(`http://[${host}]/v1`).baseUrlRefusal ?? "", /base URL must use https/, host);
    }
  });

  it("accepts dotless names only through the resolution gate, with a once-per-host key warning", async () => {
    const warnings: string[] = [];
    const tracker = new PrivateHttpWarningTracker((message) => warnings.push(message));
    const resolver = async () => [{ address: "192.168.1.9", family: 4 }];
    assert.strictEqual((await resolveHttpHostGate("http://gpu-box:11434/v1", { hasKey: false, warnings: tracker, resolver })).refusal, undefined);
    assert.strictEqual(warnings.length, 0);
    assert.strictEqual((await resolveHttpHostGate("http://gpu-box:11434/v1", { hasKey: true, warnings: tracker, resolver })).refusal, undefined);
    await resolveHttpHostGate("http://GPU-BOX:11434/v1", { hasKey: true, warnings: tracker, resolver });
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0]!, /gpu-box/);
    const refused = await resolveHttpHostGate("http://gpu-box.example.com/v1", { hasKey: true, warnings: tracker, resolver: async () => [{ address: "203.0.113.9", family: 4 }] });
    assert.match(refused.refusal ?? "", /base URL must use https/);
  });

  it("warns once per host on the user-visible channel when a key travels, and stays silent without one", async () => {
    const warnings: string[] = [];
    const tracker = new PrivateHttpWarningTracker((m) => warnings.push(m));
    const spy = mock.method(logger, "warn");
    try {
      await resolveHttpHostGate("http://192.168.1.5/v1", { hasKey: true, warnings: tracker });
      await resolveHttpHostGate("http://192.168.1.5/v1", { hasKey: true, warnings: tracker });
      assert.strictEqual(warnings.length, 1, "warned once for the host");
      assert.match(warnings[0]!, /192\.168\.1\.5/);
      assert.strictEqual(spy.mock.calls.filter((c) => c.arguments[0] === "provider:http_key_travel").length, 1, "the logger record is secondary");
      warnings.length = 0;
      spy.mock.resetCalls();
      await resolveHttpHostGate("http://10.0.0.7/v1", { hasKey: false, warnings: tracker });
      assert.strictEqual(warnings.length, 0, "keyless stays silent");
      assert.strictEqual(spy.mock.calls.filter((c) => c.arguments[0] === "provider:http_key_travel").length, 0);
    } finally {
      spy.mock.restore();
    }
  });

  it("keeps warnings pending without a visible channel, including when a channel throws", () => {
    const tracker = new PrivateHttpWarningTracker();
    const warnings: string[] = [];
    tracker.warn("192.168.1.5", "msg");
    tracker.warn("192.168.1.5", "msg");
    tracker.setHandler(() => { throw new Error("channel unavailable"); });
    assert.throws(() => tracker.warn("192.168.1.5", "msg"), /channel unavailable/);
    tracker.setHandler((message) => warnings.push(message));
    tracker.warn("192.168.1.5", "msg");
    tracker.warn("192.168.1.5", "msg");
    assert.strictEqual(warnings.length, 1);
  });

  it("accounts per session: a second session warns again for the same host", async () => {
    const first: string[] = [];
    const second: string[] = [];
    const a = new PrivateHttpWarningTracker((m) => first.push(m));
    const b = new PrivateHttpWarningTracker((m) => second.push(m));
    await resolveHttpHostGate("http://192.168.1.5/v1", { hasKey: true, warnings: a });
    await resolveHttpHostGate("http://192.168.1.5/v1", { hasKey: true, warnings: a });
    await resolveHttpHostGate("http://192.168.1.5/v1", { hasKey: true, warnings: b });
    assert.strictEqual(first.length, 1, "once within the first session");
    assert.strictEqual(second.length, 1, "the second session warns again");
  });

  it("labels a private host", () => {
    assert.strictEqual(providerDestinationLabel(resolve("http://192.168.1.5/v1")), "192.168.1.5");
  });
});

describe("resolution gate (resolve-then-check, pin)", () => {
  const privateResolver = async () => [{ address: "192.168.1.9", family: 4 }];
  const publicResolver = async () => [{ address: "203.0.113.9", family: 4 }];

  it("accepts a name that resolves only to private addresses, and warns once when a key travels", async () => {
    const warnings: string[] = [];
    const tracker = new PrivateHttpWarningTracker((m) => warnings.push(m));
    for (const url of ["http://model:8000", "http://gpu-box:11434/v1"]) {
      const gate = await resolveHttpHostGate(url, { hasKey: true, warnings: tracker, resolver: privateResolver });
      assert.strictEqual(gate.refusal, undefined, url);
      assert.ok(gate.pin, `${url} is pinned to the checked address`);
    }
    assert.strictEqual(warnings.length, 2, "one warning per host");
    assert.match(warnings[0]!, /model/);
    assert.match(warnings[1]!, /gpu-box/);
  });

  it("accepts .local names through the gate, case-insensitively", async () => {
    const resolver = async () => [{ address: "192.168.1.20", family: 4 }];
    for (const url of ["http://ollama-box.local:11434/v1", "http://NAS.LOCAL/v1"]) {
      const gate = await resolveHttpHostGate(url, { hasKey: true, resolver });
      assert.strictEqual(gate.refusal, undefined, url);
      assert.strictEqual(gate.pin?.addresses[0], "192.168.1.20", url);
    }
  });

  it("resolved-private: a single-label name resolving to a private address is allowed", async () => {
    const resolver = async () => [{ address: "192.168.1.9", family: 4 }];
    assert.strictEqual(await classifyHttpHost("gpu-box", resolver), "private");
    const gate = await resolveHttpHostGate("http://gpu-box:11434/v1", { hasKey: true, resolver });
    assert.strictEqual(gate.refusal, undefined);
    assert.deepStrictEqual(gate.pin, { hostname: "gpu-box", addresses: ["192.168.1.9"], port: "11434" });
  });

  it("resolved-public: a single-label name resolving to a public address is refused", async () => {
    const resolver = async () => [{ address: "203.0.113.9", family: 4 }];
    assert.strictEqual(await classifyHttpHost("gpu-box", resolver), "public");
    const gate = await resolveHttpHostGate("http://gpu-box:11434/v1", { hasKey: true, resolver });
    assert.match(gate.refusal ?? "", /base URL must use https \(got http:\/\/gpu-box:11434\)/);
    assert.strictEqual(gate.pin, undefined);
  });

  it("resolution-failure: NXDOMAIN and timeouts are a transient network error, never the https refusal", async () => {
    const nxdomain = async () => {
      throw Object.assign(new Error("getaddrinfo ENOTFOUND gpu-box"), { code: "ENOTFOUND" });
    };
    const timeout = async () => {
      throw Object.assign(new Error("queryA ETIMEOUT gpu-box"), { code: "ETIMEOUT" });
    };
    const empty = async () => [];
    for (const resolver of [nxdomain, timeout, empty]) {
      assert.strictEqual(await classifyHttpHost("gpu-box", resolver), "unresolved");
      const gate = await resolveHttpHostGate("http://gpu-box:11434/v1", { hasKey: true, resolver });
      assert.strictEqual(gate.refusal, undefined, "not the https refusal");
      assert.strictEqual(gate.unresolved?.host, "gpu-box");
      assert.match(gate.unresolved?.message ?? "", /could not resolve `gpu-box`/);
      assert.strictEqual(gate.pin, undefined);
    }
  });

  it("mixed-addresses: any public address in the set refuses", async () => {
    const mixed = async () => [{ address: "192.168.1.9", family: 4 }, { address: "203.0.113.9", family: 4 }];
    assert.strictEqual(await classifyHttpHost("gpu-box", mixed), "public");
    const gate = await resolveHttpHostGate("http://gpu-box:11434/v1", { hasKey: true, resolver: mixed });
    assert.match(gate.refusal ?? "", /base URL must use https/);
    assert.strictEqual(gate.pin, undefined);
  });

  it("keeps the hotcell sandbox URL working (the maintainer's blocker, his URL verbatim)", async () => {
    const url = "http://host.docker.internal:4752/deepseek";
    const gate = await resolveHttpHostGate(url, { hasKey: true, resolver: async () => [{ address: "172.17.0.2", family: 4 }] });
    assert.strictEqual(gate.refusal, undefined);
    assert.deepStrictEqual(gate.pin, { hostname: "host.docker.internal", addresses: ["172.17.0.2"], port: "4752" });
    // The first turn is not refused: request auth succeeds for the same URL.
    const auth = llmAuthFromConfig({ provider: "deepseek", providers: { deepseek: { baseUrl: url, apiKey: "egress-token" } } });
    assert.strictEqual(auth.customEndpoint?.baseUrl, url);
    assert.strictEqual(auth.customEndpoint?.apiKey, "egress-token");
  });

  it("covers tailscale magicdns: x.ts.net resolving to 100.64/10 is accepted, public is refused", async () => {
    const accepted = await resolveHttpHostGate("http://x.ts.net:8080/v1", { hasKey: true, resolver: async () => [{ address: "100.101.102.103", family: 4 }] });
    assert.strictEqual(accepted.refusal, undefined);
    assert.deepStrictEqual(accepted.pin?.addresses, ["100.101.102.103"]);
    const refused = await resolveHttpHostGate("http://x.ts.net:8080/v1", { hasKey: true, resolver: publicResolver });
    assert.match(refused.refusal ?? "", /base URL must use https/);
  });

  it("pins a name that resolves to an IPv6 ULA address, keeping the port", async () => {
    const gate = await resolveHttpHostGate("http://gpu-box:11434/v1", { resolver: async () => [{ address: "fd00::1", family: 6 }] });
    assert.strictEqual(gate.refusal, undefined, "a ULA address is private, so the gate accepts");
    assert.deepStrictEqual(gate.pin, { hostname: "gpu-box", addresses: ["fd00::1"], port: "11434" });
  });

  it("keeps every checked address so the client's v4/v6 fallback still works", async () => {
    const gate = await resolveHttpHostGate("http://gpu-box:11434/v1", {
      resolver: async () => [{ address: "192.168.1.9", family: 4 }, { address: "fd00::1", family: 6 }],
    });
    assert.strictEqual(gate.refusal, undefined);
    assert.deepStrictEqual(gate.pin?.addresses, ["192.168.1.9", "fd00::1"]);
  });

  it("treats 0.0.0.0 and :: as loopback (a common Ollama setting)", async () => {
    for (const url of ["http://0.0.0.0:11434/v1", "http://[::]:11434/v1"]) {
      const warnings: string[] = [];
      const tracker = new PrivateHttpWarningTracker((m) => warnings.push(m));
      const gate = await resolveHttpHostGate(url, { hasKey: true, warnings: tracker });
      assert.strictEqual(gate.refusal, undefined, url);
      assert.strictEqual(warnings.length, 0, `${url} is loopback: no warning`);
      assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: url, AUTOPILOT_API_KEY: "k" }).baseUrlRefusal, undefined, url);
    }
    assert.strictEqual(await classifyHttpHost("0.0.0.0"), "loopback");
    assert.strictEqual(await classifyHttpHost("::"), "loopback");
  });

  it("allows keyless public http with a warning, and still refuses it when a key would travel", async () => {
    const warnings: string[] = [];
    const tracker = new PrivateHttpWarningTracker((m) => warnings.push(m));
    const keyless = await resolveHttpHostGate("http://203.0.113.9/v1", { hasKey: false, warnings: tracker });
    assert.strictEqual(keyless.refusal, undefined, "keyless public http is allowed");
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0]!, /cleartext http/);
    const keyed = await resolveHttpHostGate("http://203.0.113.9/v1", { hasKey: true, warnings: tracker });
    assert.match(keyed.refusal ?? "", /base URL must use https/);
    // resolveActiveProvider agrees: no key → no refusal; a key → refusal.
    assert.strictEqual(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "http://203.0.113.9/v1" }).baseUrlRefusal, undefined);
    assert.match(resolveActiveProvider(null, { AUTOPILOT_BASE_URL: "http://203.0.113.9/v1", AUTOPILOT_API_KEY: "k" }).baseUrlRefusal ?? "", /base URL must use https/);
  });

  it("fails a non-resolving host as a transient network error, never an unpinned fetch", async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      return new Response("{}");
    }) as unknown as typeof fetch;
    await assert.rejects(
      () =>
        gatedFetch("http://proxy:8080/v1/models", {}, {
          hasKey: true,
          fetchImpl,
          resolver: async () => {
            throw Object.assign(new Error("getaddrinfo ENOTFOUND proxy"), { code: "ENOTFOUND" });
          },
        }),
      (e: unknown) => e instanceof HttpResolutionError && /could not resolve `proxy`/.test(e.message),
    );
    assert.strictEqual(called, false, "never falls through to an unpinned fetch");
  });

  it("refuses redirects on gated http requests, so the key cannot follow to a public origin", async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(302, { location: "http://203.0.113.9/steal" });
      res.end();
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      await assert.rejects(
        () => gatedFetch(`http://127.0.0.1:${port}/v1/models`, { headers: { "x-api-key": "secret" } }, { hasKey: true }),
        (e: unknown) => {
          const cause = (e as { cause?: { message?: string } }).cause;
          return /redirect/i.test(`${(e as Error).message} ${cause?.message ?? ""}`);
        },
      );
    } finally {
      server.close();
    }
  });

  it("pins the connection to a checked address with the URL and Host header intact (a name-routed LAN proxy)", async () => {
    const seen: Array<{ url?: string; host?: string; key?: string }> = [];
    const server = http.createServer((req, res) => {
      seen.push({ url: req.url, host: req.headers.host, key: req.headers["x-api-key"] as string });
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const port = (server.address() as AddressInfo).port;
    try {
      const res = await gatedFetch(
        `http://llm.home.lan:${port}/v1/chat/completions`,
        { method: "POST", headers: { "x-api-key": "secret", "content-type": "application/json" }, body: "{}" },
        { hasKey: true, resolver: async () => [{ address: "127.0.0.1", family: 4 }] },
      );
      assert.strictEqual(res.status, 200);
      assert.deepStrictEqual(seen, [{ url: "/v1/chat/completions", host: `llm.home.lan:${port}`, key: "secret" }]);
    } finally {
      server.close();
    }
  });
});

describe("presets", () => {
  it("are complete and self-consistent", () => {
    for (const id of PROVIDER_IDS) {
      const p = PROVIDER_PRESETS[id];
      assert.strictEqual(p.id, id);
      assert.ok(p.name);
      assert.ok(p.apiKeyEnv.length > 0, `${id} needs at least one key env var`);
      // Vertex and Bedrock build their URLs from project/location and region.
      if (!["openrouter", "requesty", "custom", "vertex", "bedrock"].includes(id)) assert.match(p.baseUrl ?? "", /^https?:\/\//, `${id} base URL`);
      // OpenRouter-only features stay off everywhere but OpenRouter.
      if (id !== "openrouter") assert.deepStrictEqual(p.capabilities, { costConfirmation: false, decisionsApi: false, hotcellGateway: false });
      // Defaults never borrow another provider's model ids.
      for (const m of [p.defaultModel, p.plumbingModel]) {
        if (m && id !== "openrouter") assert.ok(!m.startsWith("moonshotai/"), `${id} default ${m} looks like an OpenRouter id`);
      }
    }
  });
});

describe("detectEnvProviders", () => {
  it("lists providers whose key is in the environment", () => {
    assert.deepStrictEqual(detectEnvProviders({ OPENAI_API_KEY: "x", ZHIPU_API_KEY: "y" }), ["openai", "zai"]);
  });
});

describe("dispatcher cache", () => {
  it("reuses one dispatcher per host+address set and bounds the cache", async () => {
    clearDispatcherCache();
    const seen: unknown[] = [];
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      seen.push((init as { dispatcher?: unknown } | undefined)?.dispatcher);
      return new Response("ok");
    }) as unknown as typeof fetch;
    const resolver = async () => [{ address: "10.0.0.5", family: 4 }];
    await gatedFetch("http://gpu-box:8080/v1/models", {}, { hasKey: true, resolver, fetchImpl: fakeFetch });
    await gatedFetch("http://gpu-box:8080/v1/models", {}, { hasKey: true, resolver, fetchImpl: fakeFetch });
    assert.strictEqual(seen[0], seen[1], "same host+addresses reuses the dispatcher");
    for (let i = 0; i < 40; i++) {
      await gatedFetch(`http://host-${i}:8080/v1/models`, {}, {
        hasKey: true,
        resolver: async () => [{ address: `10.0.1.${i}`, family: 4 }],
        fetchImpl: fakeFetch,
      });
    }
    assert.ok(dispatcherCacheSize() <= 32, "the cache is bounded");
    clearDispatcherCache();
  });
});
