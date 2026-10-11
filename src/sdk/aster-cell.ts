import { appendFile, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { join, resolve as resolvePath } from "node:path";
import { startRpcServer } from "./rpc.js";
import type { SessionEvent } from "./types.js";

const HOME = process.env.HOME || "/workspace/.aster/home";
const STATE_DIR = "/workspace/.aster";
const EVENT_LOG = join(STATE_DIR, "events.ndjson");
const TURN_STATE = join(STATE_DIR, "turn-state.json");
// Prompts (with memory and notes prepended) pass through here; keep well above the API's turn limit.
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS = 250;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/**
 * Legacy control clients omit per-prompt mode and retain the previous auto behavior.
 * Current Aster servers pass a validated mode with every prompt.
 */
const CELL_MODE = "auto";

type RpcCommand = { id: string; type: string; [key: string]: unknown };
type RpcOutput = { id?: string; type: string; [key: string]: unknown };
type CellEvent = { cursor: number; runId: string | null; event: SessionEvent };

interface PendingRpc {
  resolve: (value: RpcOutput) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface BridgeState {
  sessionId: string | null;
  model?: string;
  activeRunId: string | null;
  seenRunIds?: string[];
  initialized: boolean;
  cursor: number;
}

/** Hotcell's gateway base URL is the provider root; Autopilot's OpenRouter client expects `/v1`. */
export function normalizeCellPromptMode(value: unknown): "plan" | "edit" | "auto" {
  return value === "plan" || value === "edit" || value === "auto" ? value : CELL_MODE;
}

export function normalizeGatewayBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim().replace(/\/+$/, "");
  if (!trimmed) return value;
  return /\/v1$/.test(trimmed) ? trimmed : `${trimmed}/v1`;
}

export async function startAsterCellBridge(port = 31417): Promise<ReturnType<typeof createServer>> {
  process.env.HOME = HOME;
  const gatewayBaseUrl = normalizeGatewayBaseUrl(process.env.OPENROUTER_BASE_URL);
  if (gatewayBaseUrl) process.env.OPENROUTER_BASE_URL = gatewayBaseUrl;
  await mkdir(HOME, { recursive: true, mode: 0o700 });
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  const state = await readState();
  const input = new PassThrough();
  const pending = new Map<string, PendingRpc>();
  let outputBuffer = "";
  let eventChain = Promise.resolve();

  const output = new Writable({
    write(chunk, _encoding, callback) {
      outputBuffer += chunk.toString();
      const lines = outputBuffer.split("\n");
      outputBuffer = lines.pop() ?? "";
      eventChain = eventChain.then(async () => {
        for (const line of lines) {
          if (!line) continue;
          let message: RpcOutput;
          try { message = JSON.parse(line) as RpcOutput; } catch { continue; }
          if (message.id) {
            const waiter = pending.get(message.id);
            if (waiter) {
              pending.delete(message.id);
              clearTimeout(waiter.timer);
              waiter.resolve(message);
            }
            // The prompt's RPC reply marks the end of the turn (a successful turn emits no
            // session.end), and may arrive long after the RPC waiter timed out. Journal a
            // terminal event so the server sees it. Aborted/failed turns already logged
            // session.end and cleared activeRunId, so they are not ended twice.
            if (message.id === state.activeRunId) {
              const event: SessionEvent = message.type === "error"
                ? { type: "session.end", reason: "error", error: typeof message.error === "string" ? message.error : "prompt_failed" }
                : { type: "session.end", reason: "complete" };
              const record: CellEvent = { cursor: ++state.cursor, runId: state.activeRunId, event };
              await appendFile(EVENT_LOG, JSON.stringify(record) + "\n", { mode: 0o600 });
              state.activeRunId = null;
              await persistState(state);
            }
            continue;
          }
          if (isSessionEvent(message)) {
            const record: CellEvent = { cursor: ++state.cursor, runId: state.activeRunId, event: message };
            await appendFile(EVENT_LOG, JSON.stringify(record) + "\n", { mode: 0o600 });
            if (message.type === "session.end") {
              state.activeRunId = null;
              await persistState(state);
            }
          }
        }
      }).then(() => callback(), (error: unknown) => callback(error instanceof Error ? error : new Error("RPC output failed")));
    },
  });

  // This process is the supported Autopilot JSON-RPC runtime. The bridge only adapts
  // authenticated Hotcell exec requests to its line protocol; it does not run an agent loop.
  void startRpcServer(input, output).catch(() => {
    state.initialized = false;
    void persistState(state);
  });
  const interruptedRunId = state.activeRunId;
  state.activeRunId = null;
  state.initialized = false;
  if (interruptedRunId) {
    const event: SessionEvent = { type: "session.end", reason: "error", error: "cell_runtime_restarted" };
    state.cursor++;
    await appendFile(EVENT_LOG, JSON.stringify({ cursor: state.cursor, runId: interruptedRunId, event } satisfies CellEvent) + "\n", { mode: 0o600 });
  }
  await persistState(state);
  if (state.sessionId && state.model) void restoreSession(input, pending, state);

  const server = createServer((req, res) => {
    void handleRequest(req, res, state, input, pending);
  });
  server.requestTimeout = 60_000;
  server.headersTimeout = 5_000;
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  return server;
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, state: BridgeState, input: PassThrough, pending: Map<string, PendingRpc>): Promise<void> {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (req.method === "GET" && url.pathname === "/health") {
    return send(res, 200, { ok: true, initialized: state.initialized, sessionId: state.sessionId });
  }
  if (req.method === "GET" && url.pathname === "/status") {
    return send(res, 200, { initialized: state.initialized, sessionId: state.sessionId, activeRunId: state.activeRunId, cursor: state.cursor });
  }
  if (req.method === "GET" && url.pathname === "/events") {
    const after = Number(url.searchParams.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) return send(res, 400, { error: "invalid_cursor" });
    const events = await readEvents(after);
    return send(res, 200, { events, cursor: state.cursor, hasMore: events.length === MAX_EVENTS });
  }
  if (req.method !== "POST" || url.pathname !== "/rpc") return send(res, 404, { error: "not_found" });

  let command: RpcCommand;
  try { command = await readCommand(req); } catch { return send(res, 400, { error: "invalid_command" }); }
  if (!UUID_RE.test(command.id) || !ALLOWED_COMMANDS.has(command.type)) return send(res, 400, { error: "unsupported_command" });

  if (command.type === "new_session") {
    const sessionId = typeof command.sessionId === "string" ? command.sessionId : "";
    if (!UUID_RE.test(sessionId)) return send(res, 400, { error: "invalid_session_id" });
    if (state.initialized && state.sessionId !== sessionId) return send(res, 409, { error: "session_already_initialized" });
    if (!state.initialized) {
      const config = command.config && typeof command.config === "object" ? command.config as Record<string, unknown> : {};
      const model = typeof config.model === "string" ? config.model : "";
      const apiKey = process.env.OPENROUTER_API_KEY;
      if (!model || !apiKey || !process.env.OPENROUTER_BASE_URL) return send(res, 503, { error: "scoped_openrouter_gateway_unavailable" });
      command.cwd = "/workspace";
      command.config = { model, mode: CELL_MODE, openrouterApiKey: apiKey };
      state.sessionId = sessionId;
      state.model = model;
      await persistState(state);
    }
  }

  if (command.type === "prompt") {
    const runId = command.id;
    if (state.seenRunIds?.includes(runId)) return send(res, 202, { accepted: true, runId, replay: true });
    if (state.activeRunId) return send(res, 409, { error: "session_busy" });
    if (!state.initialized || typeof command.message !== "string" || !command.message.trim()) return send(res, 409, { error: "session_not_ready" });
    // The server selects each prompt mode; legacy requests fall back to auto.
    const options = command.options && typeof command.options === "object" ? command.options as Record<string, unknown> : {};
    command.options = { ...options, mode: normalizeCellPromptMode(options.mode) };
    state.activeRunId = runId;
    state.seenRunIds = [...(state.seenRunIds ?? []), runId];
    await persistState(state);
    void sendRpc(input, pending, command).catch(() => {
      // Keep the durable active id after an uncertain RPC failure; retrying cannot duplicate the prompt.
    });
    return send(res, 202, { accepted: true, runId });
  }

  if (command.type === "set_model") {
    if (state.activeRunId) return send(res, 409, { error: "session_busy" });
    if (typeof command.modelId !== "string" || !command.modelId.trim() || command.modelId.length > 200) {
      return send(res, 400, { error: "invalid_model" });
    }
  }

  try {
    const response = await sendRpc(input, pending, command);
    if (command.type === "new_session") {
      state.initialized = response.type === "ok";
      await persistState(state);
    }
    if (command.type === "set_model" && response.type !== "error") {
      state.model = command.modelId as string;
      await persistState(state);
    }
    return send(res, response.type === "error" ? 409 : 200, response);
  } catch {
    return send(res, 503, { error: "rpc_unavailable" });
  }
}

const ALLOWED_COMMANDS = new Set(["new_session", "prompt", "abort", "get_state", "resolve_permission", "set_model", "set_mode"]);

async function sendRpc(input: PassThrough, pending: Map<string, PendingRpc>, command: RpcCommand): Promise<RpcOutput> {
  const response = new Promise<RpcOutput>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(command.id);
      reject(new Error("rpc_timeout"));
    }, 55_000);
    pending.set(command.id, { resolve, reject, timer });
  });
  input.write(JSON.stringify(command) + "\n");
  return response;
}

async function readCommand(req: IncomingMessage): Promise<RpcCommand> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_REQUEST_BYTES) throw new Error("too_large");
    chunks.push(buffer);
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("invalid");
  return value as RpcCommand;
}

async function readState(): Promise<BridgeState> {
  let state: BridgeState;
  try {
    state = JSON.parse(await readFile(TURN_STATE, "utf8")) as BridgeState;
  } catch {
    state = { sessionId: null, activeRunId: null, initialized: false, cursor: 0 };
  }
  let last: CellEvent | undefined;
  try {
    const lines = (await readFile(EVENT_LOG, "utf8")).trim().split("\n").filter(Boolean);
    last = lines.length ? JSON.parse(lines.at(-1)!) as CellEvent : undefined;
  } catch { /* first boot has no event log yet */ }
  return { ...state, cursor: Math.max(state.cursor ?? 0, last?.cursor ?? 0) };
}

async function restoreSession(input: PassThrough, pending: Map<string, PendingRpc>, state: BridgeState): Promise<void> {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey || !process.env.OPENROUTER_BASE_URL || !state.sessionId || !state.model) return;
  const response = await sendRpc(input, pending, {
    id: crypto.randomUUID(),
    type: "new_session",
    cwd: "/workspace",
    sessionId: state.sessionId,
    config: { model: state.model, mode: CELL_MODE, openrouterApiKey: apiKey },
  }).catch(() => undefined);
  state.initialized = response?.type === "ok";
  await persistState(state);
}

async function persistState(state: BridgeState): Promise<void> {
  const temp = TURN_STATE + ".tmp";
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  const { rename } = await import("node:fs/promises");
  await rename(temp, TURN_STATE);
}

async function readEvents(after: number): Promise<CellEvent[]> {
  let contents: string;
  try { contents = await readFile(EVENT_LOG, "utf8"); } catch { return []; }
  return contents.split("\n").filter(Boolean).map((line) => JSON.parse(line) as CellEvent).filter((event) => event.cursor > after).slice(0, MAX_EVENTS);
}

function isSessionEvent(value: RpcOutput): value is RpcOutput & SessionEvent {
  return typeof value.type === "string" && !["ok", "error", "state"].includes(value.type) && !value.id;
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(encoded), "cache-control": "no-store" });
  res.end(encoded);
}



const REQUEST_DIR = "/workspace/.aster/control";
const CONTROL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_PATHS = new Set(["/health", "/status", "/rpc"]);

export interface AsterCellControlRequest {
  method: "GET" | "POST";
  path: string;
  body?: unknown;
}

export async function executeAsterCellControl(requestId: string): Promise<unknown> {
  if (!CONTROL_UUID_RE.test(requestId)) throw new Error("invalid_control_request");
  const requestPath = resolvePath(REQUEST_DIR, requestId + ".json");
  if (!requestPath.startsWith(REQUEST_DIR + "/")) throw new Error("invalid_control_request");
  const request = JSON.parse(await readFile(requestPath, "utf8")) as AsterCellControlRequest;
  await unlink(requestPath).catch(() => {});
  if (request.method === "GET" && request.path.startsWith("/events?after=")) {
    const cursor = request.path.slice("/events?after=".length);
    if (!/^\d+$/.test(cursor)) throw new Error("invalid_control_request");
  } else if (!ALLOWED_PATHS.has(request.path)) {
    throw new Error("invalid_control_request");
  }
  const response = await fetch("http://127.0.0.1:31417" + request.path, {
    method: request.method,
    headers: request.method === "POST" ? { "content-type": "application/json" } : undefined,
    body: request.method === "POST" ? JSON.stringify(request.body ?? {}) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  const body: unknown = await response.json().catch(() => ({ error: "invalid_cell_response" }));
  if (!response.ok) throw new Error("cell_control_failed");
  return body;
}

