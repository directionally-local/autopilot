# Collecting traces to post-train an Autopilot-optimized model

> **Status:** Proposal. Written 2026-10-11 against v1.19.3.
> **Companion plan:** `docs/plans/harness-lessons-from-arxiv-2609-20804.md` (harness changes; its Phase 0 eval harness is the main source of *rewarded* traces).
> **Question answered here:** Does Autopilot currently record the data needed to post-train a model for its own harness? **No.** The closest thing is an off-by-default local debug dump. This document says what is missing, proposes a trace format, and lays out the phases to get from today to a usable dataset.

---

## 1. What a post-training dataset for a harness-specific model needs

A model "optimized for Autopilot" is a model that has learned *this harness's* conventions: the system prompt and tool schemas, the `tasks_set` protocol, the reduced tool-output format and `[compiled session state]` blocks, `expand_artifact`, Code Mode's `execute_code` API, permission-aware `bash`, memory tools, subagent delegation, and the stop/continue behaviour the completion check enforces. Every one of those is visible only in the exact prompt the model saw. So the dataset needs, per model call:

| Need | Why | Autopilot today |
| --- | --- | --- |
| **Exact model-facing prompt** (system prompt, tool schemas, messages *after* compaction, sampling params) | SFT/RL trains on what the model saw, not on a cleaned transcript. Compaction, reduction and ephemeral directives all change the prompt. | Only with `KIMIFLARE_DUMP_LLM=1` (`src/util/llm-dump.ts`): full request incl. `system`, `messages`, `tools`, `params`, and `rawSerialized`. Off by default, local only. Session files (`src/sessions.ts`) store post-compaction messages without tool schemas or params. |
| **Model output** incl. reasoning, tool calls, finish reason, usage, latency | The completion side of each sample; reasoning is needed if the target model is trained with thinking. | Session file: `content`, `reasoning_content`, `reasoning_details`, `tool_calls`. Dump: `response{text, reasoning, toolCalls, finishReason, usage}` but not streamed `reasoning_details`. No per-message timestamp, model, latency or cost. |
| **Raw environment observations** (full tool output, exit code, duration) | Needed to re-render observations under a *different* reducer or harness version, and for judges. | Session file stores the **reduced** output (grep 3k, read/bash 4k, 10k loop cap). Raw output lives in the in-memory `ToolArtifactStore` and is never persisted (`src/tools/artifact-store.ts:1-2`). Durable runs store only SHA-256 and byte count (`src/runs/store.ts:337-369`). |
| **Outcome / reward** (task solved, tests passed, user accepted, user corrected, aborted) | Rejection sampling and RL both need a label; SFT quality filtering needs it too. | Not recorded. `gitDiffSummary` exists but is unused (`src/cost-attribution/git-diff.ts:17`). Bash exit codes only in the debug log. Completion-check probability only as a log event. No thumbs/ratings. Abort drops the partial assistant message without a marker (`loop.ts:768`). |
| **Harness state and version** (config flags, tool profile, compaction method, prompt hash, Autopilot version) | Traces from different harness versions are different distributions; companion plan will change the harness. | `cost-debug.jsonl` has `codeMode`, `intentClassification`, compaction metrics, but not prompt hash or version. |
| **Human signals** (permission allow/deny + feedback text, interruptions, `/clear`, checkpoint restore, next-message corrections) | Cheapest source of preference data from real use. | Denial becomes a tool message string only; "allow for session" is memory-only (`executor.ts:370-392`); deny-feedback becomes a plain user message (`app.tsx:3042`). |
| **Reproducibility handle** (repo + commit, task prompt, test command, harness config) | RL needs to *re-run* the task; eval needs matched arms. | `cwd` and `model` in session file; no commit, no test command. |
| **Consent, retention, redaction** | Traces contain user code and secrets. | No first-party upload path exists (feedback-worker is voice notes only). Sessions pruned at 30 days / 100 files. No redaction of secrets in session files. |

Summary: today you can reconstruct *approximately* what happened in a session, but not what the model saw, not what the environment returned in full, and not whether it went well.

---

## 2. Trace design

### 2.1 Principles

1. **Append-only, event-sourced.** One `trace.jsonl` per session, written as events happen. Compaction, `/clear`, abort, and checkpoint restore become events, not overwrites. This is the single most important change: today's session file is a mutable snapshot that compaction overwrites (`run-compact.ts:103,118`).
2. **Record what the model saw, not what we wish it saw.** Capture at the same point `llm-dump.ts` does (immediately before `fetch`, `client.ts:183-217`), plus the finalized response.
3. **Raw bodies in a content-addressed blob store**, referenced by SHA-256 from events. Tool outputs, request bodies, and response bodies go there with per-blob and per-session size caps. Same blob written once even if referenced by several events.
4. **Local by default, opt-in to enable, opt-in again to export.** Enabling tracing writes only to `~/.local/share/kimiflare/traces/<session>/`. Nothing leaves the machine without a separate explicit step.
5. **Everything versioned.** Each session's `session_start` event carries Autopilot version, git commit of the harness if available, config snapshot, tool profile, system-prompt hash, tool-schema hash.
6. **Redact at write time where cheap, at export time thoroughly.** Env-style secrets (`KEY=`, bearer tokens, PEM blocks) are masked when writing blobs; export runs a full secret scanner.

### 2.2 Event schema (v1)

All events share `{ v: 1, ts, session_id, turn_id, seq, type }`.

| `type` | Payload |
| --- | --- |
| `session_start` | `autopilot_version`, `harness_commit`, `cwd`, `repo_remote`, `repo_head`, `model`, `config` (redacted `KimiConfig`), `tool_profile`, `tool_schemas_sha`, `tools` (blob ref), `system_prompt_sha`, `mode` |
| `user_message` | `content` (blob ref or inline), `source` (typed / deny-feedback / continuation / routine), `attachments` |
| `llm_request` | `request_id`, `attempt`, `model`, `params`, `messages_sha`, `request_blob` (full request as sent), `estimated_tokens`, `compaction_state` |
| `llm_response` | `request_id`, `text`, `reasoning_content`, `reasoning_details`, `tool_calls`, `finish_reason`, `usage` (prompt / completion / cached / `cost`), `generation_id`, `latency_ms`, `aborted`, `error` |
| `tool_call` | `tool_call_id`, `name`, `args` (inline; blob if large), `permission` (`auto` / `asked`), `code_mode_redirect` |
| `permission_decision` | `tool_call_id`, `decision` (allow / allow_session / deny), `feedback_text`, `latency_ms` |
| `tool_result` | `tool_call_id`, `ok`, `error_code`, `raw_blob`, `raw_bytes`, `reduced_content`, `reduced_bytes`, `exit_code`, `timed_out`, `duration_ms`, `artifact_id`, `diagnostics` (once Phase 4 of the companion plan lands) |
| `code_mode_call` | inner `api.*` calls made from `execute_code` (name, args, raw/reduced result), today only sent to UI callbacks (`loop.ts:1270-1331`) |
| `compaction` | `method` (compiled / llm / elision), `tokens_before`, `tokens_after`, `turns_removed`, `summary_blob`, `removed_message_range` |
| `guardrail` | `kind` (loop_recovery / loop_stopped / limit_ceiling / code_mode_redirect_cap), `message` |
| `completion_check` | `probability`, `nudged` |
| `subagent` | `worker_id`, `mode`, `task_sha`, `status`, `cost`, child `session_id` (so the worker's own trace can be joined) |
| `turn_end` | `reason` (complete / aborted / error / guardrail / needs_input), `tools_used`, `cost_usd`, `duration_ms` |
| `outcome` | see §2.3 |
| `session_end` | `reason` (exit / clear / restore_checkpoint / crash), `total_cost_usd` |

### 2.3 Outcome signals

Explicit:

- `/good` and `/bad [reason]` slash commands, and a keybinding, recorded as `outcome{kind: "rating", value, reason, turn_id}`. Zero friction for the user who wants to help; absent otherwise.
- Eval-harness verdicts (`outcome{kind: "test", passed, command, exit_code}`) from the companion plan's Phase 0 runner.

Implicit, recorded automatically per turn:

- **Workspace delta:** `git diff --stat` and numstat after the turn versus before it (`gitDiffSummary` already exists), plus whether the diff was later reverted by the user within the session.
- **Verification commands:** any `bash` call matching test/lint/typecheck patterns with its exit code; the last such exit code before `turn_end` is a cheap proxy for "turn ended green".
- **Human corrections:** next user message within the same session classified as `continue` / `correction` / `new_task` / `question` (regex first; LLM judge at export time). `/clear` or checkpoint restore within two turns of a turn is a negative signal for that turn.
- **Permission denials** with feedback text are strong negative examples for that tool call.
- **Abort** (Esc) mid-turn is a weak negative signal; record it with the partial output.
- **Completion-check nudge** fired is a negative signal for the pre-nudge assistant message and a positive one for the post-nudge continuation when the turn then ends green.

### 2.4 Storage and limits

- `~/.local/share/kimiflare/traces/<session_id>/trace.jsonl` plus `blobs/<sha256>`.
- Caps: 2 MB per blob (truncate with marker), 200 MB per session, 2 GB total; prune oldest sessions beyond caps; retention separate from session retention (default 90 days).
- Add to `RETENTION` in `src/storage-limits.ts`.

---

## 3. Phases

### Phase A — Trace recorder (local, opt-in)

- New module `src/trace/` with `TraceRecorder` (`emit(event)`, `blob(content) → sha`), a no-op recorder when disabled, and `trace.enabled` in `KimiConfig` plus `KIMIFLARE_TRACE=1`.
- Wire emit points:
  - `src/agent/client.ts` next to the existing dump capture (`llm_request`, `llm_response`, including abort/error paths at `client.ts:301-307`); add streamed `reasoning_details` and latency.
  - `src/tools/executor.ts` around `reduceToolOutput` (`tool_call`, `tool_result` with raw blob) and the permission branch (`permission_decision`).
  - `src/agent/loop.ts`: `guardrail`, `completion_check`, `turn_end` with abort reason (fix the silent abort at `loop.ts:768` by emitting the partial assistant text).
  - `src/agent/run-compact.ts`, `app.tsx` auto-compaction sites, `context-budget.ts` preflight: `compaction`.
  - Code Mode sandbox: `code_mode_call`.
  - `src/sessions.ts` / `use-session-manager.ts`: `session_start`, `session_end`, checkpoint restore.
  - `src/tools/subagent.ts` and `supervisor.ts`: `subagent`, and give workers their own session id so their traces are separate files joined by id.
- Make `KIMIFLARE_DUMP_LLM` a thin alias of the recorder (same capture point) to avoid two writers.
- Tests: scripted-model test (as in `loop-guardrails.test.ts`) asserting the event sequence for a turn with one tool call, one denial, one compaction, one abort.
- Size: 3–4 days.

### Phase B — Outcome signals

- Implement §2.3: git delta before/after each turn (skip when not a git repo or diff > cap), verification-command detection in `bash`, `/good` `/bad`, abort and `/clear` markers, next-message regex classifier.
- Eval runner writes `outcome{kind: "test"}`.
- Size: 2 days.

### Phase C — Export and dataset builder

- `autopilot trace export --since --repo --format {sft,rl,raw} --out dir` (CLI under `src/index.tsx`, logic in `src/trace/export.ts`).
- Steps: load sessions → full secret scan and redaction (regex + entropy; configurable allowlist of paths) → drop sessions flagged `no-export` → phase-label turns (rule-based; optional LLM judge, companion plan Phase 5) → attach reward → dedupe near-identical samples → write.
- **SFT format:** one sample per `llm_request`/`llm_response` pair in OpenAI chat-with-tools JSON (`messages`, `tools`, assistant `tool_calls`, `reasoning_content`), which is what most fine-tuning stacks accept directly. Weight or filter by outcome (keep turns that ended green with no correction; keep post-nudge continuations; drop turns followed by a denial or `/bad`).
- **RL / rejection-sampling format:** one record per task with `task` (repo, commit, prompt, test command), `harness_config`, `trajectory` (ordered event refs), `reward`. Only tasks with a reproducibility handle qualify, which in practice means eval-harness runs and sessions where the user ran a test command.
- **Preference pairs** where available: same prompt, accepted vs denied tool call; pre-nudge vs post-nudge assistant message.
- Size: 3 days.

### Phase D — Consent and upload (optional, later)

- Only if you want traces from users other than yourself. Separate `trace.share` opt-in with a per-repo allowlist, a visible banner, and an "export preview" command showing exactly what would leave the machine.
- Reuse the feedback-worker pattern (Cloudflare Worker + R2) for the endpoint. Never couple this to the OpenRouter `data_collection` / `zdr` flags, which govern the provider, not us.
- Size: 2–3 days plus policy work.

### Phase E — On-policy data generation (where the useful RL data actually comes from)

Real interactive sessions give preference-style signals but few verifiable rewards. Verifiable rewards come from running the harness headlessly on tasks with tests:

1. Companion plan Phase 0 runner over SWE-Bench Verified slices, Terminal-Bench, and an Autopilot-bench of this repo's own closed PRs (issue text → test command).
2. Sample N trajectories per task with the target model under the *current* harness config (`temperature > 0`); keep passing ones as SFT data (rejection sampling), keep all with rewards for RL.
3. Because each trace carries `harness_commit`, `system_prompt_sha`, and `tool_schemas_sha`, you can filter to the harness version you are about to ship, which matters because the companion plan will change prompts and tools.
4. Budget: SWE-Bench Verified at 500 tasks × 4 samples × ~$0.5–2 per run on mid-size OpenRouter models is $1k–4k per harness version; start with 50-task slices.

---

## 4. Decisions to make before Phase A

- **Thinking in the target model:** if you plan to train a reasoning model, keep `reasoning_content` and `reasoning_details` in the dataset; some providers return encrypted reasoning only (`messages.ts:26-36`), which is unusable. Prefer models that return visible reasoning for data-generation runs.
- **Which harness version to target:** traces collected before the companion plan's Phase 1–3 changes will partly teach obsolete conventions (tight reducer caps, `tasks_set` before every mutating tool). Ship the harness changes first, then collect at scale; collect a small amount now only to validate the pipeline.
- **Retention of your own sessions:** the current 30-day session pruning will throw away data; the trace store needs its own retention.

## 5. Quick start for validating the pipeline today

Before Phase A exists, a crude dataset can be assembled from what is already written:

```
KIMIFLARE_DUMP_LLM=1 autopilot          # full request/response per call → ~/.config/kimiflare/llm-dumps/<session>/
~/.local/share/kimiflare/cost-debug.jsonl   # per-turn usage, cost, compaction metrics
~/.local/share/kimiflare/sessions/*.json    # post-compaction transcripts with reasoning and tool calls
~/.config/kimiflare/logs/<date>.jsonl       # turn/tool events, bash exit codes, completion-check probabilities
```

Joining them by session id and turn id gives prompt → completion pairs with usage, but no raw tool outputs, no outcomes, no permission decisions, and no survival across compaction. That is enough to test a fine-tuning loader, not to train a model you would ship.
