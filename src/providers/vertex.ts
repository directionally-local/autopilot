/**
 * Google Vertex AI: Gemini and partner models through Vertex's
 * OpenAI-compatible endpoint, Claude through Anthropic's Messages API on
 * Vertex (`streamRawPredict`). Mirrors opencode's google-vertex providers.
 *
 * Credentials are Google Application Default Credentials, resolved without
 * an extra dependency:
 *   1. GOOGLE_VERTEX_ACCESS_TOKEN (an access token, e.g. from CI)
 *   2. GOOGLE_APPLICATION_CREDENTIALS → a service-account key (signed JWT
 *      exchanged for a token) or an authorized_user file
 *   3. the gcloud ADC file (`gcloud auth application-default login`)
 *   4. `gcloud auth print-access-token`
 * Tokens are cached until a minute before they expire.
 *
 * Project: GOOGLE_VERTEX_PROJECT, GOOGLE_CLOUD_PROJECT, GCP_PROJECT,
 * GCLOUD_PROJECT, providers.vertex.project, or the service account's
 * project. Location: GOOGLE_VERTEX_LOCATION / GOOGLE_CLOUD_LOCATION /
 * providers.vertex.location, default "global" (serves the most models).
 */

import { createSign } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { WireProtocol } from "./presets.js";

const SCOPE = "https://www.googleapis.com/auth/cloud-platform";
export const VERTEX_ANTHROPIC_VERSION = "vertex-2023-10-16";

export function vertexHost(location: string): string {
  if (location === "global") return "aiplatform.googleapis.com";
  if (location === "eu" || location === "us") return `aiplatform.${location}.rep.googleapis.com`;
  return `${location}-aiplatform.googleapis.com`;
}

export function vertexProject(settings?: { project?: string }, env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.GOOGLE_VERTEX_PROJECT || env.GOOGLE_CLOUD_PROJECT || env.GCP_PROJECT || env.GCLOUD_PROJECT || settings?.project || gcloudDefaultProject(env);
}

/** `project = …` from gcloud's active configuration, if gcloud is set up. */
function gcloudDefaultProject(env: NodeJS.ProcessEnv): string | undefined {
  try {
    const dir = env.CLOUDSDK_CONFIG || join(homedir(), ".config", "gcloud");
    const active = existsSync(join(dir, "active_config")) ? readFileSync(join(dir, "active_config"), "utf8").trim() : "default";
    const ini = readFileSync(join(dir, "configurations", `config_${active || "default"}`), "utf8");
    return /^\s*project\s*=\s*(\S+)/m.exec(ini)?.[1];
  } catch {
    return undefined;
  }
}

export function vertexLocation(settings?: { location?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return env.GOOGLE_VERTEX_LOCATION || env.GOOGLE_CLOUD_LOCATION || env.VERTEX_LOCATION || settings?.location || "global";
}

/** Base for a project/location: https://<host>/v1/projects/<p>/locations/<l>. */
export function vertexBase(project: string, location: string): string {
  return `https://${vertexHost(location)}/v1/projects/${project}/locations/${location}`;
}

/** Claude on Vertex speaks Anthropic Messages; everything else the OpenAI-compatible endpoint. */
export function vertexProtocol(model: string): WireProtocol {
  return /^(anthropic\/)?claude/i.test(model) ? "anthropic-messages" : "openai-chat";
}

/** The URL for a model, and the model name to put in a Chat Completions body. */
export function vertexTarget(base: string, model: string): { url: string; protocol: WireProtocol; bodyModel?: string } {
  const protocol = vertexProtocol(model);
  if (protocol === "anthropic-messages") {
    return { url: `${base}/publishers/anthropic/models/${model.replace(/^anthropic\//, "")}:streamRawPredict`, protocol };
  }
  // The OpenAI-compatible endpoint wants a publisher prefix ("google/gemini-…"); partner models carry theirs.
  return { url: `${base}/endpoints/openapi/chat/completions`, protocol, bodyModel: model.includes("/") ? model : `google/${model}` };
}

/** Convert an Anthropic Messages body for Vertex: no `model` (it's in the URL), plus `anthropic_version`. */
export function toVertexAnthropicBody(body: Record<string, unknown>): Record<string, unknown> {
  const { model: _model, ...rest } = body;
  return { ...rest, anthropic_version: VERTEX_ANTHROPIC_VERSION };
}

interface CachedToken {
  token: string;
  expiresAt: number;
}
let cached: CachedToken | null = null;

/** Forget the cached token (tests; after a 401). */
export function resetVertexToken(): void {
  cached = null;
}

interface ServiceAccount {
  type: "service_account";
  client_email: string;
  private_key: string;
  token_uri?: string;
  project_id?: string;
}
interface AuthorizedUser {
  type: "authorized_user";
  client_id: string;
  client_secret: string;
  refresh_token: string;
  quota_project_id?: string;
}

function adcFile(env: NodeJS.ProcessEnv): string | undefined {
  if (env.GOOGLE_APPLICATION_CREDENTIALS) return env.GOOGLE_APPLICATION_CREDENTIALS;
  const dir = env.CLOUDSDK_CONFIG || (process.platform === "win32" ? join(env.APPDATA ?? homedir(), "gcloud") : join(homedir(), ".config", "gcloud"));
  const file = join(dir, "application_default_credentials.json");
  return existsSync(file) ? file : undefined;
}

/** The project a service-account key belongs to, as a fallback when none is configured. */
export async function adcProject(env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  const file = adcFile(env);
  if (!file) return undefined;
  try {
    const creds = JSON.parse(await readFile(file, "utf8")) as { project_id?: string; quota_project_id?: string };
    return creds.project_id ?? creds.quota_project_id;
  } catch {
    return undefined;
  }
}

function signJwt(sa: ServiceAccount, now: number): string {
  const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const header = enc({ alg: "RS256", typ: "JWT" });
  const iat = Math.floor(now / 1000);
  const payload = enc({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri ?? "https://oauth2.googleapis.com/token", iat, exp: iat + 3600 });
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).sign(sa.private_key).toString("base64url");
  return `${header}.${payload}.${signature}`;
}

async function tokenFromFile(file: string, fetchImpl: typeof fetch, now: number): Promise<CachedToken> {
  const creds = JSON.parse(await readFile(file, "utf8")) as ServiceAccount | AuthorizedUser;
  const tokenUrl = creds.type === "service_account" ? creds.token_uri ?? "https://oauth2.googleapis.com/token" : "https://oauth2.googleapis.com/token";
  const body =
    creds.type === "service_account"
      ? new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signJwt(creds, now) })
      : new URLSearchParams({ grant_type: "refresh_token", client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token });
  const res = await fetchImpl(tokenUrl, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: body.toString() });
  if (!res.ok) throw new Error(`Google credentials were rejected (HTTP ${res.status}). Run \`gcloud auth application-default login\`.`);
  const t = (await res.json()) as { access_token: string; expires_in?: number };
  return { token: t.access_token, expiresAt: now + (t.expires_in ?? 3600) * 1000 };
}

function gcloudToken(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("gcloud", ["auth", "print-access-token"], { timeout: 15_000 }, (err, stdout) => {
      if (err) reject(new Error("No Google credentials found. Run `gcloud auth application-default login`, or set GOOGLE_APPLICATION_CREDENTIALS."));
      else resolve(stdout.trim());
    });
  });
}

/** An access token for Vertex, from the first credential source that works. */
export async function vertexAccessToken(fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env, now = Date.now()): Promise<string> {
  if (env.GOOGLE_VERTEX_ACCESS_TOKEN) return env.GOOGLE_VERTEX_ACCESS_TOKEN;
  if (cached && cached.expiresAt - now > 60_000) return cached.token;
  const file = adcFile(env);
  if (file) {
    cached = await tokenFromFile(file, fetchImpl, now);
    return cached.token;
  }
  const token = await gcloudToken();
  cached = { token, expiresAt: now + 30 * 60_000 };
  return token;
}
