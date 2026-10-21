/**
 * Client for a paired server's Aster API (/api/v1). Same contract the iOS app and a
 * future desktop app use: device pairing, code conversations as runs, resumable SSE.
 */

export interface RemoteConversation {
  conversationId: string;
  workspaceId: string;
  model: string;
  status: string;
  activeRunId: string | null;
  lastEventId: number;
  createdAt: string;
  updatedAt: string;
  kind?: "chat" | "code";
  repository?: string | null;
  branch?: string | null;
  pullRequestNumber?: number;
  pullRequestURL?: string;
}

export interface RemoteEvent {
  id: number;
  type: string;
  data: Record<string, unknown>;
}

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

export interface IssuedCredential {
  token: string;
  credentialId: string;
  name: string;
  workspaceIds: string[];
  scopes: string[];
  expiresAt: string;
}

export const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "interrupted", "merged", "destroyed"]);

export class RemoteApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
    this.name = "RemoteApiError";
  }
}

type FetchLike = typeof fetch;

export class RemoteClient {
  constructor(
    readonly baseUrl: string,
    private readonly token: string | undefined,
    private readonly fetchImpl: FetchLike = fetch,
  ) {}

  startDeviceAuthorization(clientName: string): Promise<DeviceAuthorization> {
    return this.request("POST", "/auth/device", { body: { clientName }, auth: false });
  }

  /** Polls until the owner decides; resolves with the credential, rejects on denial or expiry. */
  async waitForCredential(device: DeviceAuthorization, options: { signal?: AbortSignal; sleep?: (ms: number) => Promise<void> } = {}): Promise<IssuedCredential> {
    const sleep = options.sleep ?? ((ms: number) => delay(ms, options.signal));
    let intervalMs = Math.max(1, device.interval) * 1000;
    const deadline = Date.now() + device.expiresIn * 1000;
    while (Date.now() < deadline) {
      await sleep(intervalMs);
      try {
        return await this.request<IssuedCredential>("POST", "/auth/device/token", { body: { deviceCode: device.deviceCode }, auth: false, signal: options.signal });
      } catch (error) {
        if (!(error instanceof RemoteApiError)) throw error;
        if (error.code === "authorization_pending") continue;
        if (error.code === "slow_down") {
          intervalMs += 5_000;
          continue;
        }
        throw error;
      }
    }
    throw new RemoteApiError(400, "expired_token", "The pairing code expired before it was approved; run the command again");
  }

  health(): Promise<{ status: string; capabilities: string[]; serviceVersion?: string }> {
    return this.request("GET", "/health");
  }

  async workspaces(): Promise<Array<{ id: string; displayName: string }>> {
    return (await this.request<{ workspaces: Array<{ id: string; displayName: string }> }>("GET", "/workspaces")).workspaces;
  }

  async models(): Promise<string[]> {
    return (await this.request<{ models: string[] }>("GET", "/models")).models;
  }

  createCodeConversation(input: {
    workspaceId: string;
    model: string;
    repository: string;
    baseCommit?: string;
    patch?: string;
    idempotencyKey: string;
  }): Promise<RemoteConversation> {
    const { idempotencyKey, ...body } = input;
    return this.withRetries(() => this.request("POST", "/conversations", {
      body: { ...body, kind: "code" },
      headers: { "Idempotency-Key": idempotencyKey },
    }));
  }

  submitTurn(conversationId: string, text: string, clientTurnId: string): Promise<{ runId: string; status: string }> {
    return this.withRetries(() => this.request("POST", `/conversations/${encodeURIComponent(conversationId)}/turns`, { body: { clientTurnId, text } }));
  }

  getConversation(conversationId: string): Promise<RemoteConversation> {
    return this.request("GET", `/conversations/${encodeURIComponent(conversationId)}`);
  }

  async listConversations(limit = 50): Promise<RemoteConversation[]> {
    return (await this.request<{ conversations: RemoteConversation[] }>("GET", `/conversations?limit=${limit}`)).conversations;
  }

  cancel(conversationId: string): Promise<RemoteConversation> {
    return this.request("POST", `/conversations/${encodeURIComponent(conversationId)}/cancel`);
  }

  /**
   * Events after `cursor`, reconnecting with the last seen ID when the stream drops,
   * until the caller stops iterating or the signal aborts.
   */
  async *events(conversationId: string, cursor: number, signal?: AbortSignal): AsyncGenerator<RemoteEvent> {
    let last = cursor;
    let failures = 0;
    while (!signal?.aborted) {
      try {
        const response = await this.fetchImpl(this.url(`/conversations/${encodeURIComponent(conversationId)}/events`), {
          headers: { ...this.authHeaders(), Accept: "text/event-stream", "Last-Event-ID": String(last) },
          signal,
        });
        if (!response.ok || !response.body) throw await toApiError(response);
        failures = 0;
        for await (const event of parseEventStream(response.body)) {
          if (event.id <= last) continue;
          last = event.id;
          yield event;
        }
      } catch (error) {
        if (signal?.aborted) return;
        if (error instanceof RemoteApiError && error.status < 500) throw error;
        if (++failures > 30) throw error;
      }
      await delay(Math.min(1_000 * failures, 10_000), signal).catch(() => {});
    }
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    options: { body?: unknown; headers?: Record<string, string>; auth?: boolean; signal?: AbortSignal } = {},
  ): Promise<T> {
    const response = await this.fetchImpl(this.url(path), {
      method,
      headers: {
        ...(options.auth === false ? {} : this.authHeaders()),
        ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...options.headers,
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) throw await toApiError(response);
    return await response.json() as T;
  }

  /** Retries network failures and 5xx; safe only for requests carrying an idempotency key. */
  private async withRetries<T>(attempt: () => Promise<T>): Promise<T> {
    for (let tries = 1; ; tries++) {
      try {
        return await attempt();
      } catch (error) {
        const retryable = !(error instanceof RemoteApiError) || error.status >= 500;
        if (!retryable || tries >= 3) throw error;
        await delay(1_000 * tries);
      }
    }
  }

  private url(path: string): string {
    return `${this.baseUrl}/api/v1${path}`;
  }

  private authHeaders(): Record<string, string> {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }
}

/** Minimal text/event-stream parser for the server's `id:`/`event:`/`data:` frames. */
export async function* parseEventStream(body: ReadableStream<Uint8Array>): AsyncGenerator<RemoteEvent> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) >= 0) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const event = parseFrame(frame);
      if (event) yield event;
    }
  }
}

function parseFrame(frame: string): RemoteEvent | undefined {
  let id: number | undefined;
  let type = "message";
  const data: string[] = [];
  for (const line of frame.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "id" && /^\d+$/.test(value)) id = Number(value);
    else if (field === "event") type = value;
    else if (field === "data") data.push(value);
  }
  if (id === undefined) return undefined;
  let parsed: unknown = {};
  try {
    parsed = data.length ? JSON.parse(data.join("\n")) : {};
  } catch {
    return undefined;
  }
  return { id, type, data: parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {} };
}

async function toApiError(response: Response): Promise<RemoteApiError> {
  let code = `http_${response.status}`;
  let message = `Server returned ${response.status}`;
  try {
    const body = await response.json() as { error?: { code?: string; message?: string } };
    if (body.error?.code) code = body.error.code;
    if (body.error?.message) message = body.error.message;
  } catch {
    // not a JSON error body
  }
  return new RemoteApiError(response.status, code, message);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
