import type { AutopilotConfig } from "#kimiflare/config.js";
import type { ToolExecutor } from "#kimiflare/tools/executor.js";
import type { McpManager } from "#kimiflare/mcp/manager.js";
import type { ChatMessage } from "#kimiflare/agent/messages.js";
import type { Mode } from "#kimiflare/mode.js";
import type { MemoryManager } from "#kimiflare/memory/manager.js";

export interface AcpSession {
  id: string;
  cwd: string;
  config: AutopilotConfig;
  executor: ToolExecutor;
  mcpManager: McpManager;
  messages: ChatMessage[];
  mode: Mode;
  abortController: AbortController;
  promptRunning: boolean;
  memoryManager: MemoryManager | null;
  createdAt: string;
}

const MAX_SESSIONS = 64;
const sessions = new Map<string, AcpSession>();

export function getSession(id: string): AcpSession | undefined {
  return sessions.get(id);
}

export function setSession(id: string, session: AcpSession): void {
  // Evict the oldest session if we've hit the limit
  if (sessions.size >= MAX_SESSIONS && !sessions.has(id)) {
    const oldest = sessions.keys().next().value;
    if (oldest !== undefined) {
      const stale = sessions.get(oldest);
      sessions.delete(oldest);
      if (stale) {
        // Abort any in-progress work on the evicted session
        stale.abortController.abort();
        // Best-effort cleanup of MCP connections
        stale.mcpManager.disconnectAll().catch(() => {});
      }
    }
  }
  sessions.set(id, session);
}

export function deleteSession(id: string): boolean {
  return sessions.delete(id);
}
