/**
 * The GitHub CLI (`gh`), as the star ask and the GitHub sign-in at the first
 * pull request use it. Callers take a `GhRun` so tests pass a fake: nothing
 * here is called against real GitHub in tests.
 */

import { execFile, spawn } from "node:child_process";

export interface GhResult {
  /** The exit code; null when it was killed (timeout) or didn't start. */
  code: number | null;
  stdout: string;
  stderr: string;
  /** `gh` isn't installed (not on PATH). */
  missing?: boolean;
}

export type GhRun = (args: string[], o?: { timeoutMs?: number }) => Promise<GhResult>;

/** Run `gh` with `args` to completion. Never throws. */
export const runGh: GhRun = (args, o = {}) =>
  new Promise((resolve) => {
    try {
      execFile("gh", args, { timeout: o.timeoutMs ?? 10_000, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: unknown }) | null;
        if (e?.code === "ENOENT") return resolve({ code: null, stdout: "", stderr: "", missing: true });
        const code = !e ? 0 : typeof e.code === "number" ? e.code : null;
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
      });
    } catch {
      resolve({ code: null, stdout: "", stderr: "", missing: true });
    }
  });

export type GhStatus = "missing" | "signed-out" | "signed-in";

/**
 * Whether `gh` is installed and signed in, from `gh auth token` (read
 * locally: no network call).
 */
export async function ghStatus(run: GhRun = runGh): Promise<GhStatus> {
  const r = await run(["auth", "token"], { timeoutMs: 3_000 });
  if (r.missing) return "missing";
  return r.code === 0 && r.stdout.trim() ? "signed-in" : "signed-out";
}

/** What `gh auth login --web` prints for the browser step. */
export interface GhDeviceCode {
  code: string;
  url: string;
}

/** The one-time code and URL in `gh auth login --web` output, once both are there. */
export function parseGhDeviceCode(output: string): GhDeviceCode | undefined {
  const code = /one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/i.exec(output)?.[1];
  const url = /(https:\/\/[^\s]*\/login\/device[^\s]*)/.exec(output)?.[1];
  return code && url ? { code, url } : undefined;
}

export type GhLogin = (o: { onCode: (c: GhDeviceCode) => void; signal: AbortSignal }) => Promise<{ ok: boolean; message?: string }>;

/**
 * `gh auth login --web --git-protocol https`: reports the one-time code and
 * URL through `onCode`, and resolves when gh exits (ok on exit 0). The
 * signal stops it.
 */
export const ghAuthLogin: GhLogin = ({ onCode, signal }) =>
  new Promise((resolve) => {
    let out = "";
    let reported = false;
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("gh", ["auth", "login", "--web", "--git-protocol", "https"], { stdio: ["pipe", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, message: (e as Error).message });
    }
    const onData = (d: Buffer) => {
      out += d.toString("utf8");
      const c = reported ? undefined : parseGhDeviceCode(out);
      if (c) {
        reported = true;
        onCode(c);
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    // gh waits for Enter before the browser step when it can prompt.
    child.stdin?.end("\n");
    const onAbort = () => child.kill("SIGTERM");
    signal.addEventListener("abort", onAbort, { once: true });
    child.on("error", (e) => {
      signal.removeEventListener("abort", onAbort);
      resolve({ ok: false, message: e.message });
    });
    child.on("close", (code) => {
      signal.removeEventListener("abort", onAbort);
      const last = out.trim().split("\n").filter(Boolean).at(-1)?.trim();
      resolve(code === 0 ? { ok: true } : { ok: false, ...(last ? { message: last } : {}) });
    });
  });
