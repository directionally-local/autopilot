# Code Mode Implementation Plan

> Derived from [Issue #146](https://github.com/directionally-local/autopilot/issues/146)  
> Goal: Implement a local TypeScript sandbox that replaces native tool-calling with generated TS APIs, targeting ~80% token reduction.

---

## 1. Overview

**What:** Instead of sending N individual tool definitions to the LLM, send a single `execute_code` tool plus a generated TypeScript `.d.ts` API. The LLM writes a TS script; we run it in a locked-down sandbox; only `console.log()` output returns to the LLM context.

**Why:** Intermediate data (file reads, grep results, etc.) never enters the LLM context window — only the final script output does.

**Non-goal:** Removing the existing tool-calling path. Code Mode lives alongside it, toggleable via config.

---

## 2. Architecture Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Sandbox engine | `isolated-vm` (primary) | Real V8 isolate, no shared heap, can block `require`/`fetch` completely. |
| Sandbox fallback | Node `vm` module | If `isolated-vm` fails to compile (e.g., Apple Silicon + Node 20 quirks). Documented security trade-off. |
| API generation | Deterministic string builder | No templating engine needed; stable ordering makes caching trivial. |
| Permission flow | Async bindings that yield to main thread | `isolated-vm` `Reference` / `Transferable` can bridge async calls back to the TUI loop. |
| MCP support | Prefix namespaces (`mcp_gitmcp_search`) | Keeps generated API flat and predictable. |

---

## 3. Implementation Phases

### Phase 0 — Spike & Dependency
**Goal:** Validate `isolated-vm` installs and runs on target platforms (macOS, Linux, Node ≥20).

- [ ] Add `isolated-vm` to `package.json`.
- [ ] Create `src/code-mode/spike.ts` — minimal script that compiles TS in an isolate, exposes a dummy `api.read()`, and returns `console.log` output.
- [ ] Test on macOS (dev machine) and in CI-like Linux container.
- [ ] If native build fails, prototype the `vm` fallback and measure security surface.
- [ ] **Gate:** Spike must pass before Phase 1 begins.

### Phase 1 — TypeScript API Generator
**Goal:** Convert `ToolSpec[]` into a deterministic TS declaration string.

- [ ] Create `src/code-mode/api-generator.ts`.
- [ ] Implement `generateTypeScriptApi(tools: ToolSpec[]): string`.
  - Map JSON Schema `parameters` → TS interfaces (handle `string`, `number`, `boolean`, `array`, `object`, optional fields).
  - Emit JSDoc from `description`.
  - Emit `declare const api: { ... }` with one method per tool.
  - Prefix MCP tools with `mcp_<server>_`.
- [ ] Add unit-level sanity tests (not a full test suite): snapshot the generated API for `ALL_TOOLS` and assert it compiles with `tsc --noEmit`.
- [ ] Cache the generated string per session; invalidate only when MCP tool list changes.

### Phase 2 — Secure Sandbox
**Goal:** Run untrusted TS with zero network/fs access, exposing only our API bindings.

- [ ] Create `src/code-mode/sandbox.ts`.
- [ ] Implement `runInSandbox(code: string, bindings: SandboxBindings): Promise<SandboxResult>`.
  - Compile TS → JS via `esbuild` or `tsx` (or use `isolated-vm`’s built-in compile if we pre-transpile).
  - Enforce timeout (30s) and memory limit (128MB).
  - Block `require`, `fetch`, `fs`, `child_process`, `eval`, `Function`.
  - Inject `console.log` capture.
- [ ] Implement async bridge for tool calls:
  - Inside isolate: `api.read(...)` returns a Promise.
  - Outside isolate: the main thread receives the call, runs `ToolExecutor.run()`, awaits permission if needed, and returns the result back into the isolate.
- [ ] Graceful error handling: syntax errors, runtime exceptions, timeouts, memory exhaustion → caught and returned as `SandboxResult.error`.

### Phase 3 — Permission Integration
**Goal:** Mutating operations inside a script still trigger the existing `PermissionModal`.

- [ ] In the async bridge, inspect `ToolSpec.needsPermission` before executing.
- [ ] If permission is required, pause the isolate (or let the Promise hang) while the TUI shows the modal.
  - `isolated-vm` note: Promises can be resolved externally via `context.evalClosure` returning a Promise that we resolve later.
- [ ] On approval: resume with tool result.
- [ ] On denial: reject the Promise with a descriptive error that the LLM script can catch.
- [ ] Ensure batch rendering: if a script calls 5 tools, the TUI should show them grouped (e.g., "5 operations") with an expander.

### Phase 4 — Agent Loop Integration
**Goal:** Wire Code Mode into `runAgentTurn()`.

- [ ] Modify `src/agent/loop.ts`:
  - Add `codeMode?: boolean` to `AgentTurnOpts`.
  - When enabled, pass a single `execute_code` tool definition instead of `toOpenAIToolDefs(opts.tools)`.
  - The tool description includes the generated TS API string.
- [ ] On `execute_code` tool call:
  - Run sandbox.
  - Collect `console.log` output + any errors.
  - Push one `role: "tool"` message back to `opts.messages`.
- [ ] Preserve streaming: sandbox execution happens between LLM turns, so streaming from the LLM itself is unchanged.

### Phase 5 — TUI & Config
**Goal:** User can toggle Code Mode and see what’s happening.

- [ ] Modify `src/config.ts`:
  - Add `codeMode?: boolean` to `KimiConfig`.
  - Read `KIMIFLARE_CODE_MODE` env var.
- [ ] Modify `src/ui/status.tsx`:
  - Show "CODE" indicator when Code Mode is active.
- [ ] Modify `src/app.tsx`:
  - Add keybinding or command to toggle Code Mode mid-session.
  - Render script execution as a grouped operation in chat history.
- [ ] Onboarding: if config is missing, ask user once whether to enable Code Mode (explain token savings).

### Phase 6 — Benchmark & Validation
**Goal:** Prove the token savings claim.

- [ ] Create `scripts/benchmark-code-mode.ts`.
  - Define a standard task: "Read 5 files and summarize their exports."
  - Run task in native tool-calling mode; record token usage (prompt + completion).
  - Run task in Code Mode; record token usage.
  - Print comparison.
- [ ] Acceptance criteria:
  - `npm run typecheck` passes.
  - `npm run build` succeeds.
  - Code Mode works with and without AI Gateway.
  - MCP tools appear in generated API when servers are connected.
  - Errors in LLM-generated code are caught and returned gracefully.

---

## 4. File Inventory

| Action | Path | Notes |
|--------|------|-------|
| **Create** | `src/code-mode/api-generator.ts` | Phase 1 |
| **Create** | `src/code-mode/sandbox.ts` | Phase 2 |
| **Create** | `src/code-mode/index.ts` | Public exports |
| **Create** | `src/code-mode/spike.ts` | Phase 0; can be deleted after gate |
| **Create** | `scripts/benchmark-code-mode.ts` | Phase 6 |
| **Modify** | `src/agent/loop.ts` | Phase 4 |
| **Modify** | `src/app.tsx` | Phase 5 |
| **Modify** | `src/config.ts` | Phase 5 |
| **Modify** | `src/ui/status.tsx` | Phase 5 |
| **Modify** | `package.json` | Add `isolated-vm`, maybe `esbuild` |

---

## 5. Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| `isolated-vm` native build fails on user machine | High | Provide `vm` fallback; document it as less secure but functional. |
| Async permission bridge deadlocks TUI | High | Spike this first in Phase 0; use Promise-based resolution, not synchronous blocking. |
| LLM writes infinite loops | Medium | Hard timeout (30s) + memory limit; kill isolate cleanly. |
| Generated TS API is too large for tool description | Medium | If API string exceeds model context, compress descriptions or split into categories. Measure size first. |
| MCP tools change mid-session | Low | Invalidate API cache on MCP reconnect; rare in practice. |
| Token savings less than claimed | Medium | Benchmark in Phase 6 before defaulting Code Mode to `on`. |

---

## 6. Suggested Order of Work

1. **Phase 0** — Validate sandbox feasibility (1–2 days).
2. **Phase 1** — API generator (1 day).
3. **Phase 2** — Sandbox core + error handling (2–3 days).
4. **Phase 3** — Permission bridge (1–2 days).
5. **Phase 4** — Agent loop wiring (1 day).
6. **Phase 5** — Config + TUI polish (1 day).
7. **Phase 6** — Benchmark + acceptance (1 day).

**Total rough estimate:** 1–1.5 weeks of focused work.

---

## 7. Open Questions

1. Should we pre-transpile LLM-generated TS with `esbuild`/`tsx`, or ask the model to output plain JS?
2. Do we want to expose `console.error` in addition to `console.log`?
3. Should the sandbox support top-level `await`?
4. How do we surface tool-render UI (diffs, file previews) when they execute inside a script group?
