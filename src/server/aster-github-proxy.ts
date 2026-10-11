import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { request as httpRequest } from "node:http";

/**
 * A GitHub proxy for code cells that only reaches the conversation's own repository.
 *
 * Hotcell's GitHub gateway keeps the token out of the cell but lets a cell reach every
 * repository the token can. Here each code conversation gets its own revocable grant
 * token, bound to one owner/name; the proxy accepts only that repository's git smart-HTTP
 * endpoints (clone, fetch, push) and REST API paths, injects the server's real token, and
 * streams the exchange. Deleting the conversation revokes the grant.
 *
 * Routes (relative to the proxy root):
 *   /git/{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack  -> github.com
 *   /api/repos/{owner}/{repo}[/...]                                          -> api.github.com
 */

export interface AsterGitHubGrant {
  conversationId: string;
  repository: string;
}

export interface AsterGitHubWriteOperation {
  kind: "git_push" | "github_api";
  method: string;
  path: string;
}

export interface AsterGitHubProxyOptions {
  /** The server's GitHub token; never sent to cells. */
  token: string;
  /** Resolves a cell's grant token to its repository, or undefined if unknown or revoked. */
  resolveGrant: (grantToken: string) => AsterGitHubGrant | undefined;
  /** Server policy for Git pushes and mutating repository API requests. */
  authorizeWrite?: (grant: AsterGitHubGrant, operation: AsterGitHubWriteOperation) => boolean | Promise<boolean>;
  /** Upstream roots, overridable for tests. */
  gitUpstream?: string;
  apiUpstream?: string;
}

const GIT_PATH_RE = /^\/git\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;
const API_PATH_RE = /^\/api\/repos\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100})(\/.*)?$/;
const FORWARDED_REQUEST_HEADERS = ["accept", "content-type", "content-encoding", "content-length", "git-protocol", "user-agent", "x-github-api-version"];
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-authenticate", "proxy-authorization", "te", "trailer"]);

export class AsterGitHubProxy {
  private server: Server | undefined;
  private readonly gitUpstream: URL;
  private readonly apiUpstream: URL;

  constructor(private readonly options: AsterGitHubProxyOptions) {
    this.gitUpstream = new URL(options.gitUpstream ?? "https://github.com");
    this.apiUpstream = new URL(options.apiUpstream ?? "https://api.github.com");
  }

  async listen(port: number, host: string): Promise<number> {
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) deny(res, 502, "GitHub authorization could not be completed");
        else res.destroy();
      });
    });
    // Aster approvals can remain pending for up to one hour before the request is forwarded.
    this.server.requestTimeout = 66 * 60 * 1000;
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

  async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://proxy.local");
    const git = url.pathname.match(GIT_PATH_RE);
    const api = git ? null : url.pathname.match(API_PATH_RE);
    if (!git && !api) return deny(res, 404, "Only this conversation's repository is reachable");

    const grantToken = extractToken(req);
    if (!grantToken) {
      // git asks anonymously first and retries with credentials after a Basic challenge.
      res.writeHead(401, { "www-authenticate": 'Basic realm="aster-github"', "content-type": "text/plain" });
      res.end("credentials required");
      return;
    }
    const grant = this.options.resolveGrant(grantToken);
    if (!grant) return deny(res, 403, "This repository grant is invalid or was revoked");

    const [, owner, name] = (git ?? api)!;
    if (`${owner}/${name}`.toLowerCase() !== grant.repository.toLowerCase()) {
      return deny(res, 403, `This conversation can only access ${grant.repository}`);
    }

    const upstream = git
      ? new URL(`/${owner}/${name}.git/${git[3]}${url.search}`, this.gitUpstream)
      : new URL(`/repos/${owner}/${name}${api![3] ?? ""}${url.search}`, this.apiUpstream);
    const method = (req.method ?? "GET").toUpperCase();
    const writeOperation: AsterGitHubWriteOperation | undefined = git
      ? git[3] === "git-receive-pack" && method === "POST"
        ? { kind: "git_push", method, path: upstream.pathname }
        : undefined
      : !["GET", "HEAD", "OPTIONS"].includes(method)
        ? { kind: "github_api", method, path: upstream.pathname }
        : undefined;
    if (writeOperation && this.options.authorizeWrite && !(await this.options.authorizeWrite(grant, writeOperation))) {
      deny(res, 403, "This external GitHub write requires approval");
      return;
    }
    if (res.destroyed) return;
    const headers: Record<string, string> = {};
    for (const name of FORWARDED_REQUEST_HEADERS) {
      const value = req.headers[name];
      if (typeof value === "string") headers[name] = value;
    }
    headers["user-agent"] ??= "autopilot-aster";
    headers.authorization = git
      ? "Basic " + Buffer.from(`x-access-token:${this.options.token}`).toString("base64")
      : `Bearer ${this.options.token}`;

    const send = upstream.protocol === "https:" ? httpsRequest : httpRequest;
    const forward = send(upstream, { method, headers }, (upstreamRes) => {
      const responseHeaders: Record<string, string | string[]> = {};
      for (const [key, value] of Object.entries(upstreamRes.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(key)) responseHeaders[key] = value;
      }
      res.writeHead(upstreamRes.statusCode ?? 502, responseHeaders);
      upstreamRes.pipe(res);
    });
    forward.on("error", () => {
      if (!res.headersSent) deny(res, 502, "GitHub could not be reached");
      else res.destroy();
    });
    req.pipe(forward);
  }
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

function deny(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify({ message }));
}
