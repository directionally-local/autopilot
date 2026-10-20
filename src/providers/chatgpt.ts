/**
 * "Sign in with ChatGPT": use a ChatGPT Plus/Pro/Team subscription through
 * OpenAI's token-sharing sign-in. Mirrors opencode's
 * packages/core/src/plugin/provider/chatgpt.ts:
 *
 * - OAuth PKCE against auth.openai.com with a loopback callback. The first
 *   sign-in registers a user-owned client (`dynamic_agent_client`, agent
 *   name "Autopilot"); OpenAI returns the issued client id on the callback,
 *   and later sign-ins and refreshes reuse it
 * - the scope must include `chatgpt.tokens.use.direct`; tokens are for
 *   https://api.openai.com/v1 (the normal Responses API), refreshed with
 *   the refresh token before they expire
 * - requests carry the Codex client's session headers (session-id,
 *   thread-id, x-client-request-id), and large bodies are zstd-compressed
 *   (token sharing rejects uncompressed bodies over ~1 MiB)
 * - subscription errors (usage limit reached, account not eligible, …) are
 *   not retried
 *
 * Only this official token-sharing flow is supported — not the legacy
 * Codex backend (chatgpt.com/backend-api/codex).
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { configPath, patchPersistedConfig, type KimiConfig } from "../config.js";
import { getUserAgent } from "../util/version.js";
import type { ProviderSettings } from "./resolve.js";

export const CHATGPT_ISSUER = "https://auth.openai.com";
export const CHATGPT_TOKEN_URL = `${CHATGPT_ISSUER}/api/accounts/oauth/token`;
export const CHATGPT_RESOURCE = "https://api.openai.com/v1";
export const TOKEN_SHARING_SCOPE = "chatgpt.tokens.use.direct";
const REGISTRATION_CLIENT_ID = "dynamic_agent_client";

/** Models token sharing serves (as opencode lists them); "pro" reasoning modes are excluded. */
export const CHATGPT_MODELS = new Set([
  "gpt-5.5",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-6-astra",
  "gpt-6-luna",
  "gpt-6-sol",
  "gpt-6.1-sol",
]);

/** Error codes from token sharing that retrying can't fix. */
export const NON_RETRYABLE_SHARING_CODES = [
  "subscription_sharing_usage_limit_exceeded",
  "subscription_sharing_user_not_eligible",
  "subscription_sharing_unsupported_capability",
  "subscription_sharing_route_not_supported",
  "subscription_sharing_invalid_user",
  "chatpass_v2_scope_not_authorized",
  "chatpass_v2_invalid_authorization_context",
];

export interface ChatGPTTokens {
  access_token: string;
  refresh_token: string;
  id_token?: string;
  expires_in?: number;
  scope?: string;
}

export function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

export function authorizeUrl(opts: { redirect: string; challenge: string; state: string; nonce: string; clientId?: string; hostId: string }): string {
  return `${CHATGPT_ISSUER}/api/accounts/authorize?${new URLSearchParams({
    client_id: opts.clientId ?? REGISTRATION_CLIENT_ID,
    ...(opts.clientId ? {} : { agent_name_hint: "Autopilot" }),
    ext_agent_host_id: opts.hostId,
    response_type: "code",
    redirect_uri: opts.redirect,
    scope: `openid profile email offline_access resource.invoke ${TOKEN_SHARING_SCOPE}`,
    resource: CHATGPT_RESOURCE,
    state: opts.state,
    nonce: opts.nonce,
    code_challenge_method: "S256",
    code_challenge: opts.challenge,
  })}`;
}

async function tokenRequest(body: Record<string, string>, fetchImpl: typeof fetch): Promise<ChatGPTTokens> {
  const res = await fetchImpl(CHATGPT_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": getUserAgent() },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) throw new Error(`ChatGPT sign-in failed (HTTP ${res.status})`);
  return (await res.json()) as ChatGPTTokens;
}

/** The ID token's claims, without signature verification: it came straight from the token endpoint over TLS. */
function idTokenClaims(token: string): Record<string, unknown> {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** Settings stored under providers.chatgpt. */
export function chatgptSettings(tokens: ChatGPTTokens, clientId: string, now = Date.now()): ProviderSettings {
  return {
    apiKey: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: now + (tokens.expires_in ?? 3600) * 1000,
    clientId,
  };
}

/** Exchange the callback's code, checking token sharing was granted and the nonce matches. */
export async function completeSignIn(
  code: string,
  clientId: string,
  redirect: string,
  verifier: string,
  nonce: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderSettings> {
  const tokens = await tokenRequest(
    { grant_type: "authorization_code", client_id: clientId, code, code_verifier: verifier, redirect_uri: redirect, resource: CHATGPT_RESOURCE },
    fetchImpl,
  );
  if (!tokens.scope?.split(" ").includes(TOKEN_SHARING_SCOPE)) {
    throw new Error("ChatGPT sign-in finished without token sharing. Sign in again and allow it, or use an OpenAI API key.");
  }
  if (tokens.id_token && idTokenClaims(tokens.id_token).nonce !== nonce) {
    throw new Error("ChatGPT sign-in returned a token for a different sign-in attempt. Try again.");
  }
  return chatgptSettings(tokens, clientId);
}

export interface ChatGPTSignIn {
  url: string;
  /** Resolves with the settings to save once the browser comes back. */
  done: Promise<ProviderSettings>;
  close(): void;
}

/** Start the browser sign-in: a loopback listener plus the URL to open. */
export async function startChatGPTSignIn(opts: { savedClientId?: string; hostId: string; fetchImpl?: typeof fetch; timeoutMs?: number }): Promise<ChatGPTSignIn> {
  const { verifier, challenge } = pkce();
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  let resolve!: (v: ProviderSettings) => void;
  let reject!: (e: Error) => void;
  const done = new Promise<ProviderSettings>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  done.catch(() => undefined);
  let redirect = "";
  const page = (ok: boolean, msg: string) =>
    `<!doctype html><meta charset="utf-8"><title>Autopilot</title><body style="font-family:system-ui;text-align:center;padding:3rem"><h1>${ok ? "✓ Signed in to ChatGPT" : "Sign-in failed"}</h1><p>${msg}</p></body>`;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/auth/callback") return void res.writeHead(404).end();
    const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
    const code = url.searchParams.get("code");
    const clientId = opts.savedClientId ?? url.searchParams.get("client_id") ?? undefined;
    const finish = (err?: string) => {
      res.writeHead(err ? 400 : 200, { "Content-Type": "text/html; charset=utf-8", Connection: "close" }).end(page(!err, err ?? "You can close this tab and return to your terminal."));
      server.close();
    };
    if (error) return finish(error), reject(new Error(error));
    if (!code || url.searchParams.get("state") !== state) {
      const msg = code ? "Invalid sign-in state" : "Missing authorization code";
      return finish(msg), reject(new Error(msg));
    }
    if (!clientId) return finish("No client id returned"), reject(new Error("ChatGPT sign-in did not return a client id. Try again."));
    completeSignIn(code, clientId, redirect, verifier, nonce, opts.fetchImpl).then(
      (s) => (finish(), resolve(s)),
      (e: Error) => (finish(e.message), reject(e)),
    );
  });
  await new Promise<void>((res, rej) => {
    server.once("error", rej);
    server.listen(0, "127.0.0.1", () => res());
  });
  const address = server.address();
  redirect = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/auth/callback`;
  const timer = setTimeout(() => {
    server.close();
    reject(new Error("Timed out waiting for the browser sign-in."));
  }, opts.timeoutMs ?? 10 * 60_000);
  timer.unref();
  return {
    url: authorizeUrl({ redirect, challenge, state, nonce, clientId: opts.savedClientId, hostId: opts.hostId }),
    done,
    close: () => {
      clearTimeout(timer);
      server.close();
      reject(new Error("Sign-in cancelled."));
    },
  };
}

/** A stable host id for this install, so ChatGPT shows one connected agent per machine. */
export async function hostId(): Promise<string> {
  const cfg = await readPersisted();
  const existing = cfg?.providers?.chatgpt?.hostId;
  if (existing) return existing;
  const id = `urn:uuid:${randomUUID()}`;
  await patchPersistedConfig({ providers: { ...cfg?.providers, chatgpt: { ...cfg?.providers?.chatgpt, hostId: id } } });
  return id;
}

async function readPersisted(): Promise<Partial<KimiConfig> | null> {
  try {
    return JSON.parse(await readFile(configPath(), "utf8")) as Partial<KimiConfig>;
  } catch {
    return null;
  }
}

/** Save signed-in settings under providers.chatgpt, keeping the host id. */
export async function saveChatGPTSettings(settings: ProviderSettings): Promise<void> {
  const cfg = await readPersisted();
  await patchPersistedConfig({ providers: { ...cfg?.providers, chatgpt: { ...cfg?.providers?.chatgpt, ...settings } } });
}

let refreshing: Promise<string | undefined> | null = null;

/**
 * The current access token, refreshed (and saved) when it expires within a
 * minute. Undefined when nobody has signed in; CHATGPT_ACCESS_TOKEN in the
 * environment wins (no refresh — for short headless runs).
 */
export async function chatgptAccessToken(fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<string | undefined> {
  const env = process.env.CHATGPT_ACCESS_TOKEN?.trim();
  if (env) return env;
  if (refreshing) return refreshing;
  const s = (await readPersisted())?.providers?.chatgpt;
  if (!s?.apiKey) return undefined;
  if (!s.expiresAt || s.expiresAt - now > 60_000 || !s.refreshToken || !s.clientId) return s.apiKey;
  refreshing = (async () => {
    try {
      const tokens = await tokenRequest(
        { grant_type: "refresh_token", client_id: s.clientId!, refresh_token: s.refreshToken!, resource: CHATGPT_RESOURCE },
        fetchImpl,
      );
      await saveChatGPTSettings(chatgptSettings({ ...tokens, refresh_token: tokens.refresh_token || s.refreshToken! }, s.clientId!, now));
      return tokens.access_token;
    } catch {
      return s.apiKey; // let the request fail with ChatGPT's own error
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

/** Headers ChatGPT token sharing uses for prompt-cache affinity (mirrors the Codex client). */
export function chatgptSessionHeaders(sessionId: string | undefined): Record<string, string> {
  return sessionId ? { "session-id": sessionId, "thread-id": sessionId, "x-client-request-id": sessionId } : {};
}
