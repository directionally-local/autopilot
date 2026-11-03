# Autopilot — Project Instructions

> Project context for coding agents. Refreshed 2026-10-01.

## Project

**Autopilot** (autopilot-ai, formerly KimiFlare) is a TypeScript terminal coding agent. OpenRouter with the user's own key is the default provider; users can also choose OpenAI, DeepSeek, Moonshot, Kimi Code, Z.ai, Ollama, LM Studio, Requesty or any OpenAI-compatible endpoint (src/providers/). Do not assume the old Cloudflare AI Gateway / Workers AI architecture still applies.

- Node.js versions supported by `package.json`'s `engines` (`^22.23.4 || ^24.22.1 || >=26.12.1`); TypeScript 5.7; ESM.
- Interactive terminal UI plus one-shot print and JSON-RPC/SDK modes.
- Main package: autopilot-ai; license: MIT.

## Build, test, run

| Command | Purpose |
| --- | --- |
| npm install | Install dependencies |
| npm run dev | Run the CLI from src/index.tsx |
| npm run build | Bundle CLI and SDK with tsup into dist/ |
| npm run typecheck | Type-check with tsc --noEmit |
| npm test | Run co-located tests with Node's test runner through tsx |
| npm run test:file -- <files> | Run chosen test files with the same isolation as npm test |
| npm start | Run the built CLI |

Run a focused test with `npm run test:file -- src/path/to/file.test.ts` (or `npx tsx --test --import ./scripts/test-setup.mjs src/path/to/file.test.ts`). Tests use node:test and node:assert; there is no Jest/Vitest setup.

Tests never touch the real home. scripts/test-setup.mjs is loaded with `--import` before any test module, in the runner and in every test process: it creates a fresh temporary root per process and points HOME, USERPROFILE, XDG_CONFIG_HOME, XDG_DATA_HOME, XDG_STATE_HOME, XDG_CACHE_HOME, CLAUDE_CONFIG_DIR and AUTOPILOT_SERVER_CONFIG inside it, clears inherited AUTOPILOT_/KIMIFLARE_ path overrides (TRACE_DIR, DUMP_LLM_DIR, REMOTES_FILE, ASTER_CONFIG), and removes the root on exit (AUTOPILOT_TEST_KEEP_ROOT=1 keeps it). A bare `npx tsx --test file` skips that setup; src/util/app-dirs.ts then throws when a test resolves a directory in the real home, so such a run fails instead of reading or writing your files. A test that needs its own home sets HOME or XDG_*_HOME to its own temp directory, or passes an env to the app-dirs helpers. Code that reads machine-wide files (such as /etc/autopilot) takes the path as a parameter so tests can pass a temp one.

## Repository map

- src/index.tsx — Commander CLI entry point and mode/command routing.
- src/app.tsx, src/ui/ — interactive app state and terminal UI components.
- src/agent/ — OpenRouter client, streaming/tool-call turn loop, prompts, session and supervisor logic.
- src/providers/ — provider presets (base URL, key env vars, default/plumbing/embedding models, request quirks, OpenRouter-only capabilities) and resolution of the active provider. Every LLM call, catalog, cost and feature gate follows it; providers/openrouter-guard.test.ts keeps OpenRouter access inside the provider layer.
- src/models/ — model catalogs (OpenRouter live catalog, Requesty, models.dev for other hosted providers with a bundled snapshot, Ollama/LM Studio discovery), capabilities, and pricing.
- src/tools/ — tool schemas, implementations, permissions, output reduction, and dispatch (executor.ts).
- src/init/ — /init project discovery and AGENTS.md prompt generation.
- src/skills/ — skill discovery/routing; supports .agents/skills/, AGENTS.md, .github/skills/, .autopilot/skills/ and the legacy .kimiflare/skills/.
- src/memory/ — local SQLite-backed cross-session memory and retrieval. The repository-scoped database defaults to .autopilot/memory.db (an existing .kimiflare/memory.db is still used; configurable); memory tools expose remember, recall, and forget.
- src/lsp/, src/mcp/ — Language Server Protocol and Model Context Protocol integrations.
- src/sdk/, src/server/ — programmatic session SDK and RPC/server integration.
- src/runs/, src/jobs/ — durable run/job lifecycle and unattended execution.
- src/trace/ — opt-in local session tracing (KIMIFLARE_TRACE=1): append-only trace.jsonl plus content-addressed blobs per session, redacted at write time; see docs/plans/trace-and-dataset-dev-plan.md.
- src/transcript/ — Claude Code-format JSONL transcript (<sessionsDir>/<id>.jsonl) appended from runAgentTurn; hook payloads point transcript_path at it (transcript_format "claude-jsonl"); KIMIFLARE_TRANSCRIPT=0 turns it off.
- src/eval/, evals/ — headless eval runner (`autopilot eval run` / `autopilot eval compare`): runs the agent on a task set under a harness config and compares arms with a paired McNemar test; evals/tasks/autopilot-bench holds 20 tasks mined from this repo's merged PRs (recipe in evals/README.md).
- src/code-mode/ — generated TypeScript tool execution and sandboxing.
- src/hooks/, src/intent/, src/cost-attribution/, src/util/ — lifecycle hooks, intent routing, cost reporting, and shared utilities.
- acp/ — standalone Zed Agent Client Protocol package.
- feedback-worker/ — separate feedback service; docs/ and functions/ support the GitHub Pages site.
- bin/ — published CLI shims; dist/ is generated output.

## Conventions and guardrails

- Keep the project ESM-only. Use import/export, node: prefixes for built-ins, and .js extensions in relative TypeScript imports.
- TypeScript is strict (noUncheckedIndexedAccess, noImplicitOverride, isolatedModules). Keep tests co-located as *.test.ts / *.test.tsx.
- Prefer async/await; use type-only imports (import type) when appropriate.
- When adding a tool, define its schema/implementation and register it in ALL_TOOLS in src/tools/executor.ts; cover behavior with a co-located test.
- Pass and respect AbortSignal for long-running work, especially requests and streams.
- Keep ink, react, commander, turndown, and camouflage-tui external in the root tsup.config.ts; do not accidentally bundle runtime UI dependencies.
- isolated-vm is an optional dependency; preserve its graceful fallback: without it, Code Mode turns off and tools are called directly (src/agent/loop.ts). Never run model-written code in node:vm, which cannot contain it. camouflage-tui is a required dependency (the only interactive renderer): when it cannot start, the CLI explains why and exits 2 (src/camouflage-launch.ts) rather than falling back to Ink.
- Before considering a change complete, run `npm run typecheck`, `npm test`, and `npm run build`; add or update tests for behavior changes.
- Keep `.github/workflows/ci.yml`'s Node matrix aligned with the supported lines in `package.json`'s `engines`. Do not add an unsupported Node major to CI unless support is intentionally restored and installation, tests, and build pass on it.
- Mark behaviour changes that can silently break existing users (hook semantics, config paths, CLI flags, API responses) as breaking: `feat!:`/`fix!:` plus a `BREAKING CHANGE:` footer with the migration, so release-please surfaces them.
- Use Conventional Commits. Do not bump the root package version manually; release-please manages releases. The active workflows publish npm releases and deploy docs/ to GitHub Pages.
- **Versioning: merge the release PR when it is worth a version, not when a PR merges.** release-please opens a release PR on every push to main; leave it open until it has at least three user-visible changes (`feat:`/`fix:`/`perf:`) or an urgent fix (security, broken install, data loss). Never merge it for a single PR. Do not open extra release PRs by hand.
- **Reserve `feat:` for user-visible features.** Internal work uses `refactor:`, `test:`, `docs:`, `ci:`, `build:`, or `chore:` — release-please hides those and they do not bump the version. `fix:` and `perf:` bump patch; `feat:` bumps minor. A change that only reorganizes code, adds tests, or updates docs is not a feature.
- Never commit secrets or user state. .autopilot/, .kimiflare/, ~, .config/, sessions/, and coverage output are ignored. User-level directories come only from src/util/app-dirs.ts (`~/.config/autopilot`, `~/.local/share/autopilot`, `~/.local/state/autopilot`, project `.autopilot/`); never build a `kimiflare` path elsewhere. Legacy kimiflare directories are moved there once at startup and left as symlinks; project `.kimiflare/` is only read.

## Context file behavior

/init creates AGENTS.md when no supported project context file exists. It refreshes an existing AGENTS.md first, or otherwise preserves and refreshes legacy KIMI.md, KIMIFLARE.md, or AGENT.md in place. The system prompt loads AGENTS.md before those legacy names. Keep this file focused on stable project facts and actionable conventions; verify claims against the source when they may have changed.
