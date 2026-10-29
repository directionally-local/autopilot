/**
 * Is Hotcell ready to run a subagent? (#966)
 *
 * Subagents run in Hotcell cells, so when Docker or the daemon is down every
 * `subagent` call fails. Probing before offering delegation keeps the model
 * from burning turns on calls that cannot work, and gives the user one
 * actionable line instead of a wall of worker errors.
 *
 * The probe is a TCP connect to the daemon endpoint (default
 * `http://127.0.0.1:4750`, override with `AUTOPILOT_HOTCELL_ENDPOINT`), cached
 * for a short TTL so a turn does not pay for it repeatedly.
 */
import { execFile } from "node:child_process";
import { connect } from "node:net";

export interface HotcellReadiness {
  ready: boolean;
  /** What is missing, when not ready. */
  reason?: string;
  /** The exact command to fix it. */
  fix?: string;
}

const DEFAULT_ENDPOINT = "http://127.0.0.1:4750";
const CACHE_TTL_MS = 60_000;

let cache: { at: number; result: HotcellReadiness } | null = null;

/** Forget the cached probe (tests, or after the user says they fixed it). */
export function resetHotcellReadinessCache(): void {
  cache = null;
}

function endpointOf(): URL {
  const raw = process.env.AUTOPILOT_HOTCELL_ENDPOINT?.trim();
  try {
    return new URL(raw || DEFAULT_ENDPOINT);
  } catch {
    return new URL(DEFAULT_ENDPOINT);
  }
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host, port });
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

function hasBinary(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(process.platform === "win32" ? "where" : "which", [command], { timeout: 2_000 }, (error) => resolve(!error));
  });
}

export interface HotcellReadinessOpts {
  /** Override the daemon endpoint (default: env or 127.0.0.1:4750). */
  endpoint?: string;
  /** TCP connect timeout. Default 400 ms. */
  timeoutMs?: number;
  /** Hotcell binary name. Default: `HOTCELL_BIN` or `hotcell`. */
  command?: string;
  /** Set false to bypass the TTL cache. */
  useCache?: boolean;
}

export async function checkHotcellReadiness(opts: HotcellReadinessOpts = {}): Promise<HotcellReadiness> {
  const now = Date.now();
  if (opts.useCache !== false && cache && now - cache.at < CACHE_TTL_MS) return cache.result;

  const url = opts.endpoint ? new URL(opts.endpoint) : endpointOf();
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  const command = opts.command ?? process.env.HOTCELL_BIN ?? "hotcell";

  let result: HotcellReadiness;
  if (await probe(url.hostname, port, opts.timeoutMs ?? 400)) {
    result = { ready: true };
  } else if (!(await hasBinary(command))) {
    result = {
      ready: false,
      reason: "the Hotcell CLI is not installed",
      fix: "Install Hotcell, then run `hotcell start --defaults`.",
    };
  } else {
    result = {
      ready: false,
      reason: `the Hotcell daemon isn't reachable at ${url.origin}`,
      fix: "Start it with `hotcell start --defaults` (Docker must be running).",
    };
  }

  cache = { at: now, result };
  return result;
}
