/**
 * MCP + LSP manager init/reload extracted from app.tsx.
 *
 * Both functions connect their respective manager, register the resulting
 * tools with the executor, refresh the system-prompt prefix so the model
 * sees the new tools, and surface info events. Identical behavior to the
 * prior in-component callbacks.
 */
import React from "react";

import type { Cfg } from "../app.js";
import type { ChatEvent } from "./view-types.js";
import type { ChatMessage } from "../agent/messages.js";
import type { ToolSpec } from "../tools/registry.js";
import type { ToolExecutor } from "../tools/executor.js";
import { toolsForSession } from "../tools/executor.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspManager } from "../lsp/manager.js";
import { makeLspTools } from "../tools/lsp.js";
import { buildSessionPrefix, buildSystemPrompt } from "../agent/system-prompt.js";
import { DEFAULT_MODEL } from "../config.js";
import type { Mode } from "../mode.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createImportedMcpTool, discoverMcpServers, expandVars, isImportedServerTool, startedLine } from "../import/mcp.js";

type SetEvents = React.Dispatch<React.SetStateAction<ChatEvent[]>>;

interface CommonDeps {
  cfg: Cfg;
  setEvents: SetEvents;
  mkKey: () => string;
  executorRef: React.MutableRefObject<ToolExecutor>;
  messagesRef: React.MutableRefObject<ChatMessage[]>;
  cacheStableRef: React.MutableRefObject<boolean>;
  modeRef: React.MutableRefObject<Mode>;
  mcpToolsRef: React.MutableRefObject<ToolSpec[]>;
  lspToolsRef: React.MutableRefObject<ToolSpec[]>;
  /**
   * Say when it's ready ("MCP connected — …", "LSP ready — …"). Off at
   * startup, which stays quiet (/mcp list and /lsp list show them); on for
   * /mcp reload and /lsp reload. Failures are always said.
   */
  announce?: boolean;
}

export interface InitMcpDeps extends CommonDeps {
  mcpManagerRef: React.MutableRefObject<McpManager>;
  mcpInitRef: React.MutableRefObject<boolean>;
}

export async function initMcp(deps: InitMcpDeps): Promise<void> {
  const {
    cfg, setEvents, mkKey, executorRef, messagesRef, cacheStableRef, modeRef,
    mcpToolsRef, lspToolsRef, mcpManagerRef, mcpInitRef,
  } = deps;

  if (mcpInitRef.current) return;
  // MCP servers from other agents' setups (#1126): offered through one tool,
  // started the first time a task needs one.
  const importedTool = importedMcpTool(deps);
  if (!cfg.mcpServers && !importedTool) return;
  mcpInitRef.current = true;
  const manager = mcpManagerRef.current;
  let totalTools = 0;
  for (const [name, server] of Object.entries(cfg.mcpServers ?? {})) {
    if (server.enabled === false) continue;
    try {
      if (server.type === "local" && server.command && server.command.length > 0) {
        await manager.addLocalServer(name, server.command, expandMap(server.env), {
          timeoutMs: server.timeoutMs,
        });
      } else if ((server.type === "remote" || server.type === "http") && server.url) {
        await manager.addRemoteServer(
          name,
          expandVars(server.url),
          expandMap(server.headers),
          { timeoutMs: server.timeoutMs },
          server.type === "http" ? "http" : "sse",
        );
      } else {
        setEvents((e) => [
          ...e,
          { kind: "error", key: mkKey(), text: `MCP server "${name}" has invalid config` },
        ]);
        continue;
      }
      const tools = manager.getAllTools().filter((t) => !isImportedServerTool(t.name));
      const newTools = tools.filter((t) => !mcpToolsRef.current.some((mt) => mt.name === t.name));
      for (const tool of newTools) {
        executorRef.current.register(tool);
      }
      mcpToolsRef.current = tools;
      totalTools = tools.length;
    } catch (e) {
      setEvents((es) => [
        ...es,
        { kind: "error", key: mkKey(), text: `MCP server "${name}" failed: ${(e as Error).message}` },
      ]);
    }
  }
  if (importedTool) {
    executorRef.current.register(importedTool);
    mcpToolsRef.current = [...mcpToolsRef.current.filter((t) => t.name !== importedTool.name), importedTool];
  }
  if (totalTools > 0 || importedTool) {
    const sessionTools = toolsForSession({
      memoryEnabled: cfg.memoryEnabled,
      extra: [...mcpToolsRef.current, ...lspToolsRef.current],
    });
    if (cacheStableRef.current) {
      messagesRef.current[1] = {
        role: "system",
        content: buildSessionPrefix({
          cwd: process.cwd(),
          tools: sessionTools,
          model: cfg.model ?? DEFAULT_MODEL,
          mode: modeRef.current,
          memoryEnabled: cfg.memoryEnabled,
        }),
      };
    } else {
      messagesRef.current[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: process.cwd(),
          tools: sessionTools,
          model: cfg.model ?? DEFAULT_MODEL,
          mode: modeRef.current,
          memoryEnabled: cfg.memoryEnabled,
        }),
      };
    }
    if (totalTools > 0 && deps.announce !== false) {
      setEvents((e) => [
        ...e,
        {
          kind: "info",
          key: mkKey(),
          text: `MCP connected — ${totalTools} external tool${totalTools === 1 ? "" : "s"} available`,
        },
      ]);
    }
  }
}

/** Expand `${VAR}` in config values, so a token can stay in the environment. */
function expandMap(map: Record<string, string> | undefined): Record<string, string> | undefined {
  if (!map) return undefined;
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, expandVars(v)]));
}

/** The `mcp_imported` tool for this project's servers from other agents, or null. */
function importedMcpTool(deps: InitMcpDeps): ToolSpec | null {
  const { cfg, setEvents, mkKey, mcpManagerRef } = deps;
  const { servers } = discoverMcpServers(process.cwd(), { exclude: Object.keys(cfg.mcpServers ?? {}) });
  return createImportedMcpTool(servers, {
    connect: async (server, launch) => {
      const manager = mcpManagerRef.current;
      if (launch.kind === "local") {
        const env = launch.env ? { ...getDefaultEnvironment(), ...launch.env } : undefined;
        await manager.addLocalServer(server.name, launch.command, env);
      } else {
        await manager.addRemoteServer(server.name, launch.url, launch.headers, undefined, launch.transport);
      }
      const prefix = `mcp_${server.name.replace(/[^a-zA-Z0-9_]/g, "_")}_`;
      return manager.getAllTools().filter((t) => t.name.startsWith(prefix));
    },
    // Its tools stay behind mcp_imported (not registered by name), so usage
    // counts never carry an imported server's name.
    onStarted: (server, tools) => {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: startedLine(server, tools.length) }]);
    },
  });
}

export interface InitLspDeps extends CommonDeps {
  lspManagerRef: React.MutableRefObject<LspManager>;
  lspInitRef: React.MutableRefObject<boolean>;
}

export async function initLsp(deps: InitLspDeps): Promise<void> {
  const {
    cfg, setEvents, mkKey, executorRef, messagesRef, cacheStableRef, modeRef,
    mcpToolsRef, lspToolsRef, lspManagerRef, lspInitRef,
  } = deps;

  if (!cfg.lspEnabled || !cfg.lspServers || lspInitRef.current) {
    if (lspInitRef.current) return;
    if (!cfg.lspEnabled) {
      return;
    } else if ((!cfg.lspServers || Object.keys(cfg.lspServers).length === 0) && deps.announce !== false) {
      setEvents((es) => [
        ...es,
        { kind: "info", key: mkKey(), text: "LSP reload complete — no servers configured." },
      ]);
    }
    return;
  }
  lspInitRef.current = true;
  const manager = lspManagerRef.current;
  let totalServers = 0;
  for (const [name, server] of Object.entries(cfg.lspServers)) {
    if (server.enabled === false) continue;
    try {
      await manager.startServer(name, server, process.cwd());
      totalServers++;
    } catch (e) {
      setEvents((es) => [
        ...es,
        { kind: "error", key: mkKey(), text: `LSP server "${name}" failed: ${(e as Error).message}` },
      ]);
    }
  }
  if (totalServers > 0) {
    const tools = makeLspTools(manager);
    for (const tool of tools) {
      executorRef.current.register(tool);
    }
    lspToolsRef.current = tools;
    const sessionTools = toolsForSession({
      memoryEnabled: cfg.memoryEnabled,
      extra: [...mcpToolsRef.current, ...lspToolsRef.current],
    });
    if (cacheStableRef.current) {
      messagesRef.current[1] = {
        role: "system",
        content: buildSessionPrefix({
          cwd: process.cwd(),
          tools: sessionTools,
          model: cfg.model ?? DEFAULT_MODEL,
          mode: modeRef.current,
          memoryEnabled: cfg.memoryEnabled,
        }),
      };
    } else {
      messagesRef.current[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: process.cwd(),
          tools: sessionTools,
          model: cfg.model ?? DEFAULT_MODEL,
          mode: modeRef.current,
          memoryEnabled: cfg.memoryEnabled,
        }),
      };
    }
    if (deps.announce !== false) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `LSP ready — ${totalServers} server${totalServers === 1 ? "" : "s"} active` },
      ]);
    }
  } else {
    setEvents((e) => [
      ...e,
      {
        kind: "info",
        key: mkKey(),
        text: "LSP reload complete — no servers started (check config or enabled status).",
      },
    ]);
  }
}
