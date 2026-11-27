/**
 * "Sign in with OpenRouter": OpenRouter's OAuth PKCE flow, which mints a
 * user-owned API key after the user approves in the browser — no key to
 * create or copy by hand. https://openrouter.ai/docs/guides/overview/auth/oauth
 *
 * Two modes:
 *   - loopback (default): we listen on 127.0.0.1:<random port>, send the user
 *     to openrouter.ai/auth with that as the callback, and receive the code
 *     when their browser is redirected back.
 *   - headless (SSH sessions, containers, remote boxes): the browser can't
 *     reach our local port, so the callback is omitted — OpenRouter shows the
 *     code on screen and the user pastes it. PKCE makes a leaked code useless
 *     without our verifier (codes are also single-use, 10-minute lifetime).
 * Either way the code is exchanged at POST /api/v1/auth/keys for the key.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import { hostname } from "node:os";
import { gatedFetchWithNetworkRetry, openRouterUrl } from "./openrouter.js";
import type { HostResolver, PrivateHttpWarningTracker } from "../providers/resolve.js";

export interface Pkce {
  verifier: string;
  challenge: string;
}

/** RFC 7636 S256: verifier = 43-char base64url random; challenge = base64url(sha256(verifier)). */
export function createPkce(): Pkce {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: pkceChallenge(verifier) };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

/** Where users approve access. OPENROUTER_AUTH_URL overrides it (tests, mocks). */
export function openRouterAuthPageUrl(): string {
  return (process.env.OPENROUTER_AUTH_URL?.trim() || "https://openrouter.ai/auth").replace(/\/+$/, "");
}

/** Label pre-filled for the minted key, so users can tell keys apart in their OpenRouter dashboard. */
export function defaultKeyLabel(): string {
  return `autopilot (${hostname()})`.slice(0, 60);
}

export function buildAuthUrl(opts: { challenge: string; callbackUrl?: string; keyLabel?: string }): string {
  const params = new URLSearchParams();
  if (opts.callbackUrl) params.set("callback_url", opts.callbackUrl);
  params.set("code_challenge", opts.challenge);
  params.set("code_challenge_method", "S256");
  params.set("key_label", opts.keyLabel ?? defaultKeyLabel());
  return `${openRouterAuthPageUrl()}?${params.toString()}`;
}

/** True where a browser redirect to our 127.0.0.1 port can't work: SSH sessions and display-less Linux. */
export function isHeadlessEnvironment(env: NodeJS.ProcessEnv = process.env, os: string = process.platform): boolean {
  if (env.SSH_CONNECTION || env.SSH_TTY || env.SSH_CLIENT) return true;
  if (os === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

export class OpenRouterSignInError extends Error {}

/** Exchange an authorization code for the user's API key. */
export async function exchangeCode(
  code: string,
  verifier: string,
  fetchImpl?: typeof fetch,
  resolver?: HostResolver,
  warnings?: PrivateHttpWarningTracker,
): Promise<string> {
  const res = await gatedFetchWithNetworkRetry(
    fetchImpl,
    openRouterUrl("auth/keys"),
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: code.trim(), code_verifier: verifier, code_challenge_method: "S256" }),
    },
    { hasKey: true, ...(resolver ? { resolver } : {}), ...(warnings ? { warnings } : {}) },
  );
  let body: { key?: unknown; error?: { message?: string } } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* non-JSON error page */
  }
  if (!res.ok || typeof body.key !== "string") {
    const why = body.error?.message ?? `HTTP ${res.status}`;
    throw new OpenRouterSignInError(
      res.status === 400 || res.status === 403
        ? `OpenRouter didn't accept the sign-in code (${why}). Codes are single-use and expire after 10 minutes — try again.`
        : `Couldn't finish signing in with OpenRouter (${why}).`,
    );
  }
  return body.key;
}

const DONE_PAGE = (ok: boolean, message: string) => `<!doctype html><html><head><meta charset="utf-8"><title>autopilot</title>
<style>body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#222;background:#fafafa}
@media(prefers-color-scheme:dark){body{color:#eee;background:#161616}}main{max-width:28rem;text-align:center;padding:1rem}</style></head>
<body><main><h1>${ok ? "✓ Signed in" : "Sign-in failed"}</h1><p>${message}</p></main></body></html>`;

export interface LoopbackListener {
  /** The callback URL to send to OpenRouter (http://127.0.0.1:<port>/callback). */
  callbackUrl: string;
  /** Resolves with the authorization code when the browser is redirected back. */
  code: Promise<string>;
  close(): void;
}

/**
 * Listen on 127.0.0.1 (random free port) for OpenRouter's redirect. The first
 * request to /callback carrying a `code` resolves; the server then closes.
 * Rejects on `timeoutMs` (default 10 min, matching the code lifetime) or abort.
 */
export async function startLoopbackListener(opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<LoopbackListener> {
  let resolveCode!: (c: string) => void;
  let rejectCode!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => {
    resolveCode = res;
    rejectCode = rej;
  });
  code.catch(() => undefined); // callers may never await it (e.g. switched to paste mode)

  let settled = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/callback") {
      res.writeHead(404).end();
      return;
    }
    const got = url.searchParams.get("code");
    if (!got || settled) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" });
      res.end(DONE_PAGE(false, "No authorization code in this request. Go back to your terminal and try again."));
      return;
    }
    settled = true;
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" });
    res.end(DONE_PAGE(true, "You can close this tab and return to your terminal."));
    resolveCode(got);
    finish();
  });

  const timer = setTimeout(() => fail(new OpenRouterSignInError("Timed out waiting for the browser sign-in.")), opts.timeoutMs ?? 10 * 60_000);
  timer.unref();
  const onAbort = () => fail(new OpenRouterSignInError("Sign-in cancelled."));
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  function finish() {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onAbort);
    server.close();
    server.closeAllConnections?.();
  }
  function fail(e: Error) {
    if (settled) return;
    settled = true;
    rejectCode(e);
    finish();
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    callbackUrl: `http://127.0.0.1:${port}/callback`,
    code,
    close: () => fail(new OpenRouterSignInError("Sign-in cancelled.")),
  };
}
