/**
 * Test double for camouflage-tui's lifecycle API (2.12.0+): `cam.turn()`
 * returns handles that emit the same wire events the real SDK would, so
 * tests assert on the same event stream without spawning a renderer.
 *
 * Mirrors sdk/node/src/lifecycle.js: closing a handle (or the turn)
 * settles everything under it, and `end()` is idempotent.
 */

export interface FakeSent {
  type: string;
  payload: Record<string, unknown>;
}

interface FakeCam {
  send(type: string, payload?: Record<string, unknown>): boolean;
}

export interface FakeStream {
  readonly id: string;
  readonly settled: boolean;
  write(token: unknown): boolean;
  reasoning(token: unknown): boolean;
  end(opts?: { text?: string }): boolean;
}

export interface FakeTool {
  readonly id: string;
  readonly settled: boolean;
  stdout(chunk: unknown): boolean;
  finish(spec?: Record<string, unknown>): boolean;
}

export interface FakeTurn {
  readonly id: string;
  readonly settled: boolean;
  stream(opts?: { id?: string }): FakeStream;
  tool(spec: { id?: string; name?: string; args?: string; started_at_ms?: number }): FakeTool;
  permission(spec: Record<string, unknown>): Promise<{ choice: string; feedback?: string }>;
  end(opts?: { toolStatus?: string; phase?: string | null }): boolean;
}

const WIRE_STATUS = new Set(["done", "error", "cancelled", "rejected"]);

/** Host-friendly status → the wire value, as the real SDK maps it. */
function wireStatus(status: unknown): string {
  if (status == null) return "done";
  const s = String(status);
  if (s === "ok") return "done";
  if (s === "failed") return "error";
  if (s === "canceled") return "cancelled";
  if (!WIRE_STATUS.has(s)) throw new TypeError(`unknown tool status ${JSON.stringify(status)}`);
  return s;
}

/**
 * Give a fake cam the SDK's `turn()` so a View under test drives the real
 * lifecycle. `hooks.permission` answers `turn.permission()` (the queue the
 * test controls); without it, permissions resolve as denied.
 *
 * @returns the cam, for chaining.
 */
export function attachLifecycle<T extends FakeCam>(
  cam: T,
  hooks: {
    permission?: (spec: Record<string, unknown>) => Promise<{ choice: string; feedback?: string }>;
  } = {},
): T & { turn(opts?: { id?: string }): FakeTurn } {
  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${++seq}`;

  const turn = (): FakeTurn => {
    let ended = false;
    const openStreams = new Set<FakeStream>();
    const openTools = new Set<FakeTool>();

    const t: FakeTurn = {
      id: nextId("turn"),
      get settled() {
        return ended;
      },
      stream(opts = {}) {
        const stream_id = opts.id ?? nextId("stream");
        cam.send("AssistantStreamStarted", { stream_id });
        let open = true;
        const handle: FakeStream = {
          id: stream_id,
          get settled() {
            return !open;
          },
          write: (token) => open && cam.send("AssistantTokenDelta", { stream_id, token: String(token ?? "") }),
          reasoning: (token) => open && cam.send("AssistantReasoningDelta", { stream_id, token: String(token ?? "") }),
          end: (o = {}) => {
            if (!open) return false;
            open = false;
            openStreams.delete(handle);
            return cam.send("AssistantMessageCompleted", {
              stream_id,
              ...(o.text !== undefined ? { text: o.text } : {}),
            });
          },
        };
        openStreams.add(handle);
        return handle;
      },
      tool(spec) {
        const tool_id = spec.id ?? nextId("tool");
        cam.send("ToolExecutionStarted", {
          tool_id,
          tool: spec.name ?? "",
          command: spec.args ?? "",
          ...(spec.started_at_ms != null ? { started_at_ms: spec.started_at_ms } : {}),
        });
        let open = true;
        const handle: FakeTool = {
          id: tool_id,
          get settled() {
            return !open;
          },
          stdout: (chunk) => open && cam.send("ToolExecutionStdout", { tool_id, chunk: String(chunk ?? "") }),
          finish: (f = {}) => {
            if (!open) return false;
            const status = wireStatus(f.status);
            open = false;
            openTools.delete(handle);
            const { status: _s, exit_code, ...rest } = f;
            return cam.send("ToolExecutionFinished", {
              tool_id,
              exit_code: exit_code ?? (status === "error" ? 1 : 0),
              status,
              ...rest,
            });
          },
        };
        openTools.add(handle);
        return handle;
      },
      permission: (spec) => hooks.permission?.(spec) ?? Promise.resolve({ choice: "deny" }),
      end: (o = {}) => {
        if (ended) return false;
        ended = true;
        for (const stream of [...openStreams]) stream.end();
        for (const tool of [...openTools]) tool.finish({ status: o.toolStatus ?? "done" });
        if (o.phase !== null) cam.send("StatusUpdate", { segments: { phase: o.phase ?? "idle" } });
        return true;
      },
    };
    return t;
  };

  return Object.assign(cam, { turn });
}
