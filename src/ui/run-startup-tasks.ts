/**
 * Startup-time bookkeeping previously inlined in the App component's main
 * cfg-driven useEffect: local-history size hint, log retention,
 * memory manager init + cleanup + backfill + KIMI.md drift check,
 * skill indexing, and custom-command load.
 *
 * All operations are fire-and-forget and don't block startup. The start is
 * kept nearly silent: the only lines added here are rare and actionable now
 * (the free tier's model fallback, the history-size hint) or caused by the
 * user's own files (a skill that doesn't parse, a custom command shadowed by
 * a built-in). Everything else is explained by its slash command and `/tour`.
 */
import { embeddingAuthFromConfig, llmAuthFromConfig } from "../agent/llm-auth.js";
import { resolveActiveProvider } from "../providers/resolve.js";
import { tuiMemoryEnabled } from "../config.js";
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
import { ignoreProjectDir, projectDir, projectPath } from "../util/app-dirs.js";
import { logger } from "../util/logger.js";

type SetEvents = React.Dispatch<React.SetStateAction<ChatEvent[]>>;

export interface RunStartupTasksDeps {
  cfg: Cfg;
  setCfg: React.Dispatch<React.SetStateAction<Cfg | null>>;
  setEvents: SetEvents;
  mkKey: () => string;
  memoryManagerRef: React.MutableRefObject<MemoryManager | null>;
  sessionStartRecallRef: React.MutableRefObject<((query: string) => Promise<HybridResult[]>) | null>;
  setKimiMdStale: (v: boolean) => void;
  customCommandsRef: React.MutableRefObject<CustomCommand[]>;
  setCustomCommandsVersion: React.Dispatch<React.SetStateAction<number>>;
}

/** The free-tier model check runs once per process (startup tasks rerun on every config change). */
let freeModelChecked = false;

export function runStartupTasks(deps: RunStartupTasksDeps): void {
  const {
    cfg, setCfg, setEvents, mkKey,
    memoryManagerRef, sessionStartRecallRef, setKimiMdStale,
    customCommandsRef, setCustomCommandsVersion,
  } = deps;

  // An `.autopilot/` folder from an earlier version may lack its own .gitignore.
  for (const root of new Set([resolveRepoRoot(process.cwd()), process.cwd()])) ignoreProjectDir(projectDir(root));
  const auth = llmAuthFromConfig(cfg);

  // Not said at startup any more (/tour covers them): the home-folder
  // notice, the free tier's default-model note, the memory disclosure, the
  // setup-import checklist, and counts of what was indexed or cleaned up.

  // On the free tier, a saved model with no tokens left this week runs this
  // session on GPT-6 Luna (said once); the saved choice stays for later.
  if (!freeModelChecked && resolveActiveProvider(cfg).id === "directionally-local" && !process.env.KIMI_MODEL) {
    freeModelChecked = true;
    const startModel = cfg.model;
    void import("../providers/directionally-local.js")
      .then(async ({ fetchDlMe, freeModelFallback, lastKnownDlMe }) => {
        const me = lastKnownDlMe() ?? (await fetchDlMe().catch(() => null));
        const fallback = freeModelFallback(cfg, me);
        if (!fallback) return;
        // Someone who already picked a model this session keeps it.
        setCfg((current) => (current && current.model === startModel ? { ...current, model: fallback.cfg.model } : current));
        setEvents((e) => [...e, { kind: "info", key: mkKey(), text: fallback.notice }]);
      })
      .catch(() => {
        // Non-fatal: the service's own limit message still applies.
      });
  }

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

  // Initialize memory manager if enabled (on by default in the TUI, #1077)
  if (tuiMemoryEnabled(cfg)) {
    const repoRoot = resolveRepoRoot(process.cwd());
    const dbPath = cfg.memoryDbPath ?? projectPath(repoRoot, "memory.db");
    const manager = new MemoryManager({
      dbPath,
      ...auth,
      model: cfg.model,
      plumbingModel: cfg.plumbingModel,
      extractionModel: cfg.memoryExtractionModel,
      extraction: cfg.memoryExtraction,
      embeddingModel: cfg.memoryEmbeddingModel,
      embeddingAuth: embeddingAuthFromConfig(cfg),
      maxAgeDays: cfg.memoryMaxAgeDays ?? RETENTION.memoryMaxAgeDays,
      maxEntries: cfg.memoryMaxEntries ?? RETENTION.memoryMaxEntries,
    });
    manager.open();
    memoryManagerRef.current = manager;

    // Run cleanup and backfill on startup, quietly (/memory doctor shows health).
    void manager.cleanup(repoRoot).then((result) => {
      const total = result.oldDeleted + result.excessDeleted + result.duplicatesMerged;
      if (total > 0) logger.info("memory.cleanup", { removed: total });
    });
    void manager.backfill(repoRoot).then((fixed) => {
      if (fixed > 0) logger.info("memory.backfill", { indexed: fixed });
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
  const skillDbPath = cfg.memoryDbPath ?? projectPath(resolveRepoRoot(process.cwd()), "memory.db");
  const skillDb = getMemoryDb() ?? openMemoryDb(skillDbPath);
  initSkillsSchema(skillDb);
  void indexSkills({
    cwd: process.cwd(),
    db: skillDb,
    ...embeddingAuthFromConfig(cfg),
    embeddingModel: cfg.memoryEmbeddingModel,
  }).then((result) => {
    // Quiet on success (/skills list shows them). A skill file that doesn't
    // parse is the user's to fix, so that is said; a failed embedding call
    // falls back to keyword search and is only logged.
    for (const err of result.errors) {
      if (err.startsWith("Failed to parse")) setEvents((e) => [...e, { kind: "info", key: mkKey(), text: `skill index error: ${err}` }]);
      else logger.warn("skills.index", { error: err });
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
