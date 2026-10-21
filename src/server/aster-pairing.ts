import type { IncomingMessage, ServerResponse } from "node:http";
import { AsterConfigError, loadAsterServerConfig } from "./aster-workspaces.js";
import type { AsterStore, CreatedAsterCredential } from "./aster-store.js";

/**
 * Pairing a client (the laptop CLI, later a desktop app) with this server without
 * copying keys. The client starts a device-code authorization and polls; the owner
 * approves its short code in a browser page or on the server with
 * `autopilot aster pair approve`. The browser becomes the owner by opening a one-time
 * claim link (`autopilot aster owner link`), which stores a pairing:approve Aster
 * credential in an HttpOnly cookie. Everything lives under /api/v1 so gateways that
 * proxy only the Aster API keep working.
 */

const AUTH_PREFIX = "/api/v1/auth";
const DEVICE_CODE_TTL_MS = 10 * 60 * 1000;
const MAX_PENDING_DEVICE_CODES = 20;
const MAX_FORM_BYTES = 8 * 1024;
const CLIENT_NAME_RE = /^[\p{L}\p{N} ._'()@-]{1,60}$/u;
const OWNER_COOKIE = "aster_owner";
export const CLIENT_CREDENTIAL_TTL_MS = 90 * 24 * 60 * 60 * 1000;
export const OWNER_CREDENTIAL_TTL_MS = 365 * 24 * 60 * 60 * 1000;
export const OWNER_CLAIM_TTL_MS = 24 * 60 * 60 * 1000;

/** Handles the unauthenticated pairing routes; returns false for every other path. */
export async function handleAsterPairing(req: IncomingMessage, res: ServerResponse, url: URL, store: AsterStore): Promise<boolean> {
  const path = url.pathname;
  if (!path.startsWith(`${AUTH_PREFIX}/`)) return false;
  const method = req.method ?? "GET";

  if (path === `${AUTH_PREFIX}/device` && method === "POST") {
    const body = await readJsonBody(req);
    const clientName = typeof body.clientName === "string" ? body.clientName.trim() : "Autopilot CLI";
    if (!CLIENT_NAME_RE.test(clientName)) return sendError(res, 400, "invalid_client_name", "clientName must be 1-60 letters, digits, spaces, or ._'()@-");
    const started = store.createDeviceAuthorization({ clientName, ttlMs: DEVICE_CODE_TTL_MS, maxPending: MAX_PENDING_DEVICE_CODES });
    if (!started) return sendError(res, 429, "too_many_pending", "Too many pairings are waiting for approval; try again later");
    const verificationUri = `${publicBaseUrl(req)}${AUTH_PREFIX}/approve`;
    return json(res, 200, {
      deviceCode: started.deviceCode,
      userCode: started.userCode,
      verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(started.userCode)}`,
      expiresIn: Math.round(DEVICE_CODE_TTL_MS / 1000),
      interval: Math.round(started.intervalMs / 1000),
    });
  }

  if (path === `${AUTH_PREFIX}/device/token` && method === "POST") {
    const body = await readJsonBody(req);
    if (typeof body.deviceCode !== "string" || body.deviceCode.length > 200) return sendError(res, 400, "invalid_request", "deviceCode is required");
    const result = store.redeemDeviceAuthorization(body.deviceCode);
    switch (result.kind) {
      case "pending": return sendError(res, 400, "authorization_pending", "Waiting for the owner to approve this code");
      case "slow_down": return sendError(res, 400, "slow_down", "Polling too fast; wait the advertised interval");
      case "denied": return sendError(res, 400, "access_denied", "The owner denied this pairing");
      case "expired": return sendError(res, 400, "expired_token", "This pairing code expired or was already used; start again");
      case "issued": return json(res, 200, publicCredential(result.credential));
    }
  }

  if (path === `${AUTH_PREFIX}/claim` && method === "GET") {
    const token = url.searchParams.get("token") ?? "";
    return html(res, 200, "Claim this server", `
      <h1>Claim this server</h1>
      <p>This makes this browser the owner of the Autopilot server, so it can approve laptops and apps that pair with it.</p>
      <form method="post" action="${AUTH_PREFIX}/claim">
        <input type="hidden" name="token" value="${escapeHtml(token)}">
        <button type="submit">Make this browser the owner</button>
      </form>`);
  }

  if (path === `${AUTH_PREFIX}/claim` && method === "POST") {
    if (!isSameOrigin(req)) return html(res, 403, "Refused", "<h1>Refused</h1><p>Cross-origin request.</p>");
    const form = await readForm(req);
    const workspaceIds = await configuredWorkspaceIds();
    if (!workspaceIds) return html(res, 503, "Not configured", "<h1>Not configured</h1><p>Aster workspaces are not configured on this server.</p>");
    const credential = store.redeemOwnerClaim(form.get("token") ?? "", { workspaceIds, credentialTtlMs: OWNER_CREDENTIAL_TTL_MS });
    if (!credential) {
      return html(res, 410, "Link expired", `<h1>This link expired or was already used</h1>
        <p>On the server, run <code>autopilot aster owner link</code> for a new one.</p>`);
    }
    res.setHeader("Set-Cookie", `${OWNER_COOKIE}=${credential.token}; Path=${AUTH_PREFIX}; Max-Age=${Math.floor(OWNER_CREDENTIAL_TTL_MS / 1000)}; HttpOnly; Secure; SameSite=Strict`);
    res.writeHead(303, { Location: `${AUTH_PREFIX}/approve`, "Cache-Control": "no-store" });
    res.end();
    return true;
  }

  if (path === `${AUTH_PREFIX}/approve` && method === "GET") {
    if (!isOwner(req, store)) return html(res, 401, "Approve a device", notOwnerBody(url.searchParams.get("code")));
    const code = url.searchParams.get("code");
    const device = code ? store.getDeviceAuthorization(code) : undefined;
    const pending = store.listPendingDeviceAuthorizations();
    return html(res, 200, "Approve a device", `
      <h1>Approve a device</h1>
      ${device && device.status === "pending" ? approvalForm(device.userCode, device.clientName) : `
        <form method="post" action="${AUTH_PREFIX}/approve">
          <label>Code shown on the device <input name="code" autocomplete="off" autofocus value="${escapeHtml(code ?? "")}" placeholder="BCDF-GHJK"></label>
          <button type="submit" name="decision" value="approve">Approve</button>
          <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
        </form>`}
      ${pending.length > 0 ? `<p class="muted">Waiting: ${pending.map((entry) => `${escapeHtml(entry.userCode)} (${escapeHtml(entry.clientName)})`).join(", ")}</p>` : ""}`);
  }

  if (path === `${AUTH_PREFIX}/approve` && method === "POST") {
    if (!isSameOrigin(req)) return html(res, 403, "Refused", "<h1>Refused</h1><p>Cross-origin request.</p>");
    if (!isOwner(req, store)) return html(res, 401, "Approve a device", notOwnerBody(null));
    const form = await readForm(req);
    const decision = form.get("decision") === "deny" ? "deny" : "approve";
    const workspaceIds = await configuredWorkspaceIds();
    if (!workspaceIds) return html(res, 503, "Not configured", "<h1>Not configured</h1><p>Aster workspaces are not configured on this server.</p>");
    const outcome = store.resolveDeviceAuthorization(form.get("code") ?? "", decision, { workspaceIds, credentialTtlMs: CLIENT_CREDENTIAL_TTL_MS });
    const messages: Record<typeof outcome, [number, string]> = {
      approved: [200, "Approved. The device finishes signing in on its own; you can close this page."],
      denied: [200, "Denied. The device was not paired."],
      not_found: [404, "No pairing with that code. Check the code on the device."],
      expired: [410, "That code expired. Start pairing again on the device."],
      already_resolved: [409, "That code was already approved or denied."],
    };
    const [status, message] = messages[outcome];
    return html(res, status, "Approve a device", `<h1>Approve a device</h1><p>${message}</p><p><a href="${AUTH_PREFIX}/approve">Approve another</a></p>`);
  }

  return sendError(res, 404, "not_found", "Aster endpoint not found");
}

/** The pairing outcome a client receives; the token is shown once. */
export function publicCredential(credential: CreatedAsterCredential): Record<string, unknown> {
  return {
    token: credential.token,
    credentialId: credential.id,
    name: credential.name,
    workspaceIds: credential.workspaceIds,
    scopes: credential.scopes,
    expiresAt: new Date(credential.expiresAt).toISOString(),
  };
}

/** Every configured workspace: a solo server pairs its owner's devices with all of them. */
export async function configuredWorkspaceIds(): Promise<string[] | undefined> {
  try {
    const ids = (await loadAsterServerConfig()).workspaces.map(({ id }) => id);
    return ids.length > 0 ? ids : undefined;
  } catch (error) {
    if (error instanceof AsterConfigError) return undefined;
    throw error;
  }
}

/** Where browsers and clients reach this server: AUTOPILOT_PUBLIC_URL, else the request's own host. */
export function publicBaseUrl(req: IncomingMessage, env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AUTOPILOT_PUBLIC_URL?.trim().replace(/\/+$/, "");
  if (configured) return configured;
  const host = firstHeader(req.headers["x-forwarded-host"]) ?? req.headers.host ?? "localhost";
  const forwardedProto = firstHeader(req.headers["x-forwarded-proto"]);
  const proto = forwardedProto === "http" || forwardedProto === "https"
    ? forwardedProto
    : isLoopbackName(hostWithoutPort(host)) ? "http" : "https";
  return `${proto}://${host}`;
}

function isOwner(req: IncomingMessage, store: AsterStore): boolean {
  const token = readCookie(req, OWNER_COOKIE);
  if (!token) return false;
  return store.authenticate(`Bearer ${token}`)?.scopes.includes("pairing:approve") === true;
}

/** Form posts must come from a page this server served (SameSite=Strict covers the cookie too). */
function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin) return false;
  let originHost: string;
  try {
    originHost = new URL(origin).host;
  } catch {
    return false;
  }
  return originHost === req.headers.host || originHost === firstHeader(req.headers["x-forwarded-host"]);
}

function readCookie(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name) return value.join("=");
  }
  return undefined;
}

function notOwnerBody(code: string | null): string {
  return `
    <h1>Approve a device</h1>
    <p>This browser isn't the server's owner yet. Open the owner link your installer printed, or create one on the server:</p>
    <pre>autopilot aster owner link</pre>
    <p>You can also approve from the server directly:</p>
    <pre>autopilot aster pair approve ${escapeHtml(code ?? "<code>")}</pre>`;
}

function approvalForm(userCode: string, clientName: string): string {
  return `
    <p><strong>${escapeHtml(clientName)}</strong> wants to use this server.</p>
    <p class="code">${escapeHtml(userCode)}</p>
    <p class="muted">Approve only if this matches the code shown on your device.</p>
    <form method="post" action="${AUTH_PREFIX}/approve">
      <input type="hidden" name="code" value="${escapeHtml(userCode)}">
      <button type="submit" name="decision" value="approve">Approve</button>
      <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
    </form>`;
}

function html(res: ServerResponse, status: number, title: string, body: string): true {
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Autopilot</title>
<style>
  :root { color-scheme: light dark; --fg: #1b1b1f; --bg: #fafaf9; --muted: #6b6b73; --accent: #2f5bd3; }
  @media (prefers-color-scheme: dark) { :root { --fg: #ececf1; --bg: #16161a; --muted: #9a9aa5; --accent: #7c9cff; } }
  body { font: 16px/1.5 system-ui, sans-serif; color: var(--fg); background: var(--bg); max-width: 32rem; margin: 3rem auto; padding: 0 1rem; }
  .muted { color: var(--muted); font-size: 0.9rem; }
  .code { font: 600 2rem/1.2 ui-monospace, monospace; letter-spacing: 0.1em; }
  pre, code { font-family: ui-monospace, monospace; }
  pre { padding: 0.75rem; border: 1px solid var(--muted); border-radius: 6px; overflow-x: auto; }
  input { font: inherit; padding: 0.4rem; margin: 0.25rem 0 0.75rem; display: block; width: 100%; box-sizing: border-box; }
  button { font: inherit; padding: 0.5rem 1rem; border-radius: 6px; border: 1px solid var(--accent); background: var(--accent); color: #fff; cursor: pointer; }
  button.secondary { background: transparent; color: var(--fg); border-color: var(--muted); }
  a { color: var(--accent); }
</style></head><body>${body}</body></html>`);
  return true;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

async function readRawBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_FORM_BYTES) throw new PairingRequestError(413, "request_too_large", "Request body is too large");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const raw = await readRawBody(req);
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new PairingRequestError(400, "invalid_json", "Request body must be valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new PairingRequestError(400, "invalid_json", "Request body must be a JSON object");
  return parsed as Record<string, unknown>;
}

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  return new URLSearchParams(await readRawBody(req));
}

export class PairingRequestError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "PairingRequestError";
  }
}

function sendError(res: ServerResponse, status: number, code: string, message: string): true {
  return json(res, status, { error: { code, message } });
}

function json(res: ServerResponse, status: number, data: unknown): true {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
  return true;
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return first?.split(",")[0]?.trim() || undefined;
}

function isLoopbackName(host: string): boolean {
  const name = host.toLowerCase();
  return name === "localhost" || name === "[::1]" || name.startsWith("127.");
}

function hostWithoutPort(host: string): string {
  return host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : (host.split(":")[0] ?? "");
}

