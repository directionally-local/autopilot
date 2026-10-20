import { createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

/**
 * Repository-scoped Git Smart HTTP proxy for Aster code cells. A cell receives only
 * an HMAC-derived per-conversation capability; the real GitHub token stays on host.
 * Reads are limited to one repository and writes are limited to that conversation's
 * feature branch. REST endpoints are deliberately not exposed to the agent.
 */

export interface AsterGitHubGrant {
  conversationId: string;
  repository: string;
  branch: string;
}

export function createAsterGitHubGrantToken(serverToken: string, conversationId: string, repository: string): string {
  return createHmac("sha256", serverToken)
    .update(`aster-github:${conversationId}:${repository.toLowerCase()}`)
    .digest("base64url");
}

export interface AsterGitHubProxyOptions {
  /** The server's GitHub token; never sent to cells. */
  token: string;
  /** Resolves a cell's grant token to its repository and writable branch. */
  resolveGrant: (grantToken: string) => AsterGitHubGrant | undefined;
  /** Upstream root, overridable for tests. */
  gitUpstream?: string;
}

const GIT_PATH_RE = /^\/git\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "content-encoding", "content-length", "git-protocol", "user-agent"];
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"]);
const MAX_COMMAND_LIST_BYTES = 64 * 1024;

export class AsterGitHubProxy {
  private server: Server | undefined;
  private readonly gitUpstream: URL;

  constructor(private readonly options: AsterGitHubProxyOptions) {
    this.gitUpstream = new URL(options.gitUpstream ?? "https://github.com");
  }

  async listen(port: number, host: string): Promise<number> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(port, host, () => resolve());
    });
    const address = this.server.address();
    return typeof address === "object" && address ? address.port : port;
  }

  close(): void {
    this.server?.close();
    this.server = undefined;
  }

  handle(req: IncomingMessage, res: ServerResponse, pathOverride?: string): void {
    const url = new URL(pathOverride ?? req.url ?? "/", "http://proxy.local");
    const git = url.pathname.match(GIT_PATH_RE);
    if (!git) return deny(res, 404, "Only Git Smart HTTP is available through this proxy");

    const grantToken = extractToken(req);
    if (!grantToken) {
      // git asks anonymously first and retries with credentials after a Basic challenge.
      res.writeHead(401, { "www-authenticate": 'Basic realm="aster-github"', "content-type": "text/plain" });
      res.end("credentials required");
      return;
    }
    const grant = this.options.resolveGrant(grantToken);
    if (!grant) return deny(res, 403, "This repository grant is invalid or was revoked");

    const [, owner, name, service] = git;
    if (`${owner}/${name}`.toLowerCase() !== grant.repository.toLowerCase()) {
      return deny(res, 403, `This conversation can only access ${grant.repository}`);
    }
    if (service === "git-receive-pack") {
      if (req.method !== "POST" || !isSafeBranch(grant.branch)) return deny(res, 403, "This conversation cannot push to that ref");
      this.forwardReceivePack(req, res, url, owner!, name!, grant.branch);
      return;
    }
    if (req.method !== "GET" && req.method !== "POST") return deny(res, 405, "Unsupported Git method");
    this.forward(req, res, url, owner!, name!, service!);
  }

  private forward(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, name: string, service: string): void {
    const upstream = new URL(`/${owner}/${name}.git/${service}${url.search}`, this.gitUpstream);
    const headers = upstreamHeaders(req, this.options.token, true);
    const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const forward = send(upstream, { method: req.method, headers }, (upstreamRes) => pipeResponse(upstreamRes, res));
    forward.on("error", () => failUpstream(res));
    req.pipe(forward);
  }

  private forwardReceivePack(req: IncomingMessage, res: ServerResponse, url: URL, owner: string, name: string, branch: string): void {
    let pending = Buffer.alloc(0);
    let forwarding = false;
    const onData = (chunk: Buffer) => {
      if (forwarding) return;
      pending = Buffer.concat([pending, chunk]);
      const parsed = parseReceivePackCommands(pending);
      if (parsed === "invalid") {
        req.removeListener("data", onData);
        return deny(res, 400, "Malformed Git push command list");
      }
      if (!parsed) {
        if (pending.length > MAX_COMMAND_LIST_BYTES) {
          req.removeListener("data", onData);
          return deny(res, 413, "Git push command list is too large");
        }
        return;
      }
      if (parsed.commands.length === 0 || parsed.commands.some((command) =>
        command.ref !== `refs/heads/${branch}` || command.newObjectId.length === 0 || /^0+$/.test(command.newObjectId))) {
        req.removeListener("data", onData);
        return deny(res, 403, "Aster cells may push only to their own feature branch");
      }
      req.removeListener("data", onData);
      forwarding = true;
      const prefix = pending.subarray(0, parsed.flushEnd);
      const rest = pending.subarray(parsed.flushEnd);
      const upstream = new URL(`/${owner}/${name}.git/git-receive-pack${url.search}`, this.gitUpstream);
      const headers = upstreamHeaders(req, this.options.token, true);
      const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
      const forward = send(upstream, { method: "POST", headers }, (upstreamRes) => pipeResponse(upstreamRes, res));
      forward.on("error", () => failUpstream(res));
      if (prefix.length) forward.write(prefix);
      if (rest.length) forward.write(rest);
      req.pipe(forward);
    };
    req.on("data", onData);
    req.once("end", () => {
      if (!forwarding) deny(res, 400, "Incomplete Git push command list");
    });
    req.once("error", () => failUpstream(res));
  }
}

interface ReceivePackCommand {
  ref: string;
  newObjectId: string;
}

function parseReceivePackCommands(data: Buffer): { commands: ReceivePackCommand[]; flushEnd: number } | "invalid" | undefined {
  let offset = 0;
  const commands: ReceivePackCommand[] = [];
  while (offset + 4 <= data.length) {
    const header = data.toString("ascii", offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) return "invalid";
    const length = Number.parseInt(header, 16);
    if (length === 0) return { commands, flushEnd: offset + 4 };
    if (length < 4 || length > 65_520) return "invalid";
    if (offset + length > data.length) return undefined;
    const payload = data.toString("utf8", offset + 4, offset + length).split("\0", 1)[0] ?? "";
    const match = payload.match(/^[0-9a-fA-F]{40,64} ([0-9a-fA-F]{40,64}) (refs\/[^\s]+)$/);
    if (!match) return "invalid";
    commands.push({ newObjectId: match[1]!, ref: match[2]! });
    offset += length;
  }
  return undefined;
}

function isSafeBranch(branch: string): boolean {
  return /^[A-Za-z0-9._/-]{1,200}$/.test(branch)
    && !branch.startsWith("-") && !branch.endsWith("/") && !branch.includes("..")
    && !branch.includes("//") && !branch.includes("@{")
    && branch.split("/").every((part) => part !== "" && part !== "." && part !== ".." && !part.endsWith(".lock"));
}

function upstreamHeaders(req: IncomingMessage, token: string, git: boolean): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  headers["user-agent"] ??= "autopilot-aster";
  headers.authorization = git
    ? "Basic " + Buffer.from(`x-access-token:${token}`).toString("base64")
    : `Bearer ${token}`;
  return headers;
}

function pipeResponse(upstreamRes: import("node:http").IncomingMessage, res: ServerResponse): void {
  const responseHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(upstreamRes.headers)) {
    if (value !== undefined && !HOP_BY_HOP.has(key)) responseHeaders[key] = value;
  }
  res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
  upstreamRes.pipe(res);
}

function extractToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, value = ""] = header.split(" ", 2);
  if (/^(bearer|token)$/i.test(scheme ?? "")) return value.trim() || undefined;
  if (/^basic$/i.test(scheme ?? "")) {
    const decoded = Buffer.from(value, "base64").toString("utf8");
    const password = decoded.slice(decoded.indexOf(":") + 1);
    return password || undefined;
  }
  return undefined;
}

function failUpstream(res: ServerResponse): void {
  if (!res.headersSent) deny(res, 502, "GitHub could not be reached");
  else res.destroy();
}

function deny(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent || res.writableEnded || res.destroyed) return;
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ message }));
}
