import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { createAgentSession } from "./session.js";
import type { KimiFlareSession, SessionEvent, PermissionDecision } from "./types.js";
import { logger } from "../util/logger.js";
import { endSessions } from "../hooks/session-lifecycle.js";

interface RpcCommand {
  id?: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

interface RpcResponse {
  id?: string;
  type: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [key: string]: any;
}

export async function startRpcServer(
  input: Readable = process.stdin,
  output: Writable = process.stdout,
  // Test seam: swap the session factory without touching the wire protocol.
  createSession: typeof createAgentSession = createAgentSession,
): Promise<void> {
  let session: KimiFlareSession | null = null;
  let unsubscribe: (() => void) | null = null;
  // Prompt turns run OFF the read loop. Awaiting `session.prompt()` inline
  // would stop the loop from reading commands until the turn ends — but a
  // turn blocked on `permission.request` can only end via a later
  // `resolve_permission` command (deadlock), and `abort` could never stop
  // a running turn. Consecutive prompts are chained so turns stay
  // serialized (same observable ordering as the old blocking loop). The
  // chain never rejects: each link sends its own ok/error response.
  let promptChain: Promise<void> = Promise.resolve();

  function send(response: RpcResponse): void {
    output.write(JSON.stringify(response) + "\n");
  }

  function sendEvent(event: SessionEvent): void {
    send({ ...event });
  }

  const rl = createInterface({
    input,
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    let cmd: RpcCommand;
    try {
      cmd = JSON.parse(line) as RpcCommand;
    } catch {
      send({ type: "error", error: "Invalid JSON" });
      continue;
    }

    try {
      switch (cmd.type) {
        case "prompt": {
          if (!session) {
            send({ id: cmd.id, type: "error", error: "No active session" });
            break;
          }
          const promptId = cmd.id;
          const promptSession = session;
          const message = typeof cmd.message === "string" ? cmd.message : "";
          const options = cmd.options;
          promptChain = promptChain.then(async () => {
            try {
              await promptSession.prompt(message, options);
              send({ id: promptId, type: "ok" });
            } catch (err) {
              logger.error("rpc:command_error", { type: "prompt", error: (err as Error).message });
              send({ id: promptId, type: "error", error: (err as Error).message });
            }
          });
          break;
        }

        case "steer": {
          if (!session) {
            send({ id: cmd.id, type: "error", error: "No active session" });
            break;
          }
          const steerMessage = typeof cmd.message === "string" ? cmd.message : "";
          await session.steer(steerMessage);
          send({ id: cmd.id, type: "ok" });
          break;
        }

        case "follow_up": {
          if (!session) {
            send({ id: cmd.id, type: "error", error: "No active session" });
            break;
          }
          const followUpMessage = typeof cmd.message === "string" ? cmd.message : "";
          await session.followUp(followUpMessage);
          send({ id: cmd.id, type: "ok" });
          break;
        }

        case "abort": {
          if (!session) {
            send({ id: cmd.id, type: "error", error: "No active session" });
            break;
          }
          await session.abort();
          send({ id: cmd.id, type: "ok" });
          break;
        }

        case "get_state": {
          if (!session) {
            send({ id: cmd.id, type: "error", error: "No active session" });
            break;
          }
          send({
            id: cmd.id,
            type: "state",
            ...session.getStatus(),
            usage: session.getUsage(),
          });
          break;
        }

        case "set_model": {
          if (!session) {
            send({ id: cmd.id, type: "error", error: "No active session" });
            break;
          }
          session.setModel(typeof cmd.modelId === "string" ? cmd.modelId : "");
          send({ id: cmd.id, type: "ok" });
          break;
        }

        case "set_mode": {
          if (!session) {
            send({ id: cmd.id, type: "error", error: "No active session" });
            break;
          }
          const mode = cmd.mode;
          if (mode === "plan" || mode === "edit" || mode === "auto") {
            session.setMode(mode);
          }
          send({ id: cmd.id, type: "ok" });
          break;
        }

        case "resolve_permission": {
          if (!session) {
            send({ id: cmd.id, type: "error", error: "No active session" });
            break;
          }
          // M2.2: accept either the legacy string or the typed
          // `PermissionDecisionResult` shape (`{ decision, scope }`).
          // Both work because `PermissionDecision` is a union and the
          // executor normalizes at the boundary.
          const raw = cmd.decision as unknown;
          let decision: PermissionDecision | null = null;
          if (raw === "allow" || raw === "allow_session" || raw === "deny") {
            decision = raw;
          } else if (
            raw !== null &&
            typeof raw === "object" &&
            (raw as { decision?: unknown }).decision !== undefined
          ) {
            const r = raw as { decision: unknown; scope: unknown };
            const okDecision = r.decision === "allow" || r.decision === "deny";
            const okScope = r.scope === "once" || r.scope === "session" || r.scope === "pattern";
            if (okDecision && okScope) {
              decision = { decision: r.decision, scope: r.scope } as PermissionDecision;
            }
          }
          if (decision !== null) {
            session.resolvePermission(typeof cmd.requestId === "string" ? cmd.requestId : "", decision);
          }
          send({ id: cmd.id, type: "ok" });
          break;
        }

        case "new_session": {
          if (session) {
            unsubscribe?.();
            session.dispose();
          }
          const { session: newSession } = await createSession({
            cwd: typeof cmd.cwd === "string" ? cmd.cwd : undefined,
            config: typeof cmd.config === "object" ? cmd.config : undefined,
            // Resume: forwarded to createAgentSession, which reloads
            // `<sessionsDir>/<sessionId>.json` when it exists (and starts
            // a fresh session under this id otherwise).
            sessionId: typeof cmd.sessionId === "string" ? cmd.sessionId : undefined,
          });
          session = newSession;
          unsubscribe = session.subscribe((event) => {
            sendEvent(event);
          });
          send({ id: cmd.id, type: "ok", sessionId: session.sessionId });
          break;
        }

        case "dispose": {
          if (session) {
            unsubscribe?.();
            session.dispose();
            session = null;
            unsubscribe = null;
          }
          // dispose() aborts the turn and denies pending permissions, so
          // any in-flight or queued prompt settles promptly; flush those
          // responses before acknowledging and exiting.
          await promptChain;
          // dispose() fires SessionEnd without waiting; finish it before acknowledging (#877).
          await endSessions("exit");
          send({ id: cmd.id, type: "ok" });
          rl.close();
          return;
        }

        default: {
          send({ id: cmd.id, type: "error", error: `Unknown command type: ${cmd.type}` });
        }
      }
    } catch (err) {
      logger.error("rpc:command_error", { type: cmd.type, error: (err as Error).message });
      send({ id: cmd.id, type: "error", error: (err as Error).message });
    }
  }

  // stdin ended without an explicit dispose — let any in-flight prompt
  // finish so its response is not dropped.
  await promptChain;
  // The client went away: its session is over (#877).
  await endSessions("exit");
}
