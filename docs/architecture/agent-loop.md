# Agent loop architecture

How an Autopilot turn actually executes, from user input to tool execution,
including subagents and mid-turn input. First written against release 1.13.0
(October 2026). Prioritized problems and the work plan live in
[`agent-loop-findings.md`](./agent-loop-findings.md).

## Current state (2.10)

The spine, hosts, tool scheduling, permission modes, subagents and mid-turn
input sections were updated for release 2.10.0. The main changes since 1.13:

- **One turn assembler.** All six hosts build their turn through
  `src/agent/session-core.ts`: `resolveTurnPolicy()` (intent tier, subagent
  guidance, Hotcell readiness, completion check, the tool set) and
  `assembleTurn()` (config-derived options plus the host's IO callbacks).
- **`spawn_worker` is now `subagent`** (`src/tools/subagent.ts`). Old
  sessions that replay `spawn_worker` arguments are mapped onto the new shape.
  It takes `{ mission, context?, background? }`.
- **No clean-checkout requirement.** Subagents see the current working tree,
  including uncommitted changes: it is archived and streamed into the
  sandbox, with secrets such as `.env` excluded (`src/tools/hotcell-snapshot.ts`).
  See [`../subagents.md`](../subagents.md).
- **Parallel subagents.** `subagent` is a `concurrent` tool, so several calls
  in one response run in parallel behind a single permission prompt.
- **Modes are opt-in.** Interactive turns run in `auto` unless
  `/settings modes on` is set; SDK sessions start in `edit`.
- **Mid-turn input is triaged** (interrupt, steer, queue, aside) instead of
  always being queued.

Sections not listed above (model client, turn loop details, termination,
cancellation, persistence, other subsystems) still describe 1.13 and were not
re-verified; check the code before relying on specific numbers there.

References name files and functions rather than line numbers, so they survive
edits; use `rg` to locate them.

## The spine

```
user input
  │
  ▼
host  (one of six — see "Hosts")
  │  resolveTurnPolicy()         src/agent/session-core.ts
  │    classifyIntent()          src/intent/classify.ts      regex tier: light|medium|heavy
  │    resolveSubagentGuidance() src/intent/subagent-policy.ts  regex + optional Jev
  │    checkHotcellReadiness()   src/tools/hotcell-readiness.ts  only when dispatch is allowed
  │    tool list (subagent filtered by guidance)
  │  assembleTurn()              config + host callbacks → AgentTurnOpts
  │
  ▼
runAgentTurn(opts)               src/agent/loop.ts
  │  pre-turn: session-start memory recall ∥ semantic skill routing
  │  loop:
  │    preflight token estimate vs. model context → throw if over
  │    stream model                runKimi()  src/agent/client.ts
  │    zero tool calls → return
  │    schedule tool calls in contiguous segments:
  │      isReadOnly or concurrent → Promise.all (one permission gate)
  │      otherwise                → sequential
  │    executor.run()              src/tools/executor.ts  (hooks, permission, reducer)
  │    onIterationEnd()            host hook: compaction (TUI/init), steering (SDK)
  ▼
host post-turn: save session, auto-compact (TUI), drain queue
```

A turn is one call to `runAgentTurn`. It loops "stream → execute tools" until
the model answers without tool calls, a guardrail finalizes the turn, a budget
error is thrown, or the abort signal fires.

## Hosts

Six entry points run turns: the TUI (`src/app.tsx`), print mode
(`src/print-mode.ts`), `/init` (`src/init/run-init.ts`), the SDK/RPC session
(`src/sdk/session.ts`), the HTTP server (`src/server/routes.ts`) and emit mode
(`src/emit-mode.ts`). Each calls `resolveTurnPolicy()` and `assembleTurn()`
from `src/agent/session-core.ts`, so intent classification, subagent policy
(the `subagent` tool is only offered when guidance allows dispatch and Hotcell
is ready), the completion check, and config-derived options (credentials,
model, reasoning effort, image retention, iteration ceiling) are the same
everywhere. Hosts supply only IO: rendering and permission callbacks, where
history lives, steering input, compaction, tracing, and host-specific limits
such as `toolLimitBehavior`. A research subagent (`--worker-profile research`)
gets no delegation directive and no completion check.

`TurnSupervisor` (`src/agent/supervisor.ts`) wraps `runAgentTurn` for the TUI
(through `src/ui/use-turn-controller.ts`) and `/init`: a single-flight guard,
a coarse phase, and a kill flag; actual cancellation goes through the
`AbortSignal`.

## Model client — `src/agent/client.ts`

`runKimi(opts)` is an async generator over a streaming chat-completions call.

- **Providers:** OpenRouter with the user's key (default; the model catalog
  comes from OpenRouter, see `src/models/`), a custom OpenAI-compatible
  endpoint (`customEndpoint`, takes precedence), or Requesty when only a
  Requesty key is set.
- **Retries:** up to `MAX_ATTEMPTS = 5`, for network errors, 408, 429 and 5xx.
  Uses full-jitter backoff and honors `Retry-After`, with a cap.
- **Streaming:** SSE with an idle timeout of 60 s before the first byte and
  30 s after it. Both can be overridden per turn.
- **Events:** `response_meta`, `reasoning`, `reasoning_details`, `text`,
  `tool_call_start` / `_args` / `_complete`, `usage`, `done`.

## Turn loop — `src/agent/loop.ts`

### Pre-turn

1. **Memory recall** (one-shot per session): awaits `sessionStartRecall`,
   synthesizes the results, and injects them once (`injectRecalledMemoryOnce`).
2. **Skill routing:** `selectSkills()` embeds the prompt and packs skill
   sections by tier. It's skipped for light prompts under 40 characters.
3. Both run in parallel and race the abort signal. Failures other than an
   abort are swallowed.
4. If skill routing returns, the system message is **rewritten in place**
   (`messages[0]`, or `messages[1]` in cache-stable mode), together with the
   per-turn `delegationDirective`. If routing doesn't return, the directive
   is not applied (#724).

### Per iteration

- **Iteration limits:** `maxToolIterations` defaults to 200.
  `toolLimitBehavior` decides what happens when it's reached: `continue`
  resets the counter (TUI, init, server), `stop` ends the turn (SDK), and
  `throw` raises (the default). `maxTotalToolIterations` is a hard ceiling
  (default 5 × cap), followed by one tool-free summary request.
- **Context preflight:** the estimate must fit
  `contextWindow − maxCompletionTokens (default 16,384) − 8,192` for the
  selected model, otherwise the loop throws and suggests `/compact`.
  Compaction is the host's job (#717).
- **Optional history shaping:** strip historical reasoning
  (`KIMIFLARE_STRIP_REASONING`) and drop images older than
  `keepLastImageTurns`.
- **Tool scheduling:** the calls of one response are split into contiguous
  segments by scheduling class.
  - A segment of more than one call whose tools are all `isReadOnly` or
    `concurrent` (isolated from the workspace, like `subagent`) runs in
    parallel with `Promise.all`. A permission gate
    (`src/agent/permission-gate.ts`) serializes their prompts and coalesces
    same-tool calls, so a batch of subagents needs one approval.
  - Every other call runs sequentially, in order.
- **Per-call guardrails:**
  - Loop detection: the signature is `name + stableStringify(args)`, and the
    3rd identical call within a window of 8 is blocked.
  - Web fetch limits: 5 per turn, at most 2 to the same domain, and 25 per
    session.
  - In Code Mode, direct `read`/`bash`/`grep`/`glob` calls are redirected
    into `execute_code`, at most 4 times per turn.
  - A tool outside the turn's tool list gets an "unavailable" result.
- **Results:** content is truncated at 10,000 characters (`onTruncation`
  fires). Memory extraction runs fire-and-forget per result; errors are
  counted per session.
- **Durable runs:** a tool result carrying `waitRequest` (from `wait_for`)
  ends the turn so the run scheduler can wake it later. This is handled on
  both the parallel and the sequential path.

### Termination

| Condition | Outcome |
| --- | --- |
| Assistant message with no tool calls | pending steers continue the turn; a substantial turn that stopped after only planning gets one "continue" nudge (Jev completion check); otherwise normal return (Stop hook fires) |
| Every call in an iteration blocked | 1st time: recovery instruction; 2nd: tool-free summary, then `AgentLoopError` (exit 43 in print mode) |
| `maxTotalToolIterations` reached | tool-free summary, clean return |
| Cumulative prompt tokens ≥ `maxInputTokens` | `BudgetExhaustedError` (exit 42) |
| Abort signal | `AbortError` |

The loop never blocks waiting on a user decision except through permission
prompts.

## Tools — `src/tools/`

- `ALL_TOOLS` in `executor.ts` is the registry: file, shell, search, web,
  GitHub, browser, HTML artifact, tasks, memory, `subagent`, plan options,
  jobs (`job_start`/`status`/`logs`/`cancel`), `wait_for`, and
  `worker_status`/`worker_result` for background subagents. MCP and LSP tools
  are merged in per session.
- `ToolExecutor.run()` parses the arguments, then:
  1. fires `PreToolUse` hooks (which can veto the call);
  2. checks permission when `needsPermission` is set. Decisions can be
     cached for the session, keyed by tool name, or by command for `bash`.
  3. runs the tool;
  4. reduces the output (per-tool reducers, raw output archived and
     retrievable with `expand_artifact`; diffs pass through unreduced);
  5. fires `PostToolUse` hooks.

  Errors become a failed `ToolResult` with a classified error code instead of
  being thrown.
- **Permission modes** (`src/mode.ts`): `plan` (read-only allowlist),
  `edit` (mutating tools prompt), `auto` (approve everything). In the TUI,
  modes are behind `modesEnabled` (off by default, `/settings modes on`):
  with them off every turn runs in `auto`; with them on the session starts in
  `edit`. SDK sessions start in `edit`.

## Subagents

Workers are **local Hotcell sandboxes only** (#720). Remote and Cloudflare
workers have been removed. User-facing behavior, setup and limits are in
[`../subagents.md`](../subagents.md).

1. **Policy** (`resolveSubagentGuidance`, called from `resolveTurnPolicy`):
   - explicit "don't delegate" → `explicit-sequential`;
   - explicit "use subagents" → `explicit-delegate`;
   - policy `off` → none;
   - sequential-dependency wording → none;
   - explicit parallel wording → `auto-delegate` or `suggest`;
   - light tier → none;
   - policy `auto` (the default) → `auto-delegate`;
   - otherwise Jev decides `suggest`/none for research-flavored prompts.

   When the guidance allows dispatch, `checkHotcellReadiness()` runs; if
   Hotcell can't run a worker the guidance drops to none and the user sees why.
   The result sets a directive string and whether `subagent` is in the tool
   list. The policy never launches a worker itself.
2. **Dispatch:** the model calls `subagent({ mission, context?, background? })`,
   which needs permission (one prompt per parallel batch) and OpenRouter as
   the active provider. `runHotcellWorker()` (`src/tools/hotcell-worker.ts`)
   then:
   1. takes a slot from a process-wide semaphore (at most 3);
   2. archives the working tree, including uncommitted and untracked files
      but excluding secrets, and streams it into the cell; trees too large to
      stream fall back to cloning origin plus a patch of local changes
      (`src/tools/hotcell-snapshot.ts`);
   3. runs the cached Autopilot runtime as a read-only research worker in
      print mode (`--worker-profile research`), with the session's model and
      an egress spend cap;
   4. reads a structured report (summary plus cited findings), then removes
      the cell, which also revokes the gateway token.
3. **Result:** the report comes back as the tool result. With
   `background: true` the call returns a worker id at once; the findings are
   delivered when the subagent finishes (a `worker.finished` SDK event), and
   `worker_status`, `worker_result` or `wait_for` with `worker_id` fetch them.
   `/subagents cancel <n>` stops one subagent without interrupting the turn.

## Mid-turn user input

- **TUI:** input while busy is triaged (`src/agent/inbox-triage.ts`):
  `interrupt` stops the turn at the next safe point and runs the message
  next, `steer` folds it into the current task at the next tool boundary,
  `queue` runs it as its own turn afterwards (`/now` promotes it), and
  `aside` answers from the current state without disturbing the turn. Clear
  wording is decided by rules, ambiguous messages by a Jev call, and anything
  uncertain is queued. `/queue plan` lets the user merge queued prompts into
  one coordinated prompt (`src/agent/queue-batch.ts`). Ctrl+C aborts the
  turn scope; an interrupt message never cancels running subagents.
- **SDK/RPC:**
  - `steer()` queues text that `onIterationEnd` injects as a user message.
  - `followUp()` appends after the turn.
  - `prompt()` while streaming becomes a steer.

  Known gaps are tracked in #725.

## Cancellation

`src/util/abort-scope.ts` provides a parent/child scope tree
(session → turn → tool). The turn's signal is passed to `runKimi`, the
executor, and tools; Hotcell workers kill their process and remove the cell
on abort. SDK `abort()` first denies pending permission prompts, because the
executor doesn't race them against the signal.

## Persistence and durable runs

- Sessions are JSON files in `$XDG_DATA_HOME/kimiflare/sessions/` (default
  `~/.local/share/...`): messages, session state, artifact store, and
  checkpoints. The TUI saves after every turn; the SDK saves after every
  turn too, including failed and aborted ones (#637).
- `src/agent/artifact-compaction.ts` collapses older complete turns into
  `SessionState` plus archived artifacts. It's triggered by the TUI and init
  at 80k estimated tokens or 12 turns (#717).
- Durable runs: `src/runs/` (store, intent/result journal, wake scheduler,
  worktrees) and `src/jobs/manager.ts` (detached process-group jobs with log
  files). The server host passes `runId`; `wait_for` yields a run on a timer
  or job condition.

## Other subsystems

- **Memory** (`src/memory/`): SQLite + FTS5 + embeddings, repository-scoped
  by default (`.kimiflare/memory.db`). The `memory_*` tools, plus
  fire-and-forget extraction after tool results.
- **Skills** (`src/skills/`): embedding search over skill sections, packed
  by tier budget.
- **Code Mode** (`src/code-mode/`): tools exposed as a generated TypeScript
  API, run in `isolated-vm` (with a `node:vm` fallback).
- **Hooks** (`src/hooks/`): `PreToolUse`/`PostToolUse` in the executor,
  `Stop` in the loop, and `PreCompact` in hosts.
- **MCP/LSP** (`src/mcp/`, `src/lsp/`): adapted to `ToolSpec`s with per-call
  timeouts; LSP restarts with backoff.
