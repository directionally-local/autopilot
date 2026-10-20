import { largeBodyWarning, largestBodyParts, shouldWarnLargeBody } from "./request-size.js";
import * as zlib from "node:zlib";
import { readSSE } from "../util/sse.js";
import { KimiApiError } from "../util/errors.js";
import { getUserAgent } from "../util/version.js";
import { jsonReplacer, mergeReasoningDetails, sanitizeString, stableStringify } from "./messages.js";
import type { ChatMessage, ReasoningDetail, ToolDef, Usage } from "./messages.js";
import { sha256Hex } from "../trace/blobs.js";
import type { TraceRecorder } from "../trace/recorder.js";
import { logger } from "../util/logger.js";
import { getLogSessionId, getLogTurnId } from "../util/log-sink.js";
import {
  isLlmDumpEnabled,
  writeLlmDump,
  computeBreakdown,
  type LlmDumpRecord,
  type LlmDumpResponse,
} from "../util/llm-dump.js";
import { getModelOrInfer, vendorOf } from "../models/registry.js";
import { getPreset, keyHeaders, type ProviderCompat, type ProviderPreset } from "../providers/presets.js";
import { ANTHROPIC_VERSION, anthropicHeaders, parseAnthropicStream, toAnthropicRequest } from "./protocols/anthropic.js";
import { copilotRequestHeaders } from "../providers/copilot.js";
import { chatgptAccessToken, chatgptSessionHeaders, NON_RETRYABLE_SHARING_CODES } from "../providers/chatgpt.js";
import { toVertexAnthropicBody, vertexAccessToken, vertexTarget } from "../providers/vertex.js";
import { bedrockAuth, bedrockHeaders, converseUrl, parseConverseStream, toConverseRequest } from "../providers/bedrock.js";

/** "https://bedrock-runtime.us-west-2.amazonaws.com/…" → "us-west-2". */
function bedrockRegionOf(url: string): string {
  return /bedrock-runtime(?:-fips)?\.([a-z0-9-]+)\.amazonaws\.com/.exec(url)?.[1] ?? "us-east-1";
}
import { parseResponsesStream, toResponsesRequest } from "./protocols/responses.js";
import { openRouterHeaders, openRouterUrl, OPENROUTER_KEYS_URL } from "../models/openrouter.js";
import { requestyHeaders, requestyUrl, REQUESTY_KEYS_URL } from "../models/requesty.js";
import { resolveCustomEndpoint, customChatCompletionsUrl, type CustomEndpoint } from "./custom-endpoint.js";
import type { LlmAuth } from "./llm-auth.js";

export type KimiEvent =
  | { type: "response_meta"; meta: ResponseMeta }
  | { type: "reasoning"; delta: string }
  | { type: "reasoning_details"; details: ReasoningDetail[] }
  | { type: "text"; delta: string }
  | { type: "tool_call_start"; index: number; id: string; name: string }
  | { type: "tool_call_args"; index: number; argsDelta: string }
  | { type: "tool_call_complete"; index: number; id: string; name: string; arguments: string; finishReason: string | null; extra?: Record<string, unknown> }
  | { type: "usage"; usage: Usage }
  | { type: "done"; finishReason: string | null; usage: Usage | null };

export interface RunKimiOpts extends LlmAuth {
  model: string;
  messages: ChatMessage[];
  tools?: ToolDef[];
  signal?: AbortSignal;
  temperature?: number;
  maxCompletionTokens?: number;
  reasoningEffort?: "low" | "medium" | "high";
  sessionId?: string;
  requestId?: string;
  /** Abort the stream if no data arrives for this many milliseconds. Default 60000. */
  idleTimeoutMs?: number;
  /** Once the first byte arrives, tighten the idle timeout to this value.
   *  Default 30000 — a live stream stalling mid-flight should surface fast. */
  postFirstByteIdleTimeoutMs?: number;
  /** Session trace recorder; `llm_request` / `llm_response` are emitted on it. No-op when absent or disabled. */
  trace?: TraceRecorder;
  /** Turn id stamped on the trace events of this request. */
  turnId?: string | null;
  /** Called once per session when a request body is large (> 1 MB), naming its biggest parts. */
  onLargeBody?: (warning: string) => void;
}

/**
 * OpenRouter `provider` routing object (subset we pass through). See
 * https://openrouter.ai/docs/guides/routing/provider-selection. Setting
 * `order` or `sort` disables sticky routing (prompt-cache locality) and
 * load balancing, so they're opt-in only.
 */
export interface OpenRouterProviderPrefs {
  order?: string[];
  only?: string[];
  ignore?: string[];
  allow_fallbacks?: boolean;
  require_parameters?: boolean;
  data_collection?: "allow" | "deny";
  zdr?: boolean;
  quantizations?: string[];
  sort?: "price" | "throughput" | "latency";
  max_price?: Record<string, number>;
}

/**
 * Per-response metadata OpenRouter reports in the stream. `generationId` is
 * the key for the authoritative cost lookup (GET /generation?id=…, see
 * usage-tracker.ts); `provider` is the upstream OpenRouter routed to.
 */
export interface ResponseMeta {
  generationId?: string;
  model?: string;
  provider?: string;
}

const MAX_ATTEMPTS = 5;

function isRetryable(err: KimiApiError, attempt: number, openrouter = true): boolean {
  if (attempt >= MAX_ATTEMPTS - 1) return false;
  // ChatGPT token sharing: usage limits and eligibility don't change on retry (even as a 429).
  if (NON_RETRYABLE_SHARING_CODES.some((c) => err.message.includes(c))) return false;
  if (err.httpStatus === 408 || err.httpStatus === 429) return true;
  // OpenRouter's 402 "in-flight budget" is transient (a concurrent request is
  // holding the key's remaining credit); a plain out-of-credits 402 is not.
  if (openrouter && err.httpStatus === 402 && /in.?flight/i.test(err.message)) return true;
  if (err.httpStatus !== undefined && err.httpStatus >= 500 && err.httpStatus < 600) return true;
  if (err.message.includes("Internal server error")) return true;
  return false;
}

export async function* runKimi(opts: RunKimiOpts): AsyncGenerator<KimiEvent, void, void> {
  // Custom endpoint wins over OpenRouter. The env fallback means side-call
  // paths (memory extraction, summarization, …) are rerouted too.
  const customEndpoint = opts.customEndpoint ?? resolveCustomEndpoint();
  const requesty = !customEndpoint && !opts.openrouterApiKey && !!opts.requestyApiKey;
  const requestId = opts.requestId ?? crypto.randomUUID();
  let { url, headers: targetHeaders } = buildKimiRequestTarget(opts, customEndpoint, requesty);
  // Per-model capability gates, from the OpenRouter catalog. OpenRouter drops
  // params a model doesn't support, but a few models reject a supported param
  // outright for non-default values (Kimi K3 only allows temperature=1).
  const entry = getModelOrInfer(opts.model);
  const supportsTemperature = entry.supports.temperature !== false;
  const supportsReasoning = entry.supports.reasoning === true;

  const hasTools = !!opts.tools && opts.tools.length > 0;
  const maxTokens = opts.maxCompletionTokens ?? 16384;
  // Request-shape quirks of the provider this request goes to (presets.ts).
  const preset = getPreset(
    customEndpoint ? (customEndpoint.providerId ?? "custom") : requesty ? "requesty" : "openrouter",
  );
  const body: Record<string, unknown> = {
    model: opts.model,
    messages: sanitizeMessagesForApi(
      normalizeToolIds(stripReasoningEcho(opts.messages, preset.compat, entry.reasoningEchoField), preset.compat.toolIdFormat),
    ),
    stream: true,
  };
  if (customEndpoint || requesty) {
    // Every provider but OpenRouter gets a plain OpenAI-shaped request,
    // adjusted by its preset's compat flags.
    const compat = preset.compat;
    if (hasTools) {
      Object.assign(body, { tools: opts.tools, tool_choice: "auto" });
      if (compat.parallelToolCalls) body.parallel_tool_calls = true;
    }
    if (supportsTemperature) body.temperature = opts.temperature ?? 0.2;
    body[compat.maxTokensField] = maxTokens;
    if (opts.reasoningEffort && supportsReasoning && compat.reasoningEffort && entry.reasoningEfforts?.length !== 0) {
      body.reasoning_effort = effortFor(opts.reasoningEffort, entry.reasoningEfforts);
    }
    // OpenAI's streaming API omits `usage` unless asked; OpenRouter always
    // sends it (and documents this flag as a no-op).
    if (compat.streamUsage) body.stream_options = { include_usage: true };
    if (compat.extraBody) Object.assign(body, compat.extraBody);
  } else {
    // Only send optional parameters the model's endpoints accept. With
    // `require_parameters` (below) a single unsupported parameter would leave
    // no eligible provider and the request 404s — and most models accept
    // e.g. `max_tokens` but not `max_completion_tokens`, or omit
    // `parallel_tool_calls`. For a model we have no parameter list for, send
    // only the near-universal ones and skip require_parameters.
    const known = entry.parameters ? new Set(entry.parameters) : null;
    const accepts = (p: string) => (known ? known.has(p) : p === "tools" || p === "max_tokens" || p === "temperature");
    if (hasTools) {
      body.tools = opts.tools;
      if (accepts("tool_choice")) body.tool_choice = "auto";
      if (accepts("parallel_tool_calls")) body.parallel_tool_calls = true;
    }
    if (supportsTemperature && accepts("temperature")) body.temperature = opts.temperature ?? 0.2;
    if (accepts("max_completion_tokens")) body.max_completion_tokens = maxTokens;
    else if (accepts("max_tokens")) body.max_tokens = maxTokens;
    if (opts.reasoningEffort && supportsReasoning) {
      if (accepts("reasoning_effort")) body.reasoning_effort = opts.reasoningEffort;
      else if (accepts("reasoning")) body.reasoning = { effort: opts.reasoningEffort };
    }

    // Sticky routing: OpenRouter pins a session to the provider that served
    // it, so the prompt-prefix cache stays warm across turns (10 min idle
    // window). Without it OpenRouter hashes the first system + user message,
    // which also works but can't tell two sessions with the same opener apart.
    if (opts.sessionId) body.session_id = opts.sessionId.slice(0, 256);
    // Only route to providers that support every parameter we send — above
    // all `tools`: a few endpoints for some models serve the model without
    // tool calling, and a coding agent is useless there. Tool-calling quality
    // ordering (Auto Exacto) is applied by OpenRouter on top of this. Skipped
    // when the model's parameter list is unknown (we can't guarantee a match).
    const provider = { ...(known ? { require_parameters: true } : {}), ...(opts.openrouterRouting ?? {}) };
    if (Object.keys(provider).length > 0) body.provider = provider;
    // Anthropic models only cache with explicit breakpoints; the top-level
    // directive makes OpenRouter place them automatically. Everyone else
    // kimiflare defaults to (Moonshot, DeepSeek, Z.AI, OpenAI, …) caches
    // implicitly.
    if (vendorOf(opts.model) === "anthropic") body.cache_control = { type: "ephemeral" };
  }

  // The wire body: Chat Completions as built above, or converted for
  // providers that speak another protocol (src/agent/protocols/).
  // A model's catalog entry can pick the protocol (Copilot serves Claude over
  // Messages and GPT-5 over Responses from one account); Vertex routes Claude
  // to Anthropic's Messages API by model name.
  const vertex = customEndpoint?.providerId === "vertex" ? vertexTarget(customEndpoint.baseUrl.replace(/\/+$/, ""), opts.model) : null;
  const protocol = vertex?.protocol ?? (customEndpoint ? (entry.protocol ?? preset.protocol ?? "openai-chat") : "openai-chat");
  let wireBody: Record<string, unknown> =
    protocol === "anthropic-messages"
      ? toAnthropicRequest({
          model: opts.model,
          messages: body.messages as ChatMessage[],
          tools: hasTools ? opts.tools : undefined,
          maxTokens,
          temperature: opts.temperature,
          reasoningEffort: opts.reasoningEffort,
          supportsReasoning,
          supportsTemperature,
          reasoningEfforts: entry.reasoningEfforts,
          reasoningBudget: entry.reasoningBudget,
        })
      : protocol === "bedrock-converse"
        ? toConverseRequest({
            model: opts.model,
            messages: body.messages as ChatMessage[],
            tools: hasTools ? opts.tools : undefined,
            maxTokens,
            temperature: opts.temperature,
            reasoningEffort: opts.reasoningEffort,
            supportsReasoning,
            supportsTemperature,
          })
      : protocol === "openai-responses"
        ? toResponsesRequest({
            model: opts.model,
            messages: body.messages as ChatMessage[],
            tools: hasTools ? opts.tools : undefined,
            maxTokens,
            temperature: opts.temperature,
            reasoningEffort: opts.reasoningEffort,
            supportsReasoning,
            supportsTemperature,
            reasoningEfforts: entry.reasoningEfforts,
            parallelToolCalls: preset.compat.parallelToolCalls,
          })
        : body;

  if (customEndpoint && preset.id === "copilot") {
    // Copilot routes by endpoint and needs its own headers per request.
    const base = customEndpoint.baseUrl.replace(/\/+$/, "");
    url = protocol === "anthropic-messages" ? `${base}/v1/messages` : protocol === "openai-responses" ? `${base}/responses` : `${base}/chat/completions`;
    targetHeaders = {
      ...copilotRequestHeaders(customEndpoint.apiKey, wireBody, protocol),
      ...(protocol === "anthropic-messages" ? { "anthropic-version": ANTHROPIC_VERSION, "anthropic-beta": "interleaved-thinking-2025-05-14" } : {}),
    };
  }

  // Bedrock: the model is in the URL; SigV4 headers are computed per attempt (they cover the body and time).
  const bedrock = customEndpoint?.providerId === "bedrock" ? bedrockAuth() : undefined;
  if (customEndpoint?.providerId === "bedrock") {
    url = converseUrl(customEndpoint.baseUrl, opts.model);
    targetHeaders = {};
    if (!bedrock) {
      throw new KimiApiError(
        "kimiflare: no AWS credentials for Bedrock — set AWS_BEARER_TOKEN_BEDROCK, or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or configure ~/.aws/credentials.",
        undefined,
        401,
      );
    }
  }

  if (vertex) {
    url = vertex.url;
    if (protocol === "anthropic-messages") wireBody = toVertexAnthropicBody(wireBody);
    else if (vertex.bodyModel) wireBody = { ...wireBody, model: vertex.bodyModel };
    targetHeaders = {
      Authorization: `Bearer ${await vertexAccessToken()}`,
      ...(protocol === "anthropic-messages" ? { "anthropic-version": ANTHROPIC_VERSION } : {}),
    };
  }

  if (customEndpoint?.providerId === "chatgpt") {
    // A fresh token (refreshed shortly before expiry) and the Codex session headers.
    const token = (await chatgptAccessToken()) ?? customEndpoint.apiKey;
    targetHeaders = { ...targetHeaders, ...(token ? { Authorization: `Bearer ${token}` } : {}), ...chatgptSessionHeaders(opts.sessionId) };
  }

  // Observers of the finalized request body: the debug payload dump
  // (KIMIFLARE_DUMP_LLM=1) and the session trace. Both read the body
  // immediately before fetch — they cannot alter what is sent — and share
  // one capture so the trace sees exactly what the dump sees.
  const dumpEnabled = isLlmDumpEnabled();
  const trace = opts.trace?.enabled ? opts.trace : null;
  const captured = dumpEnabled || trace ? captureRequest(body) : null;
  const response: LlmDumpResponse = {
    text: "",
    reasoning: "",
    reasoningDetails: [],
    toolCalls: [],
    finishReason: null,
    usage: null,
  };
  let dumpRecord: LlmDumpRecord | null = null;
  if (dumpEnabled && captured) {
    dumpRecord = {
      meta: {
        requestId,
        sessionId: opts.sessionId ?? getLogSessionId(),
        turnId: opts.turnId ?? getLogTurnId(),
        model: opts.model,
        url,
        ts: new Date().toISOString(),
      },
      request: {
        system: captured.messages.filter((m) => m.role === "system"),
        messages: captured.messages,
        tools: captured.tools,
        params: captured.params,
        rawSerialized: captured.rawSerialized,
      },
      breakdown: captured.breakdown,
      response,
    };
  }
  // Serialized once: the body is the same on every retry, and its size matters —
  // it is uploaded in full on every call, and on a slow uplink upload time
  // dominates "time to first byte" (#826).
  const serialized = stableStringify(wireBody, jsonReplacer);
  const bodyBytes = Buffer.byteLength(serialized, "utf8");
  /** Per attempt: response headers (≈ upload + provider queueing) and first streamed event. */
  const timing: { headersMs?: number; firstTokenMs?: number } = {};
  const traceRequest = (attempt: number): void => {
    if (!trace || !captured) return;
    trace.emit(
      "llm_request",
      {
        request_id: requestId,
        attempt,
        model: opts.model,
        params: captured.params,
        request_blob: trace.blob(captured.rawSerialized) ?? "",
        messages_sha: captured.messagesSha,
        tools_sha: captured.toolsSha,
        estimated_tokens: captured.breakdown.estTokens,
        body_bytes: bodyBytes,
      },
      opts.turnId ?? null,
    );
  };
  const traceResponse = (startedAt: number, error?: string): void => {
    if (!trace) return;
    const usage = response.usage;
    trace.emit(
      "llm_response",
      {
        request_id: requestId,
        text_blob: trace.blob(response.text) ?? "",
        ...(response.reasoning ? { reasoning_blob: trace.blob(response.reasoning) ?? "" } : {}),
        ...(response.reasoningDetails.length ? { reasoning_details: response.reasoningDetails } : {}),
        tool_calls: response.toolCalls.map((tc) => ({ id: tc.id, name: tc.name, arguments: tc.arguments })),
        finish_reason: response.finishReason,
        ...(usage
          ? {
              usage: {
                prompt_tokens: usage.prompt_tokens,
                completion_tokens: usage.completion_tokens,
                ...(usage.prompt_tokens_details?.cached_tokens !== undefined
                  ? { cached_tokens: usage.prompt_tokens_details.cached_tokens ?? undefined }
                  : {}),
                ...(usage.cost !== undefined ? { cost: usage.cost } : {}),
              },
            }
          : {}),
        ...(response.generationId ? { generation_id: response.generationId } : {}),
        latency_ms: Math.round(performance.now() - startedAt),
        ...(timing.headersMs !== undefined ? { headers_ms: timing.headersMs } : {}),
        ...(timing.firstTokenMs !== undefined ? { first_token_ms: timing.firstTokenMs } : {}),
        aborted: opts.signal?.aborted === true,
        ...(error !== undefined ? { error } : {}),
      },
      opts.turnId ?? null,
    );
  };

  logger.debug("runKimi:request", { requestId, attempt: 0, model: opts.model, body_bytes: bodyBytes });
  if (opts.onLargeBody && shouldWarnLargeBody(opts.sessionId ?? getLogSessionId() ?? "default", bodyBytes)) {
    opts.onLargeBody(largeBodyWarning(bodyBytes, largestBodyParts(body.messages as ChatMessage[])));
  }
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let res: Response;
    const attemptStartedAt = performance.now();
    timing.headersMs = undefined;
    timing.firstTokenMs = undefined;
    traceRequest(attempt);
    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "User-Agent": getUserAgent(),
        ...targetHeaders,
      };
      if (opts.sessionId) headers["X-Session-ID"] = opts.sessionId;
      headers["X-Request-ID"] = requestId;
      if (bedrock) Object.assign(headers, bedrockHeaders(bedrock, url, serialized, bedrockRegionOf(url)));
      res = await fetch(url, {
        method: "POST",
        headers,
        body: customEndpoint?.providerId === "chatgpt" ? compressLargeBody(serialized, headers) : serialized,
        signal: opts.signal,
      });
    } catch (fetchErr) {
      const msg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
      traceResponse(attemptStartedAt, msg);
      if (isAbortError(fetchErr)) throw fetchErr;
      logger.warn("runKimi:fetch_error", { requestId, attempt, error: msg });
      if (attempt < MAX_ATTEMPTS - 1) {
        const delay = Math.random() * (500 * 2 ** attempt);
        await sleep(delay, opts.signal);
        continue;
      }
      const local = customEndpoint?.providerId && !preset.keyRequired;
      throw new KimiApiError(
        `kimiflare: network error: ${msg}` +
          (local ? `\n\nIs ${preset.name} running at ${customEndpoint!.baseUrl}? Start it, or set providers.${preset.id}.baseUrl in config.` : ""),
        undefined,
        undefined,
      );
    }

    timing.headersMs = Math.round(performance.now() - attemptStartedAt);
    logger.debug("runKimi:headers", { requestId, attempt, status: res.status, headers_ms: timing.headersMs, body_bytes: bodyBytes });
    const contentType = res.headers.get("content-type") ?? "";

    // Errors come back as JSON (not SSE): OpenRouter's { error: { code,
    // message } } or an OpenAI-style error from a custom endpoint. Retry the
    // transient ones (408/429/5xx); surface everything else with a fix.
    // Bedrock streams AWS's binary event stream, not SSE.
    const streaming = protocol === "bedrock-converse" ? res.ok && contentType.includes("eventstream") : contentType.includes("text/event-stream");
    if (!streaming) {
      if (res.bodyUsed) {
        throw new KimiApiError(
          `kimiflare: Received HTTP ${res.status} but could not read the response body. Please try again.`,
          undefined,
          res.status,
        );
      }
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* ignore */
      }
      const err = extractApiError(parsed, text);
      const msg = err?.message ?? `HTTP ${res.status}: ${text.slice(0, 300)}`;
      const status = err?.status ?? res.status;
      const apiErr = new KimiApiError(
        `kimiflare: ${describeHttpError(opts.model, status, msg, customEndpoint, requesty)}`,
        err?.code,
        status,
      );
      traceResponse(attemptStartedAt, apiErr.message);
      if (isRetryable(apiErr, attempt, !customEndpoint && !requesty)) {
        const isRateLimit = apiErr.httpStatus === 429;
        const baseDelay = isRateLimit ? 2000 : 500;
        // OpenRouter sends Retry-After (seconds) on 429/503; honour it, capped
        // so a long server hint can't wedge an interactive turn.
        const retryAfterSec = Number(res.headers.get("retry-after"));
        const delay =
          Number.isFinite(retryAfterSec) && retryAfterSec > 0
            ? Math.min(retryAfterSec * 1000, 30_000)
            : Math.random() * (baseDelay * 2 ** attempt);
        logger.warn("runKimi:retrying", { requestId, attempt, code: apiErr.code, httpStatus: apiErr.httpStatus, delay });
        await sleep(delay, opts.signal);
        continue;
      }
      throw apiErr;
    }

    if (!res.body) {
      const emptyErr = new KimiApiError("kimiflare: empty response body", undefined, res.status);
      traceResponse(attemptStartedAt, emptyErr.message);
      throw emptyErr;
    }

    logger.debug("runKimi:stream_start", { requestId });
    let streamError: string | undefined;
    try {
      const events =
        protocol === "anthropic-messages"
          ? parseAnthropicStream(res.body, opts.signal, opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, opts.postFirstByteIdleTimeoutMs ?? DEFAULT_POST_FIRST_BYTE_IDLE_TIMEOUT_MS)
          : protocol === "bedrock-converse"
            ? parseConverseStream(res.body, opts.signal)
          : protocol === "openai-responses"
            ? parseResponsesStream(res.body, opts.signal, opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS, opts.postFirstByteIdleTimeoutMs ?? DEFAULT_POST_FIRST_BYTE_IDLE_TIMEOUT_MS)
            : parseStream(res.body, opts.signal, opts.idleTimeoutMs, opts.postFirstByteIdleTimeoutMs, customEndpoint ? preset.compat.thinkTags === true : false);
      for await (const ev of events) {
        if (timing.firstTokenMs === undefined && ev.type !== "response_meta") {
          timing.firstTokenMs = Math.round(performance.now() - attemptStartedAt);
          logger.debug("runKimi:first_token", { requestId, attempt, first_token_ms: timing.firstTokenMs, headers_ms: timing.headersMs });
        }
        if (captured) accumulateDumpResponse(response, ev);
        yield ev;
      }
    } catch (streamErr) {
      streamError = streamErr instanceof Error ? streamErr.message : String(streamErr);
      throw streamErr;
    } finally {
      // Write even on abort/error so partial turns are still captured.
      if (dumpRecord) {
        dumpRecord.meta.attempt = attempt;
        writeLlmDump(dumpRecord);
      }
      traceResponse(attemptStartedAt, streamError);
    }
    logger.debug("runKimi:stream_end", { requestId });
    return;
  }
}

/**
 * ChatGPT token sharing rejects uncompressed request bodies over ~1 MiB and
 * accepts zstd. Compress large bodies when this Node has zstd (22.15+);
 * otherwise send them as they are.
 */
export function compressLargeBody(serialized: string, headers: Record<string, string>, threshold = 512 * 1024): string | Uint8Array<ArrayBuffer> {
  const zstd = (zlib as { zstdCompressSync?: (b: Buffer) => Buffer }).zstdCompressSync;
  if (Buffer.byteLength(serialized) < threshold || !zstd) return serialized;
  headers["Content-Encoding"] = "zstd";
  const compressed = zstd(Buffer.from(serialized));
  const out = new Uint8Array(new ArrayBuffer(compressed.byteLength));
  out.set(compressed);
  return out;
}

function isAbortError(e: unknown): boolean {
  return e instanceof DOMException && e.name === "AbortError";
}

/**
 * Turn an HTTP error into the message the user sees, with the concrete fix
 * for the cases that have one (bad key, no credits, unknown model).
 */
function describeHttpError(
  model: string,
  status: number,
  msg: string,
  customEndpoint: CustomEndpoint | null,
  requesty = false,
): string {
  if (customEndpoint?.providerId) return describePresetHttpError(getPreset(customEndpoint.providerId), model, status, msg);
  if (customEndpoint) {
    if (status === 401 || status === 403) {
      return [
        `${model} rejected the request (HTTP ${status}): ${msg || "authentication failed"}.`,
        ``,
        `Check that KIMIFLARE_API_KEY (or \`apiKey\` in config) matches what ${customEndpoint.baseUrl} expects.`,
      ].join("\n");
    }
    return msg;
  }
  if (requesty) return describeRequestyHttpError(model, status, msg);
  if (status === 401) {
    return [
      `OpenRouter rejected your API key (HTTP 401): ${msg || "invalid key"}.`,
      ``,
      `Fix: run  /key set <your-key>  with a key from ${OPENROUTER_KEYS_URL}`,
      `(or set OPENROUTER_API_KEY in the environment).`,
    ].join("\n");
  }
  if (status === 402) {
    return [
      `Your OpenRouter account is out of credits (HTTP 402): ${msg}.`,
      ``,
      `Add credits at https://openrouter.ai/settings/credits, or pick a free model with  /model  (look for the "Free" section).`,
    ].join("\n");
  }
  if (status === 403) {
    return [
      `OpenRouter refused the request (HTTP 403): ${msg}.`,
      ``,
      `This is usually a moderation or guardrail block on the key, or a model your account can't access.`,
    ].join("\n");
  }
  if (status === 404 && /model|endpoint/i.test(msg)) {
    return [
      `OpenRouter can't serve ${model} (HTTP 404): ${msg}.`,
      ``,
      `Pick another model with  /model .`,
    ].join("\n");
  }
  return msg;
}

/** Error text for a preset provider (OpenAI, DeepSeek, Ollama, …): its name, key env var and console. */
function describePresetHttpError(preset: ProviderPreset, model: string, status: number, msg: string): string {
  const keyHint = `Fix: run  /key set <key>  with a key from ${preset.keysUrl ?? `your ${preset.name} account`}` +
    (preset.apiKeyEnv[0] ? ` (or set ${preset.apiKeyEnv[0]} in the environment).` : ".");
  if (status === 401 || status === 403) {
    return [`${preset.name} rejected the request (HTTP ${status}): ${msg || "invalid key"}.`, ``, keyHint].join("\n");
  }
  if (status === 402) {
    return [`Your ${preset.name} account is out of credit (HTTP 402): ${msg}.`, ``, `Add credit in your ${preset.name} account, then retry.`].join("\n");
  }
  if (status === 404 && /model/i.test(msg)) {
    return [`${preset.name} can't serve ${model} (HTTP 404): ${msg}.`, ``, `Pick another model with  /model .`].join("\n");
  }
  return msg;
}

function describeRequestyHttpError(model: string, status: number, msg: string): string {
  if (status === 401 || status === 403) {
    return [
      `Requesty refused the request (HTTP ${status}): ${msg || "invalid key"}.`,
      ``,
      `Check REQUESTY_API_KEY (or \`requestyApiKey\` in config); create a key at ${REQUESTY_KEYS_URL}.`,
      `A 403 can also mean ${model} is not approved for your Requesty organization.`,
    ].join("\n");
  }
  if (status === 402) {
    return [
      `Your Requesty balance is exhausted (HTTP 402): ${msg}.`,
      ``,
      `Add credits at https://app.requesty.ai, then retry.`,
    ].join("\n");
  }
  if (status === 404) {
    return [
      `Requesty can't serve ${model} (HTTP 404): ${msg}.`,
      ``,
      `Pick another model with  /model .`,
    ].join("\n");
  }
  return msg;
}

/** The finalized request body as observed right before fetch, shared by the
 *  debug dump and the session trace. */
interface CapturedRequest {
  messages: ChatMessage[];
  tools: ToolDef[];
  params: Record<string, unknown>;
  rawSerialized: string;
  messagesSha: string;
  toolsSha: string;
  breakdown: ReturnType<typeof computeBreakdown>;
}

function captureRequest(body: Record<string, unknown>): CapturedRequest {
  const messages = body.messages as ChatMessage[];
  const tools = (body.tools as ToolDef[] | undefined) ?? [];
  const { messages: _m, tools: _t, ...params } = body;
  return {
    messages,
    tools,
    params,
    rawSerialized: stableStringify(body, jsonReplacer),
    messagesSha: sha256Hex(stableStringify(messages, jsonReplacer)),
    toolsSha: sha256Hex(stableStringify(tools, jsonReplacer)),
    breakdown: computeBreakdown(messages, tools),
  };
}

/** Fold a streamed event into the response accumulator shared by the debug
 *  dump and the session trace. Read-only side-effect — never affects the
 *  yielded stream. Only invoked when one of the two observers is enabled. */
function accumulateDumpResponse(resp: LlmDumpResponse, ev: KimiEvent): void {
  switch (ev.type) {
    case "response_meta":
      if (ev.meta.generationId) resp.generationId = ev.meta.generationId;
      break;
    case "text":
      resp.text += ev.delta;
      break;
    case "reasoning":
      resp.reasoning += ev.delta;
      break;
    case "reasoning_details":
      resp.reasoningDetails = mergeReasoningDetails(resp.reasoningDetails, ev.details);
      break;
    case "tool_call_complete":
      resp.toolCalls.push({ id: ev.id, name: ev.name, arguments: ev.arguments });
      break;
    case "usage":
      resp.usage = ev.usage;
      break;
    case "done":
      resp.finishReason = ev.finishReason;
      if (ev.usage) resp.usage = ev.usage;
      break;
  }
}

/** Validate that a model id is OpenRouter-shaped before it goes on the wire.
 *
 *  Accepted: "<vendor>/<model>[:variant]", optionally with OpenRouter's "~"
 *  alias prefix — e.g. "moonshotai/kimi-k2.6", "deepseek/deepseek-r1:free",
 *  "~moonshotai/kimi-latest", "openrouter/auto". Vendor must be
 *  alnum/-/_; the model segment may contain ./-/_ but no slashes or
 *  whitespace. */
export function validateModelId(model: string): void {
  if (!model) throw new KimiApiError(`Invalid model ID: ${model}`, 400);
  if (/^~?[a-zA-Z0-9_-]+\/[a-zA-Z0-9._-]+(:[a-zA-Z0-9._-]+)?$/.test(model)) return;
  throw new KimiApiError(`Invalid model ID: ${model}`, 400);
}

function buildKimiRequestTarget(
  opts: RunKimiOpts,
  customEndpoint: CustomEndpoint | null,
  requesty: boolean,
): { url: string; headers: Record<string, string> } {
  // Custom OpenAI-compatible endpoint: the host app owns routing and auth.
  // The model id only rides in the JSON body on this path, so any non-empty
  // id passes through.
  if (customEndpoint) {
    if (!opts.model) throw new KimiApiError(`Invalid model ID: ${opts.model}`, 400);
    const protocol = customEndpoint.providerId ? getPreset(customEndpoint.providerId).protocol : undefined;
    const base = customEndpoint.baseUrl.replace(/\/+$/, "");
    if (protocol === "anthropic-messages") return { url: `${base}/messages`, headers: anthropicHeaders(customEndpoint.apiKey) };
    if (protocol === "openai-responses") {
      return { url: `${base}/responses`, headers: keyHeaders(customEndpoint.providerId, customEndpoint.apiKey) };
    }
    return {
      url: customChatCompletionsUrl(customEndpoint.baseUrl),
      headers: {
        ...(customEndpoint.providerId ? getPreset(customEndpoint.providerId).compat.headers : {}),
        ...keyHeaders(customEndpoint.providerId, customEndpoint.apiKey),
      },
    };
  }

  // Requesty managed policy ids ("claude-sonnet-4-5") have no vendor
  // prefix, so only the OpenRouter id shape is validated.
  if (requesty && opts.requestyApiKey) {
    if (!opts.model) throw new KimiApiError(`Invalid model ID: ${opts.model}`, 400);
    return {
      url: requestyUrl("chat/completions"),
      headers: requestyHeaders(opts.requestyApiKey),
    };
  }

  validateModelId(opts.model);
  if (!opts.openrouterApiKey) {
    throw new KimiApiError(
      [
        `kimiflare: no OpenRouter API key configured.`,
        ``,
        `Fix: run  /key set <your-key>  with a key from ${OPENROUTER_KEYS_URL}`,
        `(or set OPENROUTER_API_KEY in the environment).`,
      ].join("\n"),
      undefined,
      401,
    );
  }
  return {
    url: openRouterUrl("chat/completions"),
    headers: openRouterHeaders(opts.openrouterApiKey),
  };
}

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_POST_FIRST_BYTE_IDLE_TIMEOUT_MS = 30_000;

/**
 * Splits `<think>…</think>` out of streamed content into reasoning, for
 * models that inline their reasoning. Tags may be cut across chunks, so a
 * possible partial tag at the end of a chunk is held back until the next.
 */
export class ThinkTagSplitter {
  private inThink = false;
  private held = "";

  push(chunk: string): Array<{ kind: "text" | "reasoning"; text: string }> {
    const out: Array<{ kind: "text" | "reasoning"; text: string }> = [];
    let s = this.held + chunk;
    this.held = "";
    for (;;) {
      const tag = this.inThink ? "</think>" : "<think>";
      const kind = this.inThink ? "reasoning" : "text";
      const at = s.indexOf(tag);
      if (at >= 0) {
        if (at > 0) out.push({ kind, text: s.slice(0, at) });
        s = s.slice(at + tag.length);
        this.inThink = !this.inThink;
        continue;
      }
      // Hold back a suffix that could be the start of the tag.
      let keep = 0;
      for (let n = Math.min(tag.length - 1, s.length); n > 0; n--) {
        if (tag.startsWith(s.slice(-n))) {
          keep = n;
          break;
        }
      }
      const emit = s.slice(0, s.length - keep);
      if (emit) out.push({ kind, text: emit });
      this.held = s.slice(s.length - keep);
      return out;
    }
  }

  flush(): Array<{ kind: "text" | "reasoning"; text: string }> {
    const rest = this.held;
    this.held = "";
    return rest ? [{ kind: this.inThink ? "reasoning" : "text", text: rest }] : [];
  }
}

async function* parseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
  idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
  postFirstByteIdleTimeoutMs = DEFAULT_POST_FIRST_BYTE_IDLE_TIMEOUT_MS,
  thinkTags = false,
): AsyncGenerator<KimiEvent, void, void> {
  const splitter = thinkTags ? new ThinkTagSplitter() : null;
  const toolCalls = new Map<number, { id: string; name: string; args: string; extra?: Record<string, unknown> }>();
  let lastUsage: Usage | null = null;
  let finishReason: string | null = null;
  let metaSent = false;

  for await (const dataStr of readSSE(body, signal, idleTimeoutMs, postFirstByteIdleTimeoutMs)) {
    if (dataStr === "[DONE]") break;
    let chunk: StreamChunk | null = null;
    try {
      chunk = JSON.parse(dataStr);
    } catch {
      continue;
    }
    if (!chunk) continue;

    // A failure after the stream has started (upstream provider died
    // mid-generation) arrives as a chunk carrying `error`, not an HTTP status.
    if (chunk.error) {
      const code = typeof chunk.error.code === "number" ? chunk.error.code : undefined;
      throw new KimiApiError(
        `kimiflare: ${chunk.error.message ?? "the model provider failed mid-response"}`,
        undefined,
        code,
      );
    }

    // Every OpenRouter chunk carries the generation id; report it once.
    if (!metaSent && typeof chunk.id === "string" && chunk.id) {
      metaSent = true;
      yield {
        type: "response_meta",
        meta: {
          generationId: chunk.id,
          ...(typeof chunk.model === "string" ? { model: chunk.model } : {}),
          ...(typeof chunk.provider === "string" ? { provider: chunk.provider } : {}),
        },
      };
    }

    if (chunk.usage) {
      lastUsage = normalizeUsage(chunk.usage);
      yield { type: "usage", usage: lastUsage };
    }

    // OpenAI-compatible format: { choices: [{ delta: { content: "..." } }] }
    const choice = chunk.choices?.[0];
    if (choice) {
      const d = choice.delta;
      if (d) {
        // OpenRouter streams reasoning as `reasoning`; OpenAI-compatible
        // custom endpoints (vLLM, Moonshot-style) use `reasoning_content`.
        const reasoningDelta = d.reasoning ?? d.reasoning_content;
        if (typeof reasoningDelta === "string" && reasoningDelta.length) {
          yield { type: "reasoning", delta: reasoningDelta };
        }
        // Structured reasoning (Claude signatures, OpenAI/Gemini encrypted
        // blocks). Must be echoed back verbatim during tool use; the loop
        // merges these by `index` (see mergeReasoningDetails in messages.ts).
        if (Array.isArray(d.reasoning_details) && d.reasoning_details.length) {
          yield { type: "reasoning_details", details: d.reasoning_details };
        }
        if (typeof d.content === "string" && d.content.length) {
          if (splitter) {
            for (const part of splitter.push(d.content)) {
              yield part.kind === "text" ? { type: "text", delta: part.text } : { type: "reasoning", delta: part.text };
            }
          } else {
            yield { type: "text", delta: d.content };
          }
        }
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = typeof tc.index === "number" ? tc.index : 0;
            let buf = toolCalls.get(idx);
            const incomingName = tc.function?.name ?? null;
            const incomingId = tc.id ?? null;
            if (!buf) {
              buf = { id: incomingId ?? `tc_${idx}`, name: incomingName ?? "", args: "" };
              toolCalls.set(idx, buf);
              if (buf.name) {
                yield { type: "tool_call_start", index: idx, id: buf.id, name: buf.name };
              }
            } else {
              if (!buf.name && incomingName) {
                buf.name = incomingName;
                yield { type: "tool_call_start", index: idx, id: buf.id, name: buf.name };
              }
              if (buf.id.startsWith("tc_") && incomingId) buf.id = incomingId;
            }
            // Gemini's thought signature arrives on the call as extra_content.
            if (tc.extra_content && typeof tc.extra_content === "object") buf.extra = { ...buf.extra, ...tc.extra_content };
            const argDelta = tc.function?.arguments;
            if (typeof argDelta === "string" && argDelta.length) {
              buf.args += argDelta;
              yield { type: "tool_call_args", index: idx, argsDelta: argDelta };
            }
          }
        }
      }

      if (choice.finish_reason) finishReason = choice.finish_reason;
    }
  }

  for (const part of splitter?.flush() ?? []) {
    yield part.kind === "text" ? { type: "text", delta: part.text } : { type: "reasoning", delta: part.text };
  }

  for (const [idx, buf] of [...toolCalls.entries()].sort((a, b) => a[0] - b[0])) {
    if (!buf.name) continue;
    yield {
      type: "tool_call_complete",
      index: idx,
      id: buf.id,
      name: buf.name,
      arguments: buf.args,
      finishReason,
      ...(buf.extra ? { extra: buf.extra } : {}),
    };
  }

  yield { type: "done", finishReason, usage: lastUsage };
}

interface StreamChunk {
  id?: string;
  model?: string;
  provider?: string;
  choices?: StreamChoice[];
  usage?: Usage;
  error?: { code?: number | string; message?: string };
}
interface StreamChoice {
  delta?: StreamDelta;
  finish_reason?: string | null;
  index?: number;
}
interface StreamDelta {
  role?: string | null;
  content?: string | null;
  reasoning?: string | null;
  reasoning_content?: string | null;
  reasoning_details?: ReasoningDetail[];
  tool_calls?: StreamToolCall[];
}
interface StreamToolCall {
  index?: number;
  id?: string | null;
  type?: string | null;
  function?: { name?: string | null; arguments?: string | null };
  extra_content?: Record<string, unknown>;
}

/** Effort levels from least to most, as models.dev names them. */
const EFFORT_ORDER = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * Map the user's /reasoning level onto the levels a model accepts (models.dev
 * `reasoning_options`): the level itself if allowed, else the nearest allowed
 * level above it, else the highest one. DeepSeek, for one, has no "medium".
 */
export function effortFor(level: "low" | "medium" | "high", allowed: string[] | undefined): string {
  if (!allowed || allowed.length === 0 || allowed.includes(level)) return level;
  const rank = (l: string) => EFFORT_ORDER.indexOf(l);
  const sorted = allowed.filter((l) => rank(l) >= 0).sort((a, b) => rank(a) - rank(b));
  return sorted.find((l) => rank(l) >= rank(level) && l !== "none") ?? sorted[sorted.length - 1] ?? level;
}

/**
 * Drop reasoning fields the provider doesn't accept back on assistant
 * history. OpenRouter's `reasoning_details` only goes to OpenRouter; the
 * `reasoning_content` echo goes to providers that need it during tool loops
 * (DeepSeek, Kimi, Z.ai) or whose model declares it (models.dev `interleaved`).
 */
export function stripReasoningEcho(messages: ChatMessage[], compat: ProviderCompat, modelEchoField?: string): ChatMessage[] {
  const keepContent = compat.reasoningEcho.content || modelEchoField === "reasoning_content";
  const keepDetails = compat.reasoningEcho.details;
  const keepExtras = compat.toolCallExtras === true;
  return messages.map((m) => {
    if (m.role !== "assistant") return m;
    const hasExtras = !keepExtras && (m.tool_calls ?? []).some((tc) => tc.extra_content !== undefined);
    if (!hasExtras && (keepContent || m.reasoning_content === undefined) && (keepDetails || m.reasoning_details === undefined)) return m;
    const { reasoning_content, reasoning_details, ...rest } = m;
    return {
      ...rest,
      ...(keepContent && reasoning_content !== undefined ? { reasoning_content } : {}),
      ...(keepDetails && reasoning_details !== undefined ? { reasoning_details } : {}),
      ...(hasExtras ? { tool_calls: m.tool_calls!.map(({ extra_content: _drop, ...tc }) => tc) } : {}),
    };
  });
}

/**
 * Rewrite tool-call ids into the format a provider enforces. Mistral accepts
 * only exactly nine alphanumerics; ids from other providers ("call_…",
 * "toolu_…") are hashed to nine characters, the same way for a call and its
 * result, with collisions resolved. Ids already in the format are kept.
 */
export function normalizeToolIds(messages: ChatMessage[], format: "mistral" | undefined): ChatMessage[] {
  if (format !== "mistral") return messages;
  const ALPHA = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const map = new Map<string, string>();
  const used = new Set<string>();
  const toMistral = (id: string): string => {
    const known = map.get(id);
    if (known) return known;
    let out: string;
    if (/^[A-Za-z0-9]{9}$/.test(id) && !used.has(id)) out = id;
    else {
      let h = 2166136261;
      for (let salt = 0; ; salt++) {
        for (const ch of `${id}#${salt}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
        let n = h;
        let s = "";
        for (let i = 0; i < 9; i++) {
          s += ALPHA[n % 62];
          n = Math.imul(n, 31) + 7 + i >>> 0;
        }
        if (!used.has(s)) {
          out = s;
          break;
        }
      }
    }
    map.set(id, out!);
    used.add(out!);
    return out!;
  };
  return messages.map((m) => {
    if (m.role === "assistant" && m.tool_calls?.length) return { ...m, tool_calls: m.tool_calls.map((tc) => ({ ...tc, id: toMistral(tc.id) })) };
    if (m.role === "tool" && m.tool_call_id) return { ...m, tool_call_id: toMistral(m.tool_call_id) };
    return m;
  });
}

/**
 * Fill `prompt_tokens_details.cached_tokens` from providers that report
 * cache hits elsewhere: DeepSeek's `prompt_cache_hit_tokens`, Moonshot's
 * top-level `cached_tokens`. Cost and the status bar read the one field.
 */
export function normalizeUsage(usage: Usage): Usage {
  if (typeof usage.prompt_tokens_details?.cached_tokens === "number") return usage;
  const u = usage as Usage & { prompt_cache_hit_tokens?: number; cached_tokens?: number };
  const cached = typeof u.prompt_cache_hit_tokens === "number" ? u.prompt_cache_hit_tokens : u.cached_tokens;
  if (typeof cached !== "number") return usage;
  return { ...usage, prompt_tokens_details: { ...(usage.prompt_tokens_details ?? {}), cached_tokens: cached } };
}

function sanitizeMessagesForApi(messages: ChatMessage[]): ChatMessage[] {
  return messages.map((m) => {
    let next: ChatMessage = m;
    if (Array.isArray(m.content)) {
      next = {
        ...m,
        content: m.content.map((part) =>
          part.type === "text" ? { ...part, text: sanitizeString(part.text) } : part,
        ),
      };
    }
    if (!next.tool_calls || next.tool_calls.length === 0) return next;
    return {
      ...next,
      tool_calls: next.tool_calls.map((tc) => ({
        ...tc,
        function: {
          name: tc.function.name,
          arguments: validateJsonArguments(tc.function.arguments),
        },
      })),
    };
  });
}

function validateJsonArguments(raw: string): string {
  if (!raw || !raw.trim()) return "{}";
  try {
    JSON.parse(raw);
    return raw;
  } catch {
    return "{}";
  }
}

function extractApiError(
  parsed: unknown,
  rawText?: string,
): { code?: number; status?: number; message?: string } | null {
  if (parsed && typeof parsed === "object") {
    // OpenRouter / OpenAI format: { error: { code, message, metadata? } }.
    // OpenRouter's `code` is the HTTP status; upstream provider detail (the
    // actual reason a provider refused) sits in metadata.raw.
    const wrapped = (parsed as { error?: unknown }).error;
    if (wrapped && typeof wrapped === "object") {
      const e = wrapped as { code?: number | string; message?: string; metadata?: { raw?: unknown; provider_name?: string } };
      const status = typeof e.code === "number" ? e.code : undefined;
      let message = typeof e.message === "string" ? e.message : undefined;
      const raw = e.metadata?.raw;
      if (message && typeof raw === "string" && raw && !message.includes(raw)) {
        const who = e.metadata?.provider_name ? `${e.metadata.provider_name}: ` : "";
        message = `${message} (${who}${raw.slice(0, 300)})`;
      }
      return { status, message };
    }
    if (typeof wrapped === "string") return { message: wrapped };

    // Bare OpenAI-compatible format: { object: "error", message, code }
    const oai = parsed as { object?: string; message?: string; code?: string | number };
    if (oai.object === "error" && typeof oai.message === "string") {
      const codeNum = typeof oai.code === "number" ? oai.code : undefined;
      return { code: codeNum, message: oai.message };
    }
  }

  // Fallback: try to grab any "message" field from raw JSON text with a regex
  if (rawText) {
    const msgMatch = rawText.match(/"message"\s*:\s*"([^"]+)"/);
    if (msgMatch?.[1]) {
      return { message: msgMatch[1] };
    }
  }

  return null;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException("aborted", "AbortError"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new DOMException("aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
