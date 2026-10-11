# Autopilot — Project Instructions

> Project context for coding agents. Refreshed 2026-10-01.

## Project

**Autopilot** (autopilot-ai, formerly KimiFlare) is a TypeScript terminal coding agent. OpenRouter with the user's own key is the default provider, and the model picker uses OpenRouter's live catalog; custom OpenAI-compatible endpoints and a Requesty fallback are also supported. Do not assume the old Cloudflare AI Gateway / Workers AI architecture still applies.

- Node.js 20 or newer; TypeScript 5.7; ESM.
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
| npm start | Run the built CLI |
| npm run build:remote | Build the separate remote/agent project |

Run a focused test with npx tsx --test src/path/to/file.test.ts. Tests use node:test and node:assert; there is no Jest/Vitest setup.

## Repository map

- src/index.tsx — Commander CLI entry point and mode/command routing.
- src/app.tsx, src/ui/ — interactive app state and terminal UI components.
- src/agent/ — OpenRouter client, streaming/tool-call turn loop, prompts, session and supervisor logic.
- src/models/ — OpenRouter model catalog, capabilities, and pricing; live catalog is authoritative, with seed data as offline fallback.
- src/tools/ — tool schemas, implementations, permissions, output reduction, and dispatch (executor.ts).
- src/init/ — /init project discovery and AGENTS.md prompt generation.
- src/skills/ — skill discovery/routing; supports .agents/skills/, AGENTS.md, .github/skills/, and .kimiflare/skills/.
- src/memory/ — local SQLite-backed cross-session memory and retrieval. The repository-scoped database defaults to .kimiflare/memory.db (configurable); memory tools expose remember, recall, and forget.
- src/lsp/, src/mcp/ — Language Server Protocol and Model Context Protocol integrations.
- src/sdk/, src/server/ — programmatic session SDK and RPC/server integration.
- src/runs/, src/jobs/ — durable run/job lifecycle and unattended execution.
- src/trace/ — opt-in local session tracing (KIMIFLARE_TRACE=1): append-only trace.jsonl plus content-addressed blobs per session, redacted at write time; see docs/plans/trace-and-dataset-dev-plan.md.
- src/code-mode/ — generated TypeScript tool execution and sandboxing.
- src/hooks/, src/intent/, src/cost-attribution/, src/util/ — lifecycle hooks, intent routing, cost reporting, and shared utilities.
- src/remote/ — remote command implementation; remote/agent/ is a separate package.
- acp/ — standalone Zed Agent Client Protocol package.
- feedback-worker/ — separate feedback service; docs/ and functions/ support the GitHub Pages site.
- bin/ — published CLI shims; dist/ is generated output.

## Conventions and guardrails

- Keep the project ESM-only. Use import/export, node: prefixes for built-ins, and .js extensions in relative TypeScript imports.
- TypeScript is strict (noUncheckedIndexedAccess, noImplicitOverride, isolatedModules). Keep tests co-located as *.test.ts / *.test.tsx.
- Prefer async/await; use type-only imports (import type) when appropriate.
- When adding a tool, define its schema/implementation and register it in ALL_TOOLS in src/tools/executor.ts; cover behavior with a co-located test.
- Pass and respect AbortSignal for long-running work, especially requests and streams.
- Keep ink, ink-text-input, ink-spinner, ink-select-input, react, commander, turndown, and camouflage-tui external in the root tsup.config.ts; do not accidentally bundle runtime UI dependencies.
- isolated-vm and camouflage-tui are optional dependencies; preserve their graceful/intentional fallback behavior.
- Run npm run typecheck before considering a change complete. Add or update tests for behavior changes.
- Use Conventional Commits. Do not bump the root package version manually; release-please manages releases. The active workflows publish npm releases and deploy docs/ to GitHub Pages.
- Never commit secrets or user state. .kimiflare/, ~, .config/, sessions/, and coverage output are ignored; config and historical user data remain under the legacy kimiflare paths for compatibility.

## Context file behavior

/init creates AGENTS.md when no supported project context file exists. It refreshes an existing AGENTS.md first, or otherwise preserves and refreshes legacy KIMI.md, KIMIFLARE.md, or AGENT.md in place. The system prompt loads AGENTS.md before those legacy names. Keep this file focused on stable project facts and actionable conventions; verify claims against the source when they may have changed.
