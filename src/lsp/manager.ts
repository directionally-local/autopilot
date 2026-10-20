import { LspConnection } from "./connection.js";
import { LspClient } from "./client.js";
import { toUri } from "./protocol.js";
import type { LspServerConfig } from "../config.js";

export const DEFAULT_LSP_TIMEOUT_MS = 10_000;
export const DEFAULT_LSP_MAX_RESTART_ATTEMPTS = 3;
const RESTART_BASE_DELAY_MS = 500;
const RESTART_MAX_DELAY_MS = 10_000;

interface ActiveServer {
  id: string;
  rootPath: string;
  rootUri: string;
  config: LspServerConfig;
  connection: LspConnection;
  client: LspClient;
  state: "starting" | "running" | "crashed";
  restartAttempts: number;
  pid?: number;
  stopping?: boolean;
}

export interface LspServerStatus {
  id: string;
  rootUri: string;
  state: "starting" | "running" | "crashed";
  pid?: number;
  toolCount: number;
  restartAttempts: number;
}

export interface LspManagerHooks {
  /** Sleep for the given number of ms. Overridable for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Called when an unexpected exit triggers (or fails to trigger) a restart. */
  onRestart?: (info: { id: string; rootPath: string; attempt: number; delayMs: number }) => void;
  onRestartGaveUp?: (info: { id: string; rootPath: string; attempts: number; reason: string }) => void;
  /** Connection factory override for tests. */
  connectionFactory?: (timeoutMs: number) => LspConnection;
  /** Client factory override for tests. */
  clientFactory?: (connection: LspConnection, rootUri: string) => LspClient;
}

export class LspManager {
  private servers = new Map<string, ActiveServer>();
  private readonly hooks: LspManagerHooks;

  constructor(hooks: LspManagerHooks = {}) {
    this.hooks = hooks;
  }

  private key(id: string, rootUri: string): string {
    return `${id}::${rootUri}`;
  }

  private makeConnection(timeoutMs: number): LspConnection {
    return this.hooks.connectionFactory
      ? this.hooks.connectionFactory(timeoutMs)
      : new LspConnection(timeoutMs);
  }

  private makeClient(connection: LspConnection, rootUri: string): LspClient {
    return this.hooks.clientFactory
      ? this.hooks.clientFactory(connection, rootUri)
      : new LspClient(connection, rootUri);
  }

  async startServer(id: string, config: LspServerConfig, rootPath: string): Promise<void> {
    const rootUri = toUri(rootPath);
    const k = this.key(id, rootUri);

    if (this.servers.has(k)) {
      await this.stopServer(id, rootPath);
    }

    const timeoutMs = config.timeoutMs ?? DEFAULT_LSP_TIMEOUT_MS;
    const connection = this.makeConnection(timeoutMs);
    const server: ActiveServer = {
      id,
      rootPath,
      rootUri,
      config,
      connection,
      client: this.makeClient(connection, rootUri),
      state: "starting",
      restartAttempts: 0,
    };
    this.servers.set(k, server);

    this.wireExitHandler(server);

    try {
      await connection.start(config.command, config.env);
      server.pid = connection["child"]?.pid;
      await server.client.initialize();
      server.state = "running";
    } catch (e) {
      server.state = "crashed";
      throw new Error(`LSP server "${id}" failed: ${(e as Error).message}`);
    }
  }

  private wireExitHandler(server: ActiveServer): void {
    server.connection.once("exit", (code: number | null, _signal: NodeJS.Signals | null) => {
      if (server.stopping) return;
      if (code === 0) {
        server.state = "crashed";
        return;
      }
      this.scheduleRestart(server, `exit code=${code}`);
    });
  }

  private scheduleRestart(server: ActiveServer, reason: string): void {
    const k = this.key(server.id, server.rootUri);
    if (this.servers.get(k) !== server) return;

    const maxAttempts = server.config.maxRestartAttempts ?? DEFAULT_LSP_MAX_RESTART_ATTEMPTS;
    if (maxAttempts <= 0 || server.restartAttempts >= maxAttempts) {
      server.state = "crashed";
      this.hooks.onRestartGaveUp?.({
        id: server.id,
        rootPath: server.rootPath,
        attempts: server.restartAttempts,
        reason,
      });
      return;
    }

    server.restartAttempts += 1;
    server.state = "starting";
    const exp = RESTART_BASE_DELAY_MS * 2 ** (server.restartAttempts - 1);
    const cap = Math.min(exp, RESTART_MAX_DELAY_MS);
    const delayMs = Math.floor(Math.random() * cap);

    this.hooks.onRestart?.({
      id: server.id,
      rootPath: server.rootPath,
      attempt: server.restartAttempts,
      delayMs,
    });

    const sleep = this.hooks.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    void sleep(delayMs).then(async () => {
      if (this.servers.get(k) !== server) return;
      try {
        const timeoutMs = server.config.timeoutMs ?? DEFAULT_LSP_TIMEOUT_MS;
        const nextConnection = this.makeConnection(timeoutMs);
        server.connection = nextConnection;
        server.client = this.makeClient(nextConnection, server.rootUri);
        this.wireExitHandler(server);
        await nextConnection.start(server.config.command, server.config.env);
        server.pid = nextConnection["child"]?.pid;
        await server.client.initialize();
        server.state = "running";
      } catch (e) {
        this.scheduleRestart(server, `restart failed: ${(e as Error).message}`);
      }
    });
  }

  async stopServer(id: string, rootPath: string): Promise<void> {
    const rootUri = toUri(rootPath);
    const k = this.key(id, rootUri);
    const server = this.servers.get(k);
    if (!server) return;

    server.stopping = true;
    this.servers.delete(k);
    try {
      await server.client.shutdown();
    } catch {
      // ignore
    }
    server.connection.kill();
  }

  async stopAll(): Promise<void> {
    for (const [k, server] of this.servers) {
      server.stopping = true;
      try {
        await server.client.shutdown();
      } catch {
        // ignore
      }
      server.connection.kill();
      this.servers.delete(k);
    }
  }

  getClient(id: string, rootPath: string): LspClient | undefined {
    const rootUri = toUri(rootPath);
    const k = this.key(id, rootUri);
    const server = this.servers.get(k);
    if (server?.state === "running") {
      return server.client;
    }
    return undefined;
  }

  /** Find the first running client for a given server ID, regardless of root. */
  findClient(id: string): LspClient | undefined {
    for (const [, server] of this.servers) {
      if (server.id === id && server.state === "running") {
        return server.client;
      }
    }
    return undefined;
  }

  /** Auto-detect which server ID to use for a given file path. */
  resolveClientForPath(filePath: string): { id: string; client: LspClient } | undefined {
    for (const [, server] of this.servers) {
      if (server.state !== "running") continue;
      // Simple prefix match on rootUri
      if (filePath.startsWith(server.rootUri.replace("file://", ""))) {
        return { id: server.id, client: server.client };
      }
    }
    // Fallback: return first running client
    for (const [, server] of this.servers) {
      if (server.state === "running") {
        return { id: server.id, client: server.client };
      }
    }
    return undefined;
  }

  listActive(): LspServerStatus[] {
    const out: LspServerStatus[] = [];
    for (const [, server] of this.servers) {
      out.push({
        id: server.id,
        rootUri: server.rootUri,
        state: server.state,
        pid: server.pid,
        toolCount: this.estimateToolCount(server.client.getCapabilities()),
        restartAttempts: server.restartAttempts,
      });
    }
    return out;
  }

  notifyChange(path: string, content: string): void {
    for (const [, server] of this.servers) {
      if (server.state === "running") {
        server.client.didChange(path, content);
      }
    }
  }

  private estimateToolCount(capabilities: Record<string, unknown>): number {
    let count = 0;
    const caps = [
      "hoverProvider",
      "definitionProvider",
      "referencesProvider",
      "documentSymbolProvider",
      "workspaceSymbolProvider",
      "renameProvider",
      "codeActionProvider",
      "implementationProvider",
      "typeDefinitionProvider",
    ];
    for (const cap of caps) {
      if (capabilities[cap]) count++;
    }
    return count;
  }
}
