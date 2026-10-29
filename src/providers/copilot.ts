/**
 * GitHub Copilot as a provider: sign in with GitHub's device flow, then use
 * the Copilot API with that token. Mirrors the integration opencode ships
 * (packages/core/src/plugin/provider/github-copilot.ts), with Autopilot's own
 * GitHub OAuth app:
 *
 * - device flow on github.com (or a GitHub Enterprise domain), scope
 *   `read:user`; `/copilot_internal/user` confirms the account has Copilot
 *   chat and names the API base URL
 * - the live model list (`GET <base>/models`) says which endpoint serves each
 *   model: Anthropic Messages (`/v1/messages`) for Claude, Responses for
 *   GPT-5+ and other OpenAI models, Chat Completions for the rest
 * - every request carries Copilot's headers: `Openai-Intent`,
 *   `X-GitHub-Api-Version`, `x-initiator` (user for a turn the user started,
 *   agent for tool-loop follow-ups — this decides premium-request billing)
 *   and `Copilot-Vision-Request` when images are sent
 *
 * The Copilot API is not a public, documented API; GitHub can change it.
 * Usage is governed by your Copilot plan and GitHub's terms.
 */

import type { ModelEntry } from "../models/registry.js";
import { getUserAgent } from "../util/version.js";
import type { WireProtocol } from "./presets.js";
import { readEnv } from "../util/env.js";

/** Autopilot's GitHub OAuth app (the same one `autopilot auth github` uses); overridable for forks/enterprise apps. */
export const COPILOT_CLIENT_ID = process.env.AUTOPILOT_COPILOT_CLIENT_ID ?? readEnv("GITHUB_CLIENT_ID") ?? "Ov23liM7lJX1xE2V1sVK";
export const COPILOT_API_VERSION = "2026-08-01";
const USER_API_VERSION = "2025-04-01";
export const COPILOT_DEFAULT_BASE = "https://api.githubcopilot.com";

function normalizeDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, "").replace(/\/+$/, "");
}

export function copilotUrls(enterprise?: string) {
  const domain = enterprise ? normalizeDomain(enterprise) : "github.com";
  return {
    device: `https://${domain}/login/device/code`,
    token: `https://${domain}/login/oauth/access_token`,
    user: domain === "github.com" ? "https://api.github.com/copilot_internal/user" : `https://api.${domain}/copilot_internal/user`,
    api: enterprise ? `https://copilot-api.${domain}` : COPILOT_DEFAULT_BASE,
  };
}

export interface DeviceCode {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  intervalSec: number;
  expiresInSec: number;
}

export async function startDeviceFlow(enterprise?: string, fetchImpl: typeof fetch = fetch): Promise<DeviceCode> {
  const res = await fetchImpl(copilotUrls(enterprise).device, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": getUserAgent() },
    body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, scope: "read:user" }),
  });
  if (!res.ok) throw new Error(`GitHub device login failed (HTTP ${res.status})`);
  const d = (await res.json()) as { device_code: string; user_code: string; verification_uri: string; interval?: number; expires_in?: number };
  return { deviceCode: d.device_code, userCode: d.user_code, verificationUri: d.verification_uri, intervalSec: d.interval ?? 5, expiresInSec: d.expires_in ?? 900 };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });

/** Poll until the user approves the code; returns the GitHub OAuth token. */
export async function pollDeviceFlow(
  code: DeviceCode,
  enterprise?: string,
  opts: { fetchImpl?: typeof fetch; signal?: AbortSignal; now?: () => number } = {},
): Promise<string> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const deadline = now() + code.expiresInSec * 1000;
  let wait = code.intervalSec * 1000;
  while (now() < deadline) {
    await sleep(wait, opts.signal);
    const res = await fetchImpl(copilotUrls(enterprise).token, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": getUserAgent() },
      body: JSON.stringify({ client_id: COPILOT_CLIENT_ID, device_code: code.deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    const t = (await res.json().catch(() => ({}))) as { access_token?: string; error?: string; interval?: number };
    if (t.access_token) return t.access_token;
    if (t.error === "authorization_pending") continue;
    if (t.error === "slow_down") {
      wait = t.interval && t.interval > 0 ? t.interval * 1000 : wait + 5000;
      continue;
    }
    throw new Error(`GitHub device login failed${t.error ? `: ${t.error}` : ""}`);
  }
  throw new Error("GitHub device login expired — start again");
}

/**
 * Confirm the token's account has Copilot chat and find its API base URL.
 * Throws a readable error for accounts without Copilot.
 */
export async function checkCopilotAccess(token: string, enterprise?: string, fetchImpl: typeof fetch = fetch): Promise<{ apiBase: string; plan?: string }> {
  const res = await fetchImpl(copilotUrls(enterprise).user, {
    headers: { Accept: "application/json", Authorization: `Bearer ${token}`, "User-Agent": getUserAgent(), "X-GitHub-Api-Version": USER_API_VERSION },
  });
  if (res.status === 401) throw new Error("GitHub rejected the token — sign in again with `autopilot auth copilot`.");
  if (!res.ok) throw new Error(`Couldn't check Copilot access (HTTP ${res.status}).`);
  const u = (await res.json()) as { chat_enabled?: boolean; copilot_plan?: string; endpoints?: { api?: string } };
  if (u.chat_enabled === false) {
    throw new Error("This GitHub account has no GitHub Copilot chat access. Sign up (Copilot Free works) at https://github.com/features/copilot/plans, then connect again.");
  }
  return { apiBase: u.endpoints?.api?.replace(/\/+$/, "") ?? copilotUrls(enterprise).api, ...(u.copilot_plan ? { plan: u.copilot_plan } : {}) };
}

/** Which Copilot endpoint serves a model, from its `supported_endpoints`. */
export function copilotProtocol(endpoints: readonly string[] | undefined): WireProtocol {
  if (endpoints?.includes("/v1/messages")) return "anthropic-messages";
  if (endpoints?.includes("/responses")) return "openai-responses";
  return "openai-chat";
}

interface RemoteModel {
  id: string;
  name?: string;
  model_picker_enabled?: boolean;
  supported_endpoints?: string[];
  policy?: { state?: string };
  capabilities?: {
    limits?: { max_context_window_tokens?: number; max_prompt_tokens?: number; max_output_tokens?: number; vision?: { supported_media_types?: string[] } };
    supports?: { tool_calls?: boolean; vision?: boolean; reasoning_effort?: string[]; adaptive_thinking?: boolean; max_thinking_budget?: number };
  };
}

/** Map Copilot's model list into registry entries (subscription: priced at $0). */
export function mapCopilotModels(data: unknown[]): ModelEntry[] {
  const out: ModelEntry[] = [];
  for (const raw of data as RemoteModel[]) {
    const limits = raw.capabilities?.limits;
    const supports = raw.capabilities?.supports;
    if (raw.policy?.state === "disabled" || !limits?.max_output_tokens || !limits.max_prompt_tokens || supports?.tool_calls === undefined) continue;
    // A chat-only alias that conflicts with the GPT-5 Responses route.
    if (raw.id === "gpt-5-chat-latest") continue;
    const efforts = supports.reasoning_effort ?? [];
    out.push({
      id: raw.id,
      ...(raw.name ? { name: raw.name } : {}),
      protocol: copilotProtocol(raw.supported_endpoints),
      ...(efforts.length > 0 ? { reasoningEfforts: efforts } : {}),
      ...(supports.max_thinking_budget && !supports.adaptive_thinking ? { reasoningBudget: true } : {}),
      contextWindow: limits.max_context_window_tokens ?? limits.max_prompt_tokens,
      maxOutputTokens: limits.max_output_tokens,
      pricing: { inputPerMtok: 0, outputPerMtok: 0 },
      supports: {
        tools: supports.tool_calls === true,
        reasoning: efforts.length > 0 || !!supports.max_thinking_budget,
        streaming: true,
        vision: supports.vision === true || (limits.vision?.supported_media_types ?? []).some((t) => t.startsWith("image/")),
      },
    });
  }
  return out;
}

export async function loadCopilotModels(base: string, token: string, fetchImpl: typeof fetch = fetch): Promise<ModelEntry[]> {
  const res = await fetchImpl(`${base.replace(/\/+$/, "")}/models`, {
    headers: { Authorization: `Bearer ${token}`, "User-Agent": getUserAgent(), "X-GitHub-Api-Version": COPILOT_API_VERSION, Accept: "application/json" },
    signal: AbortSignal.timeout(5_000),
  });
  if (!res.ok) throw new Error(`Copilot /models returned HTTP ${res.status}`);
  const body = (await res.json()) as { data?: unknown[] };
  return mapCopilotModels(body.data ?? []);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Headers Copilot needs on each request, from the wire body: `x-initiator`
 * is "user" only when the request answers a user message (premium request),
 * "agent" for tool-loop follow-ups; `Copilot-Vision-Request` when images go up.
 */
export function copilotRequestHeaders(token: string | undefined, body: Record<string, unknown>, protocol: WireProtocol): Record<string, string> {
  let agent = true;
  let vision = false;
  const hasImage = (content: unknown, types: string[]): boolean =>
    Array.isArray(content) && content.some((p): boolean => isRecord(p) && (types.includes(String(p.type)) || (p.type === "tool_result" && hasImage(p.content, types))));
  if (protocol === "openai-responses" && Array.isArray(body.input)) {
    const last = body.input.at(-1);
    agent = !isRecord(last) || last.role !== "user";
    vision = body.input.some((i) => isRecord(i) && hasImage(i.content, ["input_image"]));
  } else if (Array.isArray(body.messages)) {
    const last = body.messages.at(-1);
    if (protocol === "anthropic-messages") {
      const content = isRecord(last) && Array.isArray(last.content) ? last.content : [];
      agent = !isRecord(last) || last.role !== "user" || !content.some((p) => isRecord(p) && p.type !== "tool_result");
      vision = body.messages.some((m) => isRecord(m) && hasImage(m.content, ["image"]));
    } else {
      agent = !isRecord(last) || last.role !== "user";
      vision = body.messages.some((m) => isRecord(m) && hasImage(m.content, ["image_url"]));
    }
  }
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    "Openai-Intent": "conversation-edits",
    "X-GitHub-Api-Version": COPILOT_API_VERSION,
    "x-initiator": agent ? "agent" : "user",
    ...(vision ? { "Copilot-Vision-Request": "true" } : {}),
  };
}
