import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { ToolSpec } from "../tools/registry.js";
import { mcpToolToSpec, type McpToolEntry } from "./adapter.js";

export interface McpServerInfo {
  name: string;
  toolCount: number;
  type: "local" | "remote";
}

interface ActiveConnection {
  client: Client;
  transport: StdioClientTransport | SSEClientTransport;
  tools: McpToolEntry[];
}

export class McpManager {
  private connections = new Map<string, ActiveConnection>();

  async addLocalServer(
    name: string,
    command: string[],
    env?: Record<string, string>,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    if (this.connections.has(name)) {
      await this.removeServer(name);
    }

    const transport = new StdioClientTransport({
      command: command[0]!,
      args: command.slice(1),
      env,
      stderr: "pipe",
    });

    const client = new Client({ name: "kimiflare", version: "0.13.7" });
    await client.connect(transport);

    const listResult = await client.listTools();
    const tools = listResult.tools.map((t) => mcpToolToSpec(name, t, client, options));

    this.connections.set(name, { client, transport, tools });
  }

  async addRemoteServer(
    name: string,
    url: string,
    headers?: Record<string, string>,
    options?: { timeoutMs?: number },
  ): Promise<void> {
    if (this.connections.has(name)) {
      await this.removeServer(name);
    }

    const transport = new SSEClientTransport(new URL(url), {
      requestInit: headers ? { headers } : undefined,
    });

    const client = new Client({ name: "kimiflare", version: "0.13.7" });
    await client.connect(transport);

    const listResult = await client.listTools();
    const tools = listResult.tools.map((t) => mcpToolToSpec(name, t, client, options));

    this.connections.set(name, { client, transport, tools });
  }

  removeServer(name: string): Promise<void> {
    const conn = this.connections.get(name);
    if (!conn) return Promise.resolve();
    this.connections.delete(name);
    return conn.transport.close().catch(() => {});
  }

  async disconnectAll(): Promise<void> {
    for (const [name] of this.connections) {
      await this.removeServer(name);
    }
  }

  getAllTools(): ToolSpec[] {
    const out: ToolSpec[] = [];
    for (const conn of this.connections.values()) {
      for (const entry of conn.tools) {
        out.push(entry.spec);
      }
    }
    return out;
  }

  listServers(): McpServerInfo[] {
    const out: McpServerInfo[] = [];
    for (const [name, conn] of this.connections) {
      out.push({
        name,
        toolCount: conn.tools.length,
        type: conn.transport instanceof StdioClientTransport ? "local" : "remote",
      });
    }
    return out;
  }
}
