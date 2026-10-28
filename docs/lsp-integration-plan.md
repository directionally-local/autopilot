# LSP Integration Plan

> Derived from [Issue #181](https://github.com/directionally-local/autopilot/issues/181)  
> Goal: Integrate Language Server Protocol clients to give the agent semantic code intelligence — go-to-definition, find-references, hover types, workspace symbols, diagnostics, and refactoring.

---

## 1. Overview

**What:** KimiFlare spawns and communicates with LSP servers (e.g., `typescript-language-server`, `pyright`, `rust-analyzer`, `gopls`) over stdio. LSP capabilities are exposed as native tools the LLM can call. The agent gains precise, project-aware understanding without relying solely on text search.

**Why:** Current code exploration is limited to `read`, `grep`, and `glob`. These are lexical — they don't understand imports, inheritance, type hierarchies, or call graphs. LSP closes that gap with semantic queries that are fast and accurate.

**Non-goals:**
- Full IDE experience (no inline completions, no real-time diagnostics panel).
- Replacing existing tools — LSP complements `read`/`grep`.
- Bundling language servers — users bring their own (like MCP servers).

---

## 1.5 Guardrail Compliance Summary

This plan is designed to satisfy the [AI Development Guardrails](../guardrails/README.md). Key mappings:

| Guardrail Section | How This Plan Complies |
|-------------------|------------------------|
| **1.1** TypeScript strictness | All new code uses strict types; `noUncheckedIndexedAccess` guards on all array/object accesses. |
| **1.2** ESM conventions | All imports use `.js` extensions and `node:` prefix for built-ins. |
| **1.3** Runtime error prevention | Every `JSON.parse()` wrapped; every `await` on I/O has error handling; `AbortSignal` propagated through LSP requests. |
| **1.4** File size limits | LSP responses > 100 KB are rejected; tool outputs pass through reducer. |
| **2.1** Prompt cache stability | LSP tool list is sorted deterministically before entering system prompt; no volatile data in tool descriptions. |
| **2.3** Tool output reduction | Explicit reducer config for each LSP tool (max lines, chars, collapse rules). |
| **3.2** Iteration limits | LSP requests timeout at 10 s (configurable); server spawn timeout at 30 s. |
| **3.3** Permission model | Read-only LSP tools need no permission; mutating tools (`lsp_rename`, `lsp_codeAction`) require approval. |
| **6.1** Path safety | All `path` parameters routed through `resolvePath()`; `isPathOutside()` checked before `didOpen`. |
| **6.2** Bash safety | LSP server spawn uses `AbortController` + explicit kill; no shell interpolation in command arrays. |
| **6.3** Secret redaction | LSP `env` values are redacted via `redactSecrets()` before logging or memory storage. |
| **6.5** Sanitization | LSP JSON-RPC responses validated before parsing; malformed messages return actionable errors. |
| **7.1** MCP lifecycle parity | LSP tools follow the same register/unregister pattern as MCP; reload clears old registrations. |
| **8.1** Test coverage | Every LSP tool has a unit test; every LSP client method has a connection mock test. |
| **9.2** Feature flag hygiene | Global `lspEnabled` defaults to `false`; per-server `enabled` defaults to `true` only when `lspEnabled` is `true`. |
| **9.3** Determinism | Tool list sorted by name; server capabilities cached in deterministic order. |
| **9.4** Graceful degradation | If no LSP servers are configured or all crash, kimiflare starts normally with zero LSP tools registered. |

---

## 2. Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| LSP client library | `vscode-languageserver-protocol` + custom stdio transport | We already manage stdio for MCP; no heavy client needed. The protocol package gives us typed messages. |
| Server lifecycle | On-demand per workspace | Start a server the first time an LSP tool is called for a given language. Keep alive until session ends. Avoids startup cost on every tool call. |
| Multi-root | One client per `(serverId, rootUri)` | A user may have multiple TS projects open; each gets its own `tsserver` instance. |
| Tool granularity | One tool per LSP method | Keeps descriptions focused and lets the model pick precisely. Methods are mapped 1:1 to `ToolSpec`. |
| Result shaping | Collapse large responses | `Symbol[]` and `Location[]` can be huge. Explicit reducer config per LSP tool (see §2.1). |
| Diagnostics caching | Publish-diagnostics model | Servers push diagnostics after `didOpen`/`didChange`. We cache the latest set and serve it synchronously via a tool. |
| Permission model | `needsPermission: false` for reads, `true` for writes | `lsp_hover`, `lsp_definition` are safe. `lsp_rename`, `lsp_codeAction` mutate code and require approval. |
| Error handling | `try/catch` + `AbortSignal` at every I/O boundary | JSON-RPC parse errors, server crashes, and timeouts must return actionable error strings, not throw uncaught. |
| Path safety | `resolvePath()` + `isPathOutside()` | Every file path from the model is resolved against `cwd` and checked before entering the LSP client. |
| Secret redaction | `redactSecrets()` on env vars | LSP server `env` values are redacted before any log, event, or memory write. |

---

## 3. User Experience

### 3.1 Configuration

```json
{
  "lspServers": {
    "typescript": {
      "command": ["typescript-language-server", "--stdio"],
      "env": { "TSSERVER_LOG_FILE": "/tmp/tsserver.log" },
      "enabled": true,
      "rootPatterns": ["tsconfig.json", "package.json"]
    },
    "python": {
      "command": ["pyright-langserver", "--stdio"],
      "enabled": true
    }
  }
}
```

- `command`: stdio invocation (same pattern as MCP `local` servers).
- `env`: optional environment variables.
- `enabled`: toggle without deleting config.
- `rootPatterns`: files that identify the project root (fallback to `cwd`).

### 3.2 Feature Flag

LSP integration is gated behind a global flag:

```json
{
  "lspEnabled": false
}
```

- **Default:** `false` (guardrail 9.2 — new features default off until proven stable).
- When `lspEnabled` is `false`, the `lspServers` field is ignored and no LSP code is loaded.
- When `lspEnabled` is `true`, each server in `lspServers` respects its own `enabled` field (default `true`).

### 3.3 Discovery

On startup, if `lspEnabled` is `true` and `lspServers` is configured, the TUI prints:

```
LSP ready — typescript (2 workspaces), python (1 workspace)
```

If a server fails to start:

```
LSP server "typescript" failed: spawn typescript-language-server ENOENT
```

### 3.4 Tool Output Reduction

Every LSP tool output passes through `reduceToolOutput` with LSP-specific config (guardrail 2.3):

| Tool | Max Lines | Max Chars | Collapse Rule |
|------|-----------|-----------|---------------|
| `lsp_hover` | 30 | 2000 | Keep markdown, truncate signatures |
| `lsp_definition` | 50 | 3000 | One line per location |
| `lsp_references` | 50 | 3000 | One line per location; dedupe by path |
| `lsp_documentSymbols` | 60 | 3000 | Hierarchical outline, collapse children |
| `lsp_workspaceSymbol` | 40 | 2500 | One line per symbol |
| `lsp_diagnostics` | 40 | 2500 | Group by severity; truncate message |
| `lsp_rename` | no limit | no limit | Returns `WorkspaceEdit` — bypass reducer so diff preview works |
| `lsp_codeAction` | 30 | 2000 | One line per action |

These defaults must not be relaxed without cost justification.

### 3.5 Tool Examples

The model sees tools like:

- `lsp_hover` — "Show type signature and documentation for a symbol at a file:line:column."
- `lsp_definition` — "Jump to the definition of a symbol."
- `lsp_references` — "Find all references to a symbol across the workspace."
- `lsp_documentSymbols` — "List all symbols defined in a file (classes, functions, variables)."
- `lsp_workspaceSymbol` — "Search symbols across the entire workspace by name."
- `lsp_diagnostics` — "Get current errors, warnings, and hints for a file."
- `lsp_codeAction` — "Get available quick fixes or refactorings for a diagnostic range."
- `lsp_rename` — "Rename a symbol and return the workspace edits."
- `lsp_implementation` — "Find implementations of an interface or abstract method."
- `lsp_typeDefinition` — "Jump to the type definition of a symbol."
- `lsp_callHierarchy` — "Show incoming or outgoing calls for a function."
- `lsp_inlayHints` — "Get inlay type hints for a file or range."

---

## 4. Implementation Phases

### Phase 1 — Core LSP Client (Week 1)

**New files:**
- `src/lsp/protocol.ts` — Thin wrapper around `vscode-languageserver-protocol` messages. Types for requests, notifications, and responses we care about.
- `src/lsp/connection.ts` — Stdio transport: spawn child process, wire stdin/stdout, JSON-RPC framing, request/response correlation (id matching), notification dispatch.
- `src/lsp/manager.ts` — `LspManager` class:
  - `startServer(id: string, config: LspServerConfig, rootUri: string): Promise<void>`
  - `stopServer(id: string, rootUri: string): Promise<void>`
  - `getClient(id: string, rootUri: string): LspClient | undefined`
  - `listActive(): Array<{ id: string; rootUri: string; state: 'starting' | 'running' | 'crashed' }>`
  - Auto-restart with exponential backoff (max 3 attempts).
- `src/lsp/client.ts` — `LspClient` class:
  - Wraps a single connection.
  - Implements initialize/shutdown lifecycle.
  - Maintains open document cache (`didOpen`/`didClose`/`didChange`).
  - Caches latest diagnostics per URI.
  - Generic `request(method, params)` and `notify(method, params)`.

**Key design points:**
- Use `URL.fileURLToPath` / `pathToFileURL` for URI ↔ path conversion.
- Document sync: `TextDocumentSyncKind.Incremental` is ideal but `Full` is acceptable for v1 (we re-send the whole file on every change).
- Keep a map of open documents so the server has content without requiring the file to exist on disk in its latest state.
- **Error handling (guardrail 1.3):** Every JSON-RPC message parsed via `JSON.parse()` is wrapped in `try/catch`. Malformed messages return `"LSP protocol error: invalid JSON-RPC message"` rather than crashing.
- **AbortSignal (guardrail 1.3, 3.2):** All LSP requests accept an `AbortSignal` and reject with `"LSP request cancelled"` on abort. Server spawn uses `AbortController` with a 30 s timeout.
- **Determinism (guardrail 9.3):** Server capabilities are cached in a `Map` keyed by `(serverId, rootUri)`; tool list is sorted alphabetically before registration.

### Phase 2 — Tool Definitions (Week 1–2)

**New file:**
- `src/tools/lsp.ts` — Exports `lspTools: ToolSpec[]` and a factory `makeLspTools(manager: LspManager): ToolSpec[]`.

**Tools to implement (v1):**

| Tool | LSP Method | Permission |
|------|-----------|------------|
| `lsp_hover` | `textDocument/hover` | no |
| `lsp_definition` | `textDocument/definition` | no |
| `lsp_references` | `textDocument/references` | no |
| `lsp_documentSymbols` | `textDocument/documentSymbol` | no |
| `lsp_workspaceSymbol` | `workspace/symbol` | no |
| `lsp_diagnostics` | Cached from `textDocument/publishDiagnostics` | no |
| `lsp_rename` | `textDocument/rename` | yes |
| `lsp_codeAction` | `textDocument/codeAction` | yes |

**Parameter schema (common):**
- `path`: file path (converted to URI internally).
  - **Path safety (guardrail 6.1):** All paths are resolved via `resolvePath(ctx.cwd, args.path)` and checked with `isPathOutside()` before entering the LSP client. Paths outside `cwd` are rejected with an error.
- `line`: 1-based line number (converted to 0-based for LSP).
- `column`: 1-based column number (converted to 0-based for LSP).
- `character` / `offset` aliases accepted where intuitive.

**Result shaping:**
- `Location` → `path:line:column` string.
- `Hover` → markdown content (LSP markdown is already well-formed).
- `Diagnostic[]` → concise table: severity | message | line | code.
- `WorkspaceEdit` → same format as our existing diff preview (for permission modal).

### Phase 3 — Integration with Agent (Week 2)

**Modified files:**
- `src/config.ts` — Add `LspServerConfig` interface and `lspServers?: Record<string, LspServerConfig>` to `KimiConfig`. Add `lspEnabled?: boolean` (default `false`).
  - **Backward compatibility (guardrail 4.3):** Unknown config fields are already ignored. Existing configs without `lspEnabled` or `lspServers` continue to work unchanged.
  - **Secret redaction (guardrail 6.3):** LSP server `env` values must be redacted via `redactSecrets()` before any log, event, or memory write. The config file itself remains `chmod 600` (existing behavior).
- `src/app.tsx` —
  - Add `lspManagerRef` (similar to `mcpManagerRef`).
  - On `cfg` load, only initialize LSP servers if `cfg.lspEnabled === true`.
  - Register LSP tools with `executorRef.current.register(...)`.
  - Include LSP tools in system prompt tool list (like MCP tools).
  - On session end / exit, shut down all LSP servers gracefully.
  - **Graceful degradation (guardrail 9.4):** If `lspEnabled` is `false` or all servers fail to start, kimiflare starts normally with zero LSP tools registered.
- `src/tools/executor.ts` — Import and include `lspTools` in `ALL_TOOLS` (or keep dynamic registration only; either works).
- `src/mode.ts` — `isBlockedInPlanMode`: block `lsp_rename` and `lsp_codeAction` (mutating), allow read-only LSP tools.

**System prompt update:**
Add a short paragraph to `buildSystemPrompt` / `buildSessionPrefix`:

> LSP tools are available for semantic code intelligence. Prefer `lsp_definition` over `grep` when looking for the source of a symbol. Prefer `lsp_references` over `grep` when finding usages. Use `lsp_hover` to confirm types before refactoring.

### Phase 4 — Document Sync Bridge (Week 2–3)

**Problem:** The agent frequently writes files via `write`/`edit`. The LSP server needs to know about these changes to give accurate results.

**Solution:** Hook into `ToolExecutor` results. After a successful `write` or `edit`, automatically send `textDocument/didOpen` (if new) or `textDocument/didChange` (if already open) to the relevant LSP client.

**Implementation:**
- In `src/tools/executor.ts`, after `runTool` resolves for `write`/`edit`, emit a new optional callback `onFileChange?: (path: string, content: string) => void`.
- In `src/app.tsx`, wire `onFileChange` to `lspManagerRef.current.notifyChange(path, content)`.
- `LspClient` tracks open documents. On `notifyChange`, send `didChange` with full document content (v1 simplification).

**Edge cases:**
- File deleted by `bash rm` → we won't know. Acceptable for v1; user can restart session.
- Large files → full sync is fine; LSP servers handle it.

### Phase 5 — Polish & Diagnostics (Week 3)

**Features:**
- **Status bar indicator:** Show active LSP server count (e.g., `LSP: 2`). Click or `/lsp` command shows detailed status.
- **Command:** `/lsp` — list active servers, their PIDs, workspace roots, and tool counts.
- **Command:** `/lsp-restart <id>` — manually restart a server.
- **Health check:** Periodically send `$/ping` or use the server's own health mechanism. Mark server as `crashed` if unresponsive.
- **Result reducer integration:** Large `lsp_references` / `lsp_workspaceSymbol` results go through `reduceToolOutput` with a custom config (collapse symbol details, keep locations).

**Tests (guardrail 8.1):**
- `src/lsp/connection.test.ts` — Mock stdio transport, verify JSON-RPC framing, malformed message handling, abort signal propagation.
- `src/lsp/manager.test.ts` — Start/stop lifecycle, auto-restart behavior, graceful degradation when server binary missing.
- `src/lsp/client.test.ts` — Initialize/shutdown lifecycle, document sync, diagnostics caching.
- `src/tools/lsp.test.ts` — One test per LSP tool: parameter conversion (1-based → 0-based), `resolvePath()` safety, result formatting, reducer output byte counts.
- **Cost regression:** Verify `promptTotalApproxTokens` does not regress when LSP is disabled (control benchmark).

---

## 5. File Layout

```
src/
  lsp/
    protocol.ts          # LSP message types & URI helpers
    connection.ts        # Stdio JSON-RPC transport
    client.ts            # Per-server LSP client (initialize, open docs, requests)
    manager.ts           # Multi-server lifecycle & routing
    adapter.ts           # Convert LSP responses to human-readable strings
  tools/
    lsp.ts               # ToolSpec definitions for LSP methods
  config.ts              # + LspServerConfig
  app.tsx                # + lspManagerRef, init, shutdown
  mode.ts                # + plan-mode blocking for mutating LSP tools
```

---

## 6. Dependencies

```json
{
  "vscode-languageserver-protocol": "^3.17.5"
}
```

- No runtime LSP server dependencies — users install their own (`npm i -g typescript-language-server`, etc.).
- `vscode-languageserver-protocol` is pure types + constants; no Node.js bindings.
- **ESM conventions (guardrail 1.2):** All new imports use `.js` extensions and `node:` prefix for built-ins (e.g., `node:child_process`, `node:url`).

---

## 7. Open Questions

1. **Incremental sync vs. full sync:** Full sync is simpler but sends more bytes. Is the complexity of incremental sync worth it for our use case (files are usually < 100 KB)?
2. **Multi-workspace:** Should we auto-detect monorepos and start one server per `tsconfig.json`, or one per configured server ID? Start with one per configured ID + rootPatterns match.
3. **Code lens / inlay hints:** These are UI-heavy features. Do we expose them as tools, or skip them? Skip for v1; add if requested.
4. **Formatting:** `textDocument/formatting` returns `TextEdit[]`. Should we apply it automatically or return it to the model? Return to model — let it decide.
5. **Completion:** `textDocument/completion` is the heart of IDE autocomplete. Not useful for an agent that writes whole files. Skip.

---

## 8. Success Criteria

- [ ] `lsp_hover` returns type info for a TypeScript symbol in < 500 ms.
- [ ] `lsp_definition` jumps across files in a multi-file project.
- [ ] `lsp_references` finds > 90 % of usages that `grep` would miss (e.g., imported aliases, re-exports).
- [ ] `lsp_rename` produces a `WorkspaceEdit` that passes human review in the permission modal.
- [ ] Server crash auto-recovers within 5 seconds.
- [ ] Zero impact on startup time when `lspEnabled` is `false` or unset.
- [ ] All new code passes `npm run typecheck` and `npm run test`.
- [ ] Guardrail compliance: no violations of critical rules (CRIT-1 through CRIT-5 in scoring rubric).
