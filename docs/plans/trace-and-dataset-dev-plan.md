# Tracing, evaluation, and dataset pipeline: development plan

> **Status:** Finalized. Ready for implementation.
> **Written:** 2026-10-11 against v1.19.3 on branch `docs/harness-and-trace-plans`.
> **Scope:** Everything needed to (a) measure Autopilot against itself with matched runs and (b) build a post-training dataset for a model optimized for this harness. Harness behaviour changes (context management, planning, tool profiles) are explicitly **out of scope** here; they are proposals in `docs/plans/harness-lessons-from-arxiv-2609-20804.md` and must not be started until this pipeline can measure them.
> **Self-contained:** an agent should be able to execute any phase from this document alone. Background reasoning lives in `docs/plans/post-training-trace-collection.md`; it is not required reading.

---

## 0. Ground rules for the implementing agent

- Phases are ordered. Finish and merge one before starting the next. Each phase is one PR.
- **Zero behaviour change when tracing is disabled.** Every emit point goes through a recorder that is a no-op unless `trace.enabled` is true. Existing tests must pass unchanged.
- **Nothing leaves the machine.** No upload, no network calls. Traces are local files.
- Repo conventions apply (see `AGENTS.md`): ESM, `node:` prefixes, `.js` extensions in relative imports, strict TypeScript, co-located `*.test.ts` with `node:test`, `npm run typecheck` and `npm test` green before each commit, Conventional Commits, never bump the package version.
- Do not refactor unrelated code. Where an emit point needs a value that is not in scope, thread it through the nearest options object rather than a global, except the per-request session/turn ids that `src/util/logger.ts` already exposes via `getLogSessionId()` / `getLogTurnId()`.
- Secrets: blobs and events pass through `redactLight()` (Phase 1) before hitting disk. Export (Phase 5) runs the thorough scan.
- Read the cited files before editing. Line numbers are from v1.19.3 and will drift.

---

## 1. Phase 1: trace recorder core

**Goal:** an append-only, event-sourced trace per session with a content-addressed blob store, behind a config flag, with retention.

### 1.1 Files

```
src/trace/types.ts        event and payload types (the schema in §1.2)
src/trace/recorder.ts     TraceRecorder, NoopRecorder, createRecorder(cfg, sessionId)
src/trace/blobs.ts        BlobStore: put(content) -> { sha256, bytes, truncated }
src/trace/redact.ts       redactLight(text): string
src/trace/paths.ts        traceRoot(), sessionTraceDir(sessionId)
src/trace/retention.ts    pruneTraces(): applies caps
src/trace/index.ts        re-exports
src/trace/*.test.ts       one test file per module
```

### 1.2 Event schema

Every event line in `trace.jsonl` is one JSON object:

```ts
interface TraceEventBase {
  v: 1;
  ts: string;            // ISO-8601
  seq: number;           // monotonically increasing per session file
  session_id: string;
  turn_id: string | null;
  type: TraceEventType;
}
```

Payload per `type` (all fields required unless marked `?`):

| type | payload |
| --- | --- |
| `session_start` | `autopilot_version`, `harness_commit?` (git HEAD of the running checkout if resolvable, else null), `cwd`, `repo_remote?`, `repo_head?`, `model`, `mode`, `config` (KimiConfig with every key ending in `ApiKey`, `Token`, `apiToken` replaced by `"<redacted>"`), `tool_profile` (`"full"` for now), `tool_schemas_sha`, `tools_blob` (sha of the JSON array of `ToolDef`), `system_prompt_sha` |
| `user_message` | `content_blob`, `source` (`"typed" \| "deny_feedback" \| "continuation" \| "eval" \| "sdk" \| "print"`), `attachments` (count) |
| `llm_request` | `request_id`, `attempt`, `model`, `params` (body minus `messages` and `tools`), `request_blob` (sha of `rawSerialized`), `messages_sha`, `tools_sha`, `estimated_tokens` |
| `llm_response` | `request_id`, `text_blob`, `reasoning_blob?`, `reasoning_details?` (array, inline), `tool_calls` (inline `{id,name,arguments}`), `finish_reason`, `usage?` (`prompt_tokens, completion_tokens, cached_tokens?, cost?`), `generation_id?`, `latency_ms`, `aborted`, `error?` |
| `tool_call` | `tool_call_id`, `name`, `args_blob`, `args_inline?` (args if JSON length ≤ 2 KB), `needs_permission`, `code_mode_redirected` |
| `permission_decision` | `tool_call_id`, `decision` (`"allow" \| "allow_session" \| "deny" \| "auto"`), `feedback_text?`, `latency_ms` |
| `tool_result` | `tool_call_id`, `name`, `ok`, `error_code?`, `raw_blob`, `raw_bytes`, `reduced_blob`, `reduced_bytes`, `artifact_id?`, `exit_code?`, `timed_out?`, `duration_ms` |
| `code_mode_call` | `parent_tool_call_id`, `name`, `args_blob`, `raw_blob`, `ok`, `duration_ms` |
| `compaction` | `method` (`"compiled" \| "llm" \| "preflight"`), `tokens_before`, `tokens_after`, `turns_removed`, `artifacts_archived?`, `summary_blob?` |
| `guardrail` | `kind` (`"loop_recovery" \| "loop_stopped" \| "limit_ceiling" \| "code_mode_redirect_cap"`), `message` |
| `completion_check` | `probability`, `nudged` |
| `subagent` | `worker_id`, `mode`, `child_session_id?`, `status`, `cost_usd?`, `duration_ms?` |
| `turn_end` | `reason` (`"complete" \| "aborted" \| "error" \| "guardrail" \| "needs_input"`), `tools_used` (names in order), `cost_usd?`, `duration_ms`, `final_text_blob?` |
| `outcome` | see Phase 3 |
| `session_end` | `reason` (`"exit" \| "clear" \| "restore_checkpoint" \| "crash" \| "eval_done"`), `total_cost_usd?` |

Blobs are stored at `<sessionTraceDir>/blobs/<sha256>` with no extension; a `*_blob` field holds the sha string. `BlobStore.put` writes once per sha, truncates at `maxBlobBytes` (default 2 MB) and appends `\n[truncated: N bytes total]`, returning `truncated: true`.

### 1.3 Recorder API

```ts
export interface TraceRecorder {
  readonly enabled: boolean;
  emit<T extends TraceEventType>(type: T, payload: PayloadFor<T>, turnId?: string | null): void;
  blob(content: string): string | null;   // sha or null when disabled
  flush(): Promise<void>;                   // awaited at session end and in tests
}
export function createRecorder(opts: { enabled: boolean; sessionId: string; root?: string }): TraceRecorder;
```

Writes are synchronous `appendFileSync` of one line per event (simplicity over throughput; a session produces at most a few thousand events). `seq` is kept in memory and persisted implicitly by order. The recorder never throws: every disk error is logged once via `logger.warn("trace:write_failed")` and the recorder disables itself for the rest of the session.

### 1.4 Config and paths

- `KimiConfig` gains `trace?: { enabled: boolean; root?: string }` in `src/config.ts` with persistence like `compiledContext` (`config.ts:311`). Env override `KIMIFLARE_TRACE=1|0`, `KIMIFLARE_TRACE_DIR=<path>`.
- Default root: `${XDG_DATA_HOME:-~/.local/share}/kimiflare/traces/`. Session dir: `<root>/<session_id>/`.
- Retention in `src/storage-limits.ts` `RETENTION`: `traceMaxAgeDays: 90`, `traceMaxTotalBytes: 2 GB`, `traceMaxSessionBytes: 200 MB`. `pruneTraces()` deletes whole session directories, oldest first, and is called from the same startup task that calls `pruneSessions()`.

### 1.5 `redactLight`

Regex pass applied to every blob and to `user_message`/`llm_response` text before write: `(?i)(api[_-]?key|secret|token|password|authorization)\s*[:=]\s*\S+` → keep the key name, replace the value with `<redacted>`; `-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----` → `<redacted-key>`; `sk-or-v1-[A-Za-z0-9]+`, `ghp_[A-Za-z0-9]+`, `github_pat_[A-Za-z0-9_]+`, `Bearer [A-Za-z0-9._-]+` → `<redacted>`. Must be cheap; no entropy scan here.

### 1.6 Tests

- Recorder writes events in order with increasing `seq`; disabled recorder writes nothing and `blob()` returns null.
- Blob dedupe by sha; truncation marker at the cap.
- `redactLight` fixtures for each pattern, and a negative case (ordinary code untouched).
- Retention prunes oldest session beyond byte cap.

### 1.7 Acceptance

`KIMIFLARE_TRACE=1 npm run dev -- -p "say hi" --dangerously-allow-all` produces a session dir with `trace.jsonl` containing `session_start` and `session_end` (the other events arrive in Phase 2). With the flag off, no directory is created.

**Size:** 1–2 days.

---

## 2. Phase 2: wire every emit point

**Goal:** a complete trace of a turn: what the model saw, what it said, what the tools returned in full, what the user decided, how the turn ended.

### 2.1 Recorder plumbing

- Create the recorder once per session where the session id is minted: TUI `src/ui/use-session-manager.ts`, print mode `src/print-mode.ts`, SDK `src/sdk/session.ts`, server `src/server/routes.ts`. Pass it as `opts.trace` on `AgentTurnOpts` (`src/agent/loop.ts:~40`) and `ToolExecutor` options (`src/tools/executor.ts:266`), and as `opts.trace` on `runKimi` in `src/agent/client.ts`. Default to a `NoopRecorder` everywhere so existing callers compile without changes.

### 2.2 Emit points

| Event | Where | Notes |
| --- | --- | --- |
| `session_start` / `session_end` | the four session creators above; `handleClear` and checkpoint restore in `src/ui/slash-commands.ts:1891` and `src/sessions.ts:169` | On `/clear`, emit `session_end{reason:"clear"}` then a new `session_start` for the fresh session id. |
| `user_message` | the same sites where a user `ChatMessage` is pushed before `runAgentTurn`; deny-feedback path `src/app.tsx:~3042` with `source:"deny_feedback"` | |
| `llm_request` | `src/agent/client.ts:183-217`, right where `dumpRecord` is built. Build the trace event from the same `body`. | Replace the `isLlmDumpEnabled()` branch body with a shared `captureRequest(body)` used by both the dump and the trace; keep `KIMIFLARE_DUMP_LLM` working (it becomes "also write the legacy per-call JSON"). |
| `llm_response` | the `finally` at `client.ts:296-307` where `writeLlmDump` runs; also the abort/error path. | Accumulate streamed `reasoning_details` (the dump currently drops them: extend `accumulateDumpResponse`). `latency_ms` from a timestamp taken before `fetch`. `generation_id` from the stream's `id` if present. |
| `tool_call`, `tool_result` | `src/tools/executor.ts` around the permission branch (`~370`) and after `reduceToolOutput` (`~448`). Raw content is `normalized.content` before reduction. | For `bash`, read exit code and timeout from the tool's `ToolOutput` metadata; if the bash tool does not expose them structurally yet, add `meta: { exitCode, timedOut }` to its return (`src/tools/bash.ts:~455`) and thread it through `ToolOutput`. |
| `permission_decision` | `executor.ts:~373` around `askPermission`. Map the asker's result to the enum; `auto` when `needsPermission` is false or an allowlist rule matched (`src/permissions-evaluator.ts:33`). | The feedback text typed in the deny box reaches the loop as a new user message; record it on the `user_message` with `source:"deny_feedback"` and also copy it onto the `permission_decision` when available (pass it back through the `PermissionAsker` result if the type allows; otherwise emit from `app.tsx` where the box resolves). |
| `code_mode_call` | the `execute_code` branch in `loop.ts:~1270-1331`, where inner `api.*` calls are surfaced to UI callbacks | |
| `compaction` | `src/agent/run-compact.ts`, the auto-compaction sites in `src/app.tsx:~796-890` and `~2030`, and the preflight in `loop.ts:~680-698` (`method:"preflight"`) | |
| `guardrail` | the `onGuardrail` calls in `loop.ts:~592-612, ~866` | |
| `completion_check` | `loop.ts:~853-872` | |
| `subagent` | `src/tools/subagent.ts:~163` and `src/agent/supervisor.ts` worker completion | Workers get their own session id and therefore their own trace dir; record `child_session_id`. |
| `turn_end` | `loop.ts:~787-828` on normal completion; the abort throw at `loop.ts:~768` (`reason:"aborted"`, include the partial assistant text as `final_text_blob`); `AgentLoopError` path (`reason:"guardrail"`); error path | Today the aborted partial message is dropped from history. Do not change that; just trace it. |

### 2.3 Tests

Extend the scripted-model pattern from `src/agent/loop-guardrails.test.ts` into `src/trace/wiring.test.ts`: run `runAgentTurn` with an in-memory recorder (add `createMemoryRecorder()` for tests) against a scripted SSE model and a fake executor, and assert the exact event type sequence for:

1. one text reply: `llm_request, llm_response, turn_end{complete}`
2. one tool call then text: `llm_request, llm_response, tool_call, permission_decision{auto}, tool_result, llm_request, llm_response, turn_end`
3. a denied tool: `… tool_call, permission_decision{deny}, tool_result{ok:false,error_code:"permission_denied"} …`
4. a loop guardrail trip: contains `guardrail{loop_recovery}` and ends `turn_end{guardrail}` after the second trip
5. an abort mid-stream: `turn_end{aborted}` with a `final_text_blob`

Plus a client-level test that `llm_request.request_blob` content equals `rawSerialized` and that `llm_response.reasoning_details` is populated from streamed deltas.

### 2.4 Acceptance

A real `KIMIFLARE_TRACE=1` print-mode run that edits a file yields a trace where: the request blob for every call parses as the exact JSON sent; every `tool_call` has a matching `tool_result` with `raw_bytes ≥ reduced_bytes`; a bash call has `exit_code`; and `turn_end.tools_used` matches the tool calls in order. `npm test` passes with tracing off and on.

**Size:** 3–4 days.

---

## 3. Phase 3: outcome signals

**Goal:** every turn and every eval run carries a label a dataset builder can filter or weight on.

### 3.1 `outcome` event payloads

```ts
type OutcomePayload =
  | { kind: "git_delta"; turn_id: string; files_changed: number; insertions: number; deletions: number; numstat_blob: string; patch_blob?: string /* when ≤ 512 KB */ }
  | { kind: "verification"; turn_id: string; tool_call_id: string; command: string; category: "test" | "lint" | "typecheck" | "build"; exit_code: number }
  | { kind: "rating"; turn_id: string; value: "good" | "bad"; reason?: string }
  | { kind: "next_message"; turn_id: string; classification: "continue" | "correction" | "new_task" | "question" | "other"; classifier: "regex" }
  | { kind: "reverted"; turn_id: string; how: "clear" | "restore_checkpoint" | "git_checkout" }
  | { kind: "test_verdict"; task_id: string; passed: boolean; command: string; exit_code: number; duration_ms: number; log_blob: string }
```

### 3.2 Implementation

- **git_delta:** in the turn runner (the `onDone` path in `app.tsx:~2022` and the equivalent in print mode and SDK), capture `git diff --numstat` before the turn starts and after it ends; emit the difference. Reuse `src/cost-attribution/git-diff.ts` (`gitDiffSummary`, currently unused) and extend it to return the raw numstat. Skip silently when not a git repo. Include the patch when small.
- **verification:** in `src/tools/bash.ts`, classify the command with a regex table (`npm test|npx tsx --test|vitest|jest|pytest|go test|cargo test` → test; `eslint|ruff|golangci` → lint; `tsc|mypy|pyright` → typecheck; `npm run build|tsup|cargo build|go build` → build) and emit with the exit code. Keep the table in `src/trace/verification.ts` with a test.
- **rating:** add `/good` and `/bad [reason]` to `src/ui/slash-commands.ts` (register in the command map at `~1890`); they emit against the most recent `turn_id`. One line of help text each.
- **next_message:** when a new user message arrives in a session with a previous turn, classify it in `src/trace/next-message.ts` with regexes (`^(no|nope|wrong|that's not|not what|undo|revert)` → correction; `^(go on|continue|yes|ok|do it)` → continue; ends with `?` → question; else new_task) and emit for the *previous* turn.
- **reverted:** emit on `/clear` within two turns of a turn, on checkpoint restore, and when a `bash` call runs `git checkout -- ` / `git restore` / `git stash` touching files the last `git_delta` changed.
- **test_verdict:** emitted by the eval runner (Phase 4).

### 3.3 Tests

Regex tables for verification and next-message classification; git_delta on a temp repo with a scripted edit; `/good` emits a `rating` event bound to the last turn.

### 3.4 Acceptance

After a real session with one edit, one test run, and a `/good`, the trace holds `git_delta`, `verification`, and `rating` events with the right `turn_id`.

**Size:** 2 days.

---

## 4. Phase 4: eval runner

**Goal:** run Autopilot headlessly on a task set under an explicit harness configuration, produce one trace per run with a `test_verdict`, and compare two configurations with paired statistics. This is both the measurement tool and the source of rewarded trajectories.

### 4.1 Task format

`evals/tasks/<set>/<task_id>.json`:

```ts
interface EvalTask {
  id: string;
  repo: string;            // git URL or absolute path
  base_commit: string;
  prompt: string;          // what the agent is asked to do
  setup?: string;          // shell, run once in the worktree before the agent (install deps)
  test: string;            // shell; exit 0 = pass. Run after the agent, in the worktree
  timeout_s?: number;      // default 1800
  tags?: string[];
}
```

Seed set `evals/tasks/autopilot-bench/` with 20 tasks mined from this repository's own history: pick merged PRs that added or changed a `*.test.ts` and a source file; `base_commit` = the PR's base; `prompt` = the PR title and body rewritten as a task; `test` = `npx tsx --test <the PR's test file at the PR's head commit copied into evals/tasks/.../files/>`. Document the recipe in `evals/README.md` so more can be added. SWE-Bench and Terminal-Bench adapters are follow-ups, not part of this phase.

### 4.2 Harness config snapshot

`evals/configs/<name>.json` is a partial `KimiConfig` override plus `model`. The runner writes the merged, redacted config into `session_start.config` (Phase 1 already does this) and a copy next to the run outputs. Start with `baseline.json` (today's defaults). Any future harness change gets its own config file so arms are matched.

### 4.3 Runner

`src/eval/run.ts`, exposed as `autopilot eval run --tasks <dir> --config <file> --model <id> --samples N --out <dir> [--concurrency K] [--filter <glob>]`:

1. For each task × sample: create a fresh worktree or clone at `base_commit` under `<out>/work/<task>/<n>` (reuse `RunWorktreeManager` in `src/runs/worktrees.ts` if the task repo is local, else `git clone --depth 50` then `checkout`). Run `setup`.
2. Launch the agent in-process via `createAgentSession` (`src/sdk/session.ts:30`) with `cwd` = worktree, auto-approving permissions (`resolvePermission` with allow), the config override, tracing forced on with `root = <out>/traces`, `temperature` from the config, and a wall-clock timeout. Send `prompt`, wait for idle.
3. Run `test` in the worktree, capture exit code and log; emit `outcome{kind:"test_verdict"}` into that run's trace and `session_end{reason:"eval_done"}`.
4. Append one line to `<out>/results.jsonl`: `{task_id, sample, config, model, passed, cost_usd, prompt_tokens, completion_tokens, turns, tool_calls, overflow (true if a ContextBudgetError occurred), duration_ms, trace_dir}`.
5. Clean the worktree unless `--keep`.

Failures of the harness itself (crash, timeout) are recorded as `passed:false, error:<message>`; the runner never aborts the whole set for one task.

### 4.4 Compare

`autopilot eval compare <results-a.jsonl> <results-b.jsonl>` prints: success rate per arm, paired McNemar exact test p-value on task-level success (majority over samples), mean and median cost, median turns, overflow counts, and a per-task table of flips. Implementation in `src/eval/compare.ts`; the exact binomial test is a few lines, no dependency.

### 4.5 Tests

Runner tested against a fake task whose `test` is `exit 0` and a scripted model (reuse the SSE scripting helper); asserts `results.jsonl` and the `test_verdict` event. Compare tested on a hand-built fixture with a known McNemar value.

### 4.6 Acceptance

`autopilot eval run --tasks evals/tasks/autopilot-bench --config evals/configs/baseline.json --model <cheap model> --samples 1` completes on all 20 tasks in one sitting, produces 20 traces with verdicts, and `eval compare` against itself reports no difference.

**Size:** 4–5 days including mining the 20 tasks.

---

## 5. Phase 5: dataset export

**Goal:** turn trace directories into training files with redaction, filtering, and reward attached.

### 5.1 CLI

`autopilot trace export --format sft|rl|pairs|raw --out <dir> [--since <date>] [--repo <path>] [--include-eval <results.jsonl>] [--min-reward] [--harness-commit <sha>] [--system-prompt-sha <sha>]`

### 5.2 Pipeline (`src/trace/export/`)

1. **Load** every session dir under the trace root (and eval trace dirs when given). Parse `trace.jsonl`; resolve blobs lazily.
2. **Version filter:** keep sessions whose `session_start.harness_commit` / `system_prompt_sha` / `tool_schemas_sha` match the flags when given. Always write the distribution of these three fields to `<out>/manifest.json` so you can see what you are training on.
3. **Redact thoroughly** (`src/trace/export/redact.ts`): `redactLight` again, then a Shannon-entropy scan over tokens ≥ 20 chars (entropy > 4.0 bits/char → `<redacted>`), then an optional user allowlist of paths to drop entirely (`--exclude-path`). Count redactions into the manifest.
4. **Reward** per turn (`src/trace/export/reward.ts`): `+1` test_verdict passed; `-1` failed; for interactive turns: `rating good/bad` → ±1, `next_message correction` or `reverted` → −0.5, `permission deny` on the turn → −0.5 on that step, last `verification` exit 0 with a non-empty `git_delta` → +0.5, `completion_check nudged` → −0.25 on the pre-nudge step; clamp to [−1, 1]; `null` when no signal. Table lives in one file so it can be tuned.
5. **Phase labels** per `llm_response` (`src/trace/export/phases.ts`), rule-based from the tool calls it issued: read/grep/glob/github_read_* → `L`; edit/write on a path matching a test or `repro` → `R`; edit/write otherwise → `F`; bash classified as test/lint/typecheck → `V`; anything else → `O`. Store on each sample's `meta.phase`.
6. **Write formats:**
   - `sft`: one JSON line per `llm_request`/`llm_response` pair: `{ messages: <request messages as sent, system included>, tools: <tool defs>, completion: { role:"assistant", content, reasoning_content?, tool_calls? }, meta: { session_id, turn_id, request_id, model, reward, phase, harness_commit, system_prompt_sha, usage } }`. Default filter: `reward === null || reward > 0`; `--min-reward` overrides.
   - `rl`: one JSON line per eval run: `{ task: <EvalTask>, harness_config, model, trajectory: [ordered event refs with blob shas], reward: 1|0 }`. Only runs with `test_verdict`.
   - `pairs`: `{ prompt: <messages>, chosen, rejected, source }` for (a) a denied tool call vs the next allowed call on the same request prefix; (b) a pre-nudge assistant message vs the post-nudge continuation when the turn ended with reward > 0.
   - `raw`: the redacted trace dirs copied as-is.
7. **Dedupe** SFT samples by sha of `messages + completion`.

### 5.3 Tests

A fixture trace dir checked into `src/trace/export/fixtures/` (built by hand from the Phase 2 wiring test's output) exercises every step; snapshot the manifest and the first SFT line. Redaction tests include an API key in a tool result blob.

### 5.4 Acceptance

Exporting the Phase 4 eval traces yields an `rl` file with one record per run and an `sft` file whose every line loads with a standard chat-format fine-tuning loader (verify by round-tripping through a 20-line Node script that re-serialises the OpenAI chat schema and checks `tool_calls` ids match `tool` results).

**Size:** 3 days.

---

## 6. Later, explicitly not in this plan

- Sharing or uploading traces from other users (consent flow, endpoint).
- LLM-judge phase labelling and failure-stage attribution.
- SWE-Bench / Terminal-Bench adapters for the eval runner.
- Any harness behaviour change from `docs/plans/harness-lessons-from-arxiv-2609-20804.md`. Once Phases 1–5 are merged, each of those becomes: add a config file under `evals/configs/`, run `eval run` on both arms, `eval compare`, and only then decide.

## 7. Order, sizing, and checkpoints

| Phase | PR title (Conventional Commit) | Size | Done when |
| --- | --- | --- | --- |
| 1 | `feat(trace): append-only session trace recorder and blob store` | 1–2 d | §1.7 |
| 2 | `feat(trace): record requests, responses, tool calls, permissions, turn ends` | 3–4 d | §2.4 |
| 3 | `feat(trace): outcome signals (git delta, verification, ratings, corrections)` | 2 d | §3.4 |
| 4 | `feat(eval): headless task runner, autopilot-bench seed set, paired compare` | 4–5 d | §4.6 |
| 5 | `feat(trace): dataset export (sft, rl, pairs) with redaction and rewards` | 3 d | §5.4 |

Total: roughly three weeks of agent time. After Phase 4 you can measure any harness change; after Phase 5 you can train.
