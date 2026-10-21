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
import { ALL_TOOLS } from "../tools/executor.js";
import type { McpManager } from "../mcp/manager.js";
import type { LspManager } from "../lsp/manager.js";
import { makeLspTools } from "../tools/lsp.js";
import { buildSessionPrefix, buildSystemPrompt } from "../agent/system-prompt.js";
import { DEFAULT_MODEL } from "../config.js";
import type { Mode } from "../mode.js";

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

  if (!cfg.mcpServers || mcpInitRef.current) return;
  mcpInitRef.current = true;
  const manager = mcpManagerRef.current;
  let totalTools = 0;
  for (const [name, server] of Object.entries(cfg.mcpServers)) {
    if (server.enabled === false) continue;
    try {
      if (server.type === "local" && server.command && server.command.length > 0) {
        await manager.addLocalServer(name, server.command, server.env, {
          timeoutMs: server.timeoutMs,
        });
      } else if (server.type === "remote" && server.url) {
        await manager.addRemoteServer(name, server.url, server.headers, {
          timeoutMs: server.timeoutMs,
        });
      } else {
        setEvents((e) => [
          ...e,
          { kind: "error", key: mkKey(), text: `MCP server "${name}" has invalid config` },
        ]);
        continue;
      }
      const tools = manager.getAllTools();
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
  if (totalTools > 0) {
    if (cacheStableRef.current) {
      messagesRef.current[1] = {
        role: "system",
        content: buildSessionPrefix({
          cwd: process.cwd(),
          tools: [...ALL_TOOLS, ...mcpToolsRef.current, ...lspToolsRef.current],
          model: cfg.model ?? DEFAULT_MODEL,
          mode: modeRef.current,
        }),
      };
    } else {
      messagesRef.current[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: process.cwd(),
          tools: [...ALL_TOOLS, ...mcpToolsRef.current, ...lspToolsRef.current],
          model: cfg.model ?? DEFAULT_MODEL,
          mode: modeRef.current,
        }),
      };
    }
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
    } else if (!cfg.lspServers || Object.keys(cfg.lspServers).length === 0) {
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
    if (cacheStableRef.current) {
      messagesRef.current[1] = {
        role: "system",
        content: buildSessionPrefix({
          cwd: process.cwd(),
          tools: [...ALL_TOOLS, ...mcpToolsRef.current, ...lspToolsRef.current],
          model: cfg.model ?? DEFAULT_MODEL,
          mode: modeRef.current,
        }),
      };
    } else {
      messagesRef.current[0] = {
        role: "system",
        content: buildSystemPrompt({
          cwd: process.cwd(),
          tools: [...ALL_TOOLS, ...mcpToolsRef.current, ...lspToolsRef.current],
          model: cfg.model ?? DEFAULT_MODEL,
          mode: modeRef.current,
        }),
      };
    }
    setEvents((e) => [
      ...e,
      { kind: "info", key: mkKey(), text: `LSP ready — ${totalServers} server${totalServers === 1 ? "" : "s"} active` },
    ]);
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
