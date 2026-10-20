/**
 * Amazon Bedrock through the Converse API (ConverseStream), without the AWS
 * SDK: request mapping, SigV4 signing, and the binary event-stream parser.
 *
 * Credentials, first found wins:
 *   1. AWS_BEARER_TOKEN_BEDROCK — a Bedrock API key (Bearer auth)
 *   2. AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (+ AWS_SESSION_TOKEN)
 *   3. the shared credentials file (~/.aws/credentials or
 *      AWS_SHARED_CREDENTIALS_FILE), profile AWS_PROFILE or "default"
 * SSO / web-identity users can export temporary credentials into the
 * environment (`eval "$(aws configure export-credentials --format env)"`).
 * Region: AWS_REGION, AWS_DEFAULT_REGION, providers.bedrock.region, else
 * us-east-1.
 *
 * Mapping: system → `system` blocks; tool calls → `toolUse`; tool results →
 * `toolResult` in a user turn; Claude extended thinking → `reasoningContent`
 * blocks (signed, replayed verbatim) via additionalModelRequestFields;
 * prompt caching via `cachePoint` blocks for Anthropic models; usage
 * including cache reads/writes.
 */

import { createHash, createHmac } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { KimiApiError } from "../util/errors.js";
import type { KimiEvent } from "../agent/client.js";
import type { ChatMessage, ContentPart, ReasoningDetail, ToolDef, Usage } from "../agent/messages.js";

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type BedrockAuth = { bearer: string } | { credentials: AwsCredentials };

export function bedrockRegion(settings?: { region?: string }, env: NodeJS.ProcessEnv = process.env): string {
  return env.AWS_REGION || env.AWS_DEFAULT_REGION || settings?.region || "us-east-1";
}

export function bedrockBase(region: string): string {
  return `https://bedrock-runtime.${region}.amazonaws.com`;
}

/** Credentials from the shared credentials file for a profile. */
function fileCredentials(env: NodeJS.ProcessEnv): AwsCredentials | undefined {
  const file = env.AWS_SHARED_CREDENTIALS_FILE || join(homedir(), ".aws", "credentials");
  if (!existsSync(file)) return undefined;
  const profile = env.AWS_PROFILE || "default";
  const section: Record<string, string> = {};
  let current = "";
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    const header = /^\[(.+)\]$/.exec(line);
    if (header) {
      current = header[1]!.trim();
      continue;
    }
    if (current !== profile || !line || line.startsWith("#") || line.startsWith(";")) continue;
    const eq = line.indexOf("=");
    if (eq > 0) section[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  if (!section.aws_access_key_id || !section.aws_secret_access_key) return undefined;
  return {
    accessKeyId: section.aws_access_key_id,
    secretAccessKey: section.aws_secret_access_key,
    ...(section.aws_session_token ? { sessionToken: section.aws_session_token } : {}),
  };
}

/** The first available Bedrock credential, or undefined. */
export function bedrockAuth(env: NodeJS.ProcessEnv = process.env): BedrockAuth | undefined {
  if (env.AWS_BEARER_TOKEN_BEDROCK) return { bearer: env.AWS_BEARER_TOKEN_BEDROCK };
  if (env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY) {
    return {
      credentials: {
        accessKeyId: env.AWS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
        ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
      },
    };
  }
  const file = fileCredentials(env);
  return file ? { credentials: file } : undefined;
}

// ── SigV4 ──────────────────────────────────────────────────────────────

const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");
const hmac = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/** RFC 3986 encoding as SigV4 wants it. */
function uriEncode(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Sign a request with AWS Signature V4 (service "bedrock"). For services
 * other than S3 the canonical URI encodes each already-encoded path segment
 * again.
 */
export function signSigV4(opts: {
  method: string;
  url: string;
  body: string;
  region: string;
  service?: string;
  credentials: AwsCredentials;
  now?: Date;
  /** Sign x-amz-content-sha256 (Bedrock: yes; AWS's generic test vectors: no). */
  contentSha?: boolean;
}): Record<string, string> {
  const u = new URL(opts.url);
  const service = opts.service ?? "bedrock";
  const amzDate = (opts.now ?? new Date()).toISOString().replace(/[:-]|\.\d{3}/g, "");
  const date = amzDate.slice(0, 8);
  const payloadHash = sha256(opts.body);
  const headers: Record<string, string> = {
    host: u.host,
    "x-amz-date": amzDate,
    ...(opts.contentSha === false ? {} : { "x-amz-content-sha256": payloadHash }),
    ...(opts.credentials.sessionToken ? { "x-amz-security-token": opts.credentials.sessionToken } : {}),
  };
  const signedHeaders = Object.keys(headers).sort();
  const canonicalUri = u.pathname.split("/").map((seg) => uriEncode(seg)).join("/");
  const canonicalQuery = [...u.searchParams.entries()]
    .map(([k, v]) => `${uriEncode(k)}=${uriEncode(v)}`)
    .sort()
    .join("&");
  const canonicalRequest = [
    opts.method,
    canonicalUri,
    canonicalQuery,
    signedHeaders.map((h) => `${h}:${headers[h]!.trim()}\n`).join(""),
    signedHeaders.join(";"),
    payloadHash,
  ].join("\n");
  const scope = `${date}/${opts.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${opts.credentials.secretAccessKey}`, date), opts.region), service), "aws4_request");
  const signature = createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  const { host: _host, ...sent } = headers;
  return {
    ...sent,
    Authorization: `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(";")}, Signature=${signature}`,
  };
}

/** Headers for a Bedrock request with the given credential. */
export function bedrockHeaders(auth: BedrockAuth, url: string, body: string, region: string, now?: Date): Record<string, string> {
  if ("bearer" in auth) return { Authorization: `Bearer ${auth.bearer}` };
  return signSigV4({ method: "POST", url, body, region, credentials: auth.credentials, now });
}

export function converseUrl(base: string, model: string): string {
  return `${base.replace(/\/+$/, "")}/model/${encodeURIComponent(model)}/converse-stream`;
}

// ── Request mapping ────────────────────────────────────────────────────

type Block = Record<string, unknown>;

function sanitizeToolId(id: string): string {
  const clean = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return clean.length > 0 ? clean : "tooluse_0";
}

function blocks(content: ChatMessage["content"]): Block[] {
  if (content === null || content === undefined) return [];
  if (typeof content === "string") return content ? [{ text: content }] : [];
  return content.flatMap((p: ContentPart): Block[] => {
    if (p.type === "text") return p.text ? [{ text: p.text }] : [];
    const m = /^data:image\/([a-z]+);base64,(.*)$/s.exec(p.image_url.url);
    return m ? [{ image: { format: m[1] === "jpg" ? "jpeg" : m[1], source: { bytes: m[2] } } }] : [];
  });
}

function reasoningBlocks(details: ReasoningDetail[] | undefined): Block[] {
  return (details ?? []).flatMap((d): Block[] => {
    if (d.type === "bedrock.reasoning" && typeof d.signature === "string") {
      return [{ reasoningContent: { reasoningText: { text: typeof d.text === "string" ? d.text : "", signature: d.signature } } }];
    }
    if (d.type === "bedrock.redacted" && typeof d.data === "string") return [{ reasoningContent: { redactedContent: d.data } }];
    return [];
  });
}

export interface ConverseRequestInput {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  maxTokens: number;
  temperature?: number;
  reasoningEffort?: "low" | "medium" | "high";
  supportsReasoning: boolean;
  supportsTemperature: boolean;
}

const THINKING_BUDGET = { low: 4_096, medium: 16_000, high: 32_000 } as const;

function isAnthropic(model: string): boolean {
  return /(^|\.)anthropic\.claude/.test(model);
}

export function toConverseRequest(input: ConverseRequestInput): Record<string, unknown> {
  const system: Block[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: Block[] }> = [];
  const push = (role: "user" | "assistant", content: Block[]) => {
    if (content.length === 0) return;
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...content);
    else messages.push({ role, content });
  };
  for (const m of input.messages) {
    if (m.role === "system") {
      const text = typeof m.content === "string" ? m.content : blocks(m.content).map((b) => String(b.text ?? "")).join("\n");
      if (text) system.push({ text });
    } else if (m.role === "user") push("user", blocks(m.content));
    else if (m.role === "assistant") {
      push("assistant", [
        ...reasoningBlocks(m.reasoning_details),
        ...blocks(m.content),
        ...(m.tool_calls ?? []).map((tc) => {
          let parsed: unknown = {};
          try {
            parsed = JSON.parse(tc.function.arguments || "{}");
          } catch {
            parsed = {};
          }
          return { toolUse: { toolUseId: sanitizeToolId(tc.id), name: tc.function.name, input: parsed } };
        }),
      ]);
    } else if (m.role === "tool") {
      const text = typeof m.content === "string" ? m.content : blocks(m.content).map((b) => String(b.text ?? "")).join("\n");
      push("user", [{ toolResult: { toolUseId: sanitizeToolId(m.tool_call_id ?? ""), content: [{ text: text || "(empty)" }] } }]);
    }
  }
  const anthropic = isAnthropic(input.model);
  const cachePoint = { cachePoint: { type: "default" } };
  const body: Record<string, unknown> = { messages };
  if (system.length > 0) body.system = anthropic ? [...system, cachePoint] : system;
  if (input.tools && input.tools.length > 0) {
    const tools: Block[] = input.tools.map((t) => ({
      toolSpec: { name: t.function.name, description: t.function.description, inputSchema: { json: t.function.parameters } },
    }));
    body.toolConfig = { tools: anthropic ? [...tools, cachePoint] : tools, toolChoice: { auto: {} } };
  }
  // Conversation-tail cache point for Anthropic models.
  if (anthropic && messages.length > 0) messages[messages.length - 1]!.content.push(cachePoint);
  const thinking = input.reasoningEffort && input.supportsReasoning && anthropic ? THINKING_BUDGET[input.reasoningEffort] : 0;
  body.inferenceConfig = {
    maxTokens: thinking ? Math.max(input.maxTokens, thinking + 8_192) : input.maxTokens,
    ...(input.supportsTemperature && !thinking ? { temperature: input.temperature ?? 0.2 } : {}),
  };
  if (thinking) body.additionalModelRequestFields = { thinking: { type: "enabled", budget_tokens: thinking } };
  else if (input.reasoningEffort && input.supportsReasoning && /gpt-oss/.test(input.model)) {
    body.additionalModelRequestFields = { reasoning_effort: input.reasoningEffort };
  }
  return body;
}

// ── Event stream ───────────────────────────────────────────────────────

interface StreamMessage {
  headers: Record<string, string>;
  payload: Uint8Array;
}

/** Split AWS's binary event-stream framing into messages (CRCs are not checked; TLS covers integrity). */
export async function* readEventStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<StreamMessage> {
  const reader = body.getReader();
  let buf = new Uint8Array(0);
  const onAbort = () => void reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    for (;;) {
      while (buf.length >= 12) {
        const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const total = view.getUint32(0);
        const headersLen = view.getUint32(4);
        if (buf.length < total) break;
        const headers: Record<string, string> = {};
        let p = 12;
        const end = 12 + headersLen;
        while (p < end) {
          const nameLen = buf[p]!;
          const name = new TextDecoder().decode(buf.subarray(p + 1, p + 1 + nameLen));
          p += 1 + nameLen;
          const type = buf[p]!;
          p += 1;
          if (type === 7) {
            const len = view.getUint16(p);
            headers[name] = new TextDecoder().decode(buf.subarray(p + 2, p + 2 + len));
            p += 2 + len;
          } else {
            // Skip non-string headers by type size (bool 0/1: 0 bytes, byte 1, short 2, int 4, long 8, bytes 6/uuid 9/timestamp 8).
            const sizes: Record<number, number> = { 0: 0, 1: 0, 2: 1, 3: 2, 4: 4, 5: 8, 8: 8, 9: 16 };
            if (type === 6) p += 2 + view.getUint16(p);
            else p += sizes[type] ?? 0;
          }
        }
        yield { headers, payload: buf.slice(end, total - 4) };
        buf = buf.slice(total);
      }
      const { value, done } = await reader.read();
      if (done) break;
      const next = new Uint8Array(buf.length + value.length);
      next.set(buf);
      next.set(value, buf.length);
      buf = next;
    }
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

const STOP: Record<string, string> = { end_turn: "stop", stop_sequence: "stop", tool_use: "tool_calls", max_tokens: "length", content_filtered: "content_filter", guardrail_intervened: "content_filter" };

/** Translate ConverseStream events into the loop's KimiEvents. */
export async function* parseConverseStream(body: ReadableStream<Uint8Array>, signal?: AbortSignal): AsyncGenerator<KimiEvent, void, void> {
  const tools = new Map<number, { id: string; name: string; args: string }>();
  const reasoning = new Map<number, { text: string; signature?: string; redacted?: string }>();
  let finishReason: string | null = null;
  let usage: Usage | null = null;
  for await (const msg of readEventStream(body, signal)) {
    const type = msg.headers[":message-type"];
    const event = msg.headers[":event-type"] ?? msg.headers[":exception-type"];
    let data: Record<string, any> = {};
    try {
      data = JSON.parse(new TextDecoder().decode(msg.payload)) as Record<string, any>;
    } catch {
      data = {};
    }
    if (type === "exception" || type === "error") {
      const status = event === "throttlingException" ? 429 : event === "serviceUnavailableException" || event === "internalServerException" ? 503 : undefined;
      throw new KimiApiError(`kimiflare: Bedrock ${event ?? "error"}: ${data.message ?? data.Message ?? "request failed"}`, undefined, status);
    }
    const idx = typeof data.contentBlockIndex === "number" ? data.contentBlockIndex : 0;
    switch (event) {
      case "contentBlockStart": {
        const tu = data.start?.toolUse;
        if (tu) {
          tools.set(idx, { id: tu.toolUseId, name: tu.name, args: "" });
          yield { type: "tool_call_start", index: idx, id: tu.toolUseId, name: tu.name };
        }
        break;
      }
      case "contentBlockDelta": {
        const d = data.delta ?? {};
        if (typeof d.text === "string" && d.text) yield { type: "text", delta: d.text };
        else if (d.toolUse && typeof d.toolUse.input === "string") {
          const t = tools.get(idx);
          if (t) {
            t.args += d.toolUse.input;
            yield { type: "tool_call_args", index: idx, argsDelta: d.toolUse.input };
          }
        } else if (d.reasoningContent) {
          const r = reasoning.get(idx) ?? { text: "" };
          if (typeof d.reasoningContent.text === "string") {
            r.text += d.reasoningContent.text;
            yield { type: "reasoning", delta: d.reasoningContent.text };
          }
          if (typeof d.reasoningContent.signature === "string") r.signature = (r.signature ?? "") + d.reasoningContent.signature;
          if (typeof d.reasoningContent.redactedContent === "string") r.redacted = d.reasoningContent.redactedContent;
          reasoning.set(idx, r);
        }
        break;
      }
      case "contentBlockStop": {
        const r = reasoning.get(idx);
        if (r?.signature) yield { type: "reasoning_details", details: [{ type: "bedrock.reasoning", index: idx, text: r.text, signature: r.signature }] };
        else if (r?.redacted) yield { type: "reasoning_details", details: [{ type: "bedrock.redacted", index: idx, data: r.redacted }] };
        break;
      }
      case "messageStop":
        finishReason = STOP[data.stopReason] ?? data.stopReason ?? null;
        break;
      case "metadata": {
        const u = data.usage ?? {};
        const input = u.inputTokens ?? 0;
        const cacheRead = u.cacheReadInputTokens ?? 0;
        const cacheWrite = u.cacheWriteInputTokens ?? 0;
        usage = {
          prompt_tokens: input + cacheRead + cacheWrite,
          completion_tokens: u.outputTokens ?? 0,
          total_tokens: input + cacheRead + cacheWrite + (u.outputTokens ?? 0),
          prompt_tokens_details: { cached_tokens: cacheRead, cache_write_tokens: cacheWrite },
        };
        yield { type: "usage", usage };
        break;
      }
      default:
        break;
    }
  }
  for (const [index, t] of [...tools.entries()].sort((a, b) => a[0] - b[0])) {
    yield { type: "tool_call_complete", index, id: t.id, name: t.name, arguments: t.args || "{}", finishReason };
  }
  yield { type: "done", finishReason, usage };
}
