/**
 * Startup-time bookkeeping previously inlined in the App component's main
 * cfg-driven useEffect: local-history size hint, log retention, creator welcome,
 * memory manager init + cleanup + backfill + KIMI.md drift check,
 * skill indexing, and custom-command load.
 *
 * All operations are fire-and-forget — they surface info events via
 * `setEvents` and otherwise don't block startup. Identical behavior to
 * the prior in-component implementation.
 */
import { embeddingAuthFromConfig, llmAuthFromConfig } from "../agent/llm-auth.js";
import React from "react";
import { existsSync } from "node:fs";
import { join } from "node:path";

import type { Cfg } from "../app.js";
import type { ChatEvent } from "./view-types.js";
import type { CustomCommand } from "../commands/types.js";
import { BUILTIN_COMMAND_NAMES } from "../commands/builtins.js";
import { loadCustomCommands } from "../commands/loader.js";
import { MemoryManager } from "../memory/manager.js";
import { getMemoryDb, openMemoryDb } from "../memory/db.js";
import { resolveRepoRoot } from "../memory/repo-root.js";
import { indexSkills, initSkillsSchema } from "../skills/index.js";

import { RETENTION } from "../storage-limits.js";
import type { HybridResult } from "../memory/schema.js";

type SetEvents = React.Dispatch<React.SetStateAction<ChatEvent[]>>;

export interface RunStartupTasksDeps {
  cfg: Cfg;
  setEvents: SetEvents;
  mkKey: () => string;
  memoryManagerRef: React.MutableRefObject<MemoryManager | null>;
  sessionStartRecallRef: React.MutableRefObject<((query: string) => Promise<HybridResult[]>) | null>;
  setKimiMdStale: (v: boolean) => void;
  customCommandsRef: React.MutableRefObject<CustomCommand[]>;
  setCustomCommandsVersion: React.Dispatch<React.SetStateAction<number>>;
}

export function runStartupTasks(deps: RunStartupTasksDeps): void {
  const {
    cfg, setEvents, mkKey,
    memoryManagerRef, sessionStartRecallRef, setKimiMdStale,
    customCommandsRef, setCustomCommandsVersion,
  } = deps;
  const auth = llmAuthFromConfig(cfg);

  // Sessions and traces are never deleted automatically; once they get big,
  // say so and point at `autopilot history`.
  void import("../local-history.js")
    .then(async ({ historyHint, localHistoryUsage }) => {
      const hint = historyHint(await localHistoryUsage(cfg.trace?.root));
      if (hint) setEvents((e) => [...e, { kind: "info", key: mkKey(), text: hint }]);
    })
    .catch(() => {
      // Non-fatal: the hint is best-effort.
    });

  // Prune old structured logs (M5.1) and surface the current path once.
  void import("../util/log-sink.js").then(({ pruneOldLogs, isLogSinkEnabled }) => {
    if (!isLogSinkEnabled()) return;
    try {
      pruneOldLogs();
    } catch {
      // Non-fatal: log retention is best-effort.
    }
  });

  // Initialize memory manager if enabled
  if (cfg.memoryEnabled) {
    const repoRoot = resolveRepoRoot(process.cwd());
    const dbPath = cfg.memoryDbPath ?? join(repoRoot, ".kimiflare", "memory.db");
    const manager = new MemoryManager({
      dbPath,
      ...auth,
      model: cfg.model,
      plumbingModel: cfg.plumbingModel,
      extractionModel: cfg.memoryExtractionModel,
      embeddingModel: cfg.memoryEmbeddingModel,
      embeddingAuth: embeddingAuthFromConfig(cfg),
      maxAgeDays: cfg.memoryMaxAgeDays ?? RETENTION.memoryMaxAgeDays,
      maxEntries: cfg.memoryMaxEntries ?? RETENTION.memoryMaxEntries,
    });
    manager.open();
    memoryManagerRef.current = manager;

    // Run cleanup and backfill on startup
    void manager.cleanup(repoRoot).then((result) => {
      const total = result.oldDeleted + result.excessDeleted + result.duplicatesMerged;
      if (total > 0) {
        setEvents((e) => [
          ...e,
          { kind: "memory", key: mkKey(), text: `memory cleanup: removed ${total} stale entries` },
        ]);
      }
    });
    void manager.backfill(repoRoot).then((fixed) => {
      if (fixed > 0) {
        setEvents((e) => [
          ...e,
          { kind: "memory", key: mkKey(), text: `memory: indexed ${fixed} entr${fixed === 1 ? "y" : "ies"} for ${manager.embeddingModel ?? "vector recall"}` },
        ]);
      }
    });

    // Defer session-start recall until the first turn so it can query with the
    // user's actual prompt instead of the cwd path. Synthesis and injection
    // happen inside runAgentTurn so they are covered by the turn's abort signal.
    const cwd = process.cwd();
    sessionStartRecallRef.current = (query: string) =>
      manager.recall({ text: query || cwd, repoPath: repoRoot, limit: 5 });

    // Session-start drift check (Trigger A): if a project context file exists and high-signal
    // memories have been learned since the last refresh, mark as stale.
    if (["AGENTS.md", "KIMI.md", "KIMIFLARE.md", "AGENT.md"].some((name) => existsSync(join(repoRoot, name)))) {
      const lastRefresh = manager.getLastKimiMdRefreshTime(repoRoot);
      const driftCount = manager.countHighSignalMemoriesSince(repoRoot, lastRefresh);
      if (driftCount >= 5) {
        setKimiMdStale(true);
      }
    }
  } else {
    memoryManagerRef.current?.close();
    memoryManagerRef.current = null;
  }

  // Initialize skills index (independent of memory feature flag)
  const skillDbPath = cfg.memoryDbPath ?? join(resolveRepoRoot(process.cwd()), ".kimiflare", "memory.db");
  const skillDb = getMemoryDb() ?? openMemoryDb(skillDbPath);
  initSkillsSchema(skillDb);
  void indexSkills({
    cwd: process.cwd(),
    db: skillDb,
    ...embeddingAuthFromConfig(cfg),
    embeddingModel: cfg.memoryEmbeddingModel,
  }).then((result) => {
    if (result.indexed > 0) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `indexed ${result.indexed} skill${result.indexed === 1 ? "" : "s"}` },
      ]);
    }
    if (result.errors.length > 0) {
      for (const err of result.errors) {
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `skill index error: ${err}` }]);
      }
    }
  });

  void loadCustomCommands(process.cwd()).then(({ commands, warnings }) => {
    customCommandsRef.current = commands;
    setCustomCommandsVersion((v) => v + 1);
    for (const w of warnings) {
      setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `commands: ${w}` }]);
    }
    const shadowed = commands.filter((c) => BUILTIN_COMMAND_NAMES.has(c.name.toLowerCase()));
    for (const c of shadowed) {
      setEvents((e) => [
        ...e,
        { kind: "info", key: mkKey(), text: `commands: /${c.name} (${c.filepath}) shadowed by built-in — will not run` },
      ]);
    }
  });
}
