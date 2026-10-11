# Harness lessons for Autopilot from "An Empirical Study of Harness Design for Coding Agents" (arXiv:2609.20804)

> **Status:** Proposal. Written 2026-10-11 against v1.19.3.
> **Companion plan:** `docs/plans/post-training-trace-collection.md` (traces needed to post-train an Autopilot-tuned model and to measure the changes below).
> **Source:** Fan, Zhang, Ma, Hu, Wang, Song, Liu, Zamani, Wang. *An Empirical Study of Harness Design for Coding Agents.* arXiv:2609.20804, Sept 2026.

---

## 1. What the paper did and found

The authors fixed a ReAct loop and varied three harness components, one at a time, across 176 matched settings (4 models × 2 benchmarks × context budgets of 32k/64k/96k/128k). Models: Nemotron-3 30B/120B/550B and Mistral-Medium-3.5-128B, all served via OpenRouter-priced tokens. Benchmarks: SWE-Bench Verified (500) and Terminal-Bench 2.1 (89). Success rates were compared with paired McNemar tests.

The three components:

| Component | Variants | Mechanism |
| --- | --- | --- |
| Planning | on / off | `update_plan` tool holding a todo list. The current plan is **re-injected as a `<system-reminder>` before every model turn**, not appended to history. A reminder nags the model to plan first on non-trivial tasks. |
| Action space | predefined tools (read, write, edit, list, glob, grep, web_fetch, bash) / bash-only | Bash-only removes the file tools and the state tracking + diagnostics that ride on them. |
| Context management | Tiers T0–T4 | M1 **elision**: replace the body of stale tool observations in the *middle* of history with a stub. M2 **recall**: store elided originals, expose `recall_event(id)`. M3 **summarization**: fold the oldest middle events into a running summary via a tool-free call to the same model. T4 = staged: elide at soft threshold B1 = 0.6 × window, summarize at hard threshold B2 = 0.85 × window. Preamble and a recent window (0.3 × budget, at least 2 turns) stay verbatim. |

Fixed substrate (same in every arm): workspace path guard, **read-before-write with content hash**, allow/ask/deny permission layer, tool errors returned as observations, **post-edit diagnostics** (ruff / pyflakes / syntax check appended to the edit result), **stuck detection** (reminder after 5 byte-identical calls, terminate after 8 identical failing calls), tool results truncated at 24k chars, up to 8 read-only tools in parallel per step, 300-step cap.

Findings that transfer:

1. **Context management is mostly overflow prevention.** Managed-vs-T0 success gap on SWE-Bench: 35.7 → 15.9 → 5.5 → 2.7 points from 32k to 128k. T0 overflow rate fell from 78.7% (32k) to 8.7% (128k). Managed tiers never overflowed. Context management "extends trajectories without substantially altering behavior".
2. **Staged elision-then-summarization (T4) is the cheapest.** Similar accuracy to T1–T3, lowest cost in 7 of 8 model×benchmark panels, because cheap stubbing avoids most summarization calls.
3. **Recall is dead weight.** T2 vs T1: −0.36 points on average; 36 of 64 recall-enabled settings never called `recall_event`. Stronger models almost never use it. Making elision reversible added machinery for no accuracy.
4. **Planning is conditional.** Weakest model: +11.6 (SWE) / +4.5 (TB) points, at higher cost, because it stops the model abandoning tasks before editing (68.6% → 27.8% of runs ending without an edit). Strong models: no accuracy gain, but **~30% cost reduction** from trimming redundant post-edit verification (median trajectory 108 → 74 turns for 550B).
5. **Action space depends on capability and task type.** Weak model: predefined tools +15.0 / +10.1 points (bash-only runs died on out-of-interface tool emissions). Strongest model: **bash-only was better** (+3.6 / +5.6) *and* 53% / 30% cheaper, because it bundles several operations per command. Mistral split: full tools on SWE-Bench (+23.2), bash-only on Terminal-Bench (+6.7).
6. **Meta-lesson:** there is no universal harness. Pick components per model, task type, and budget, and validate with matched ablations plus trajectory-level analysis (phase labels: Localize / Reproduce / Fix / Verify / Other; earliest-failure-stage attribution).

---

## 2. Where Autopilot stands today

| Paper component | Autopilot today | Gap |
| --- | --- | --- |
| Elision of stale observations | None in-history. Instead, `src/tools/reducer.ts` truncates **every** tool output at write time (grep 3k chars, read 4k, bash 4k, default 10k) and archives the raw output in the artifact store. | Reduction is applied to fresh observations too, which is the opposite of the paper's "keep recent verbatim, stub the stale middle". Caps are ~6× tighter than the paper's 24k. |
| Recall | `expand_artifact` tool (`src/tools/executor.ts:269`) plus heuristic `recallArtifacts` (`src/agent/artifact-compaction.ts:362`). | We carry recall machinery the paper found unused. Usage is unmeasured. |
| Summarization / compaction | Two paths: compiled-state compaction (`compactMessagesViaArtifacts`, keep last 4 turns, trigger at 80k tokens **or 12 turns**, `artifact-compaction.ts:265`) and LLM summarization (`llm-summarize.ts`, keep 4). Proactive threshold `min(80k, 0.75 × input budget)` (`context-budget.ts`). `KEEP_TURNS_LADDER = [4, 2, 1]`. | Thresholds are absolute, not budget-relative; the 12-turn trigger fires long before context pressure on large windows. No soft/hard staging. |
| Planning | `tasks_set` (`src/tools/tasks.ts`) drives a UI panel. System prompt (`system-prompt.ts:75`) requires `tasks_set` before **every** mutating tool. Plan lives only in history as a tool call; an auto-advance heuristic (`loop.ts:552`) patches the UI when the model forgets. | Plan is not re-injected per turn. After compaction it survives only as a `next_actions`-style line in the compiled session state (`artifact-compaction.ts:179-187`), and not at all on the LLM-summary path unless the summarizer happens to mention it. The "before every mutating tool" rule is far heavier than the paper's protocol and is a likely token/cost sink for strong models. Not gated by intent tier. |
| Action space | 28 tools in `ALL_TOOLS` (`src/tools/executor.ts:28`) always exposed, plus LSP/MCP tools. Code Mode (`execute_code`) redirects read/bash/grep/glob into a sandbox for up to 4 redirects per turn. Only a "research" worker profile narrows the set. | No capability-dependent profile. Strong models pay ~28 schemas of prompt tokens per request and are steered away from bundled bash. |
| Stuck detection | `loop.ts:528–546`: third identical call in a window of 8 is blocked with a reminder; one recovery per turn, then `AgentLoopError`. | Stricter than paper (5 / 8) and doesn't distinguish identical-successful from identical-failing calls. Reasonable; tune with data. |
| Post-edit diagnostics | LSP manager receives `notifyChange` after write/edit (`app.tsx:2003`) but **nothing is appended to the tool result**. | Missing. The paper treats this as fixed substrate for a reason: it lets the model fix syntax/undefined-name errors without burning a test run. |
| Read-before-write + hash | Not enforced by `edit`/`write` (`src/tools/edit.ts`). | Missing. Cheap to add; prevents clobbering externally modified files. |
| Tool errors as observations | `ToolError` (`src/tools/tool-error.ts`) returned to the model. | Matches. |
| Completion check | `completion-check.ts` asks an external judge ("jev") whether the turn really finished, nudges once. | No paper analogue. Keep; log its decisions (see companion plan). |
| Matched evaluation | None. No benchmark runner, no trajectory labelling. | This is the biggest gap: every change below is currently unmeasurable. |

### 2.1 Where Autopilot is likely already ahead of the paper's harness

The paper's harness is a minimal research scaffold run non-interactively on locally served models. Several Autopilot design choices address the same problems in ways that are plausibly cheaper, faster, or better in real use. None of these are measured yet either, which is the point of Phase 0. The guiding rule for this plan is **do not make Autopilot worse**: nothing below ships until a matched comparison shows it is not worse on success, cost, and turns.

| Autopilot today | Paper's harness | Why Autopilot's choice is plausibly better |
| --- | --- | --- |
| Static/session prompt prefix split (`system-prompt.ts`), `cacheStable` request mode (`loop.ts:430`), old images dropped from requests. | No cache modelling; cost = raw tokens on SGLang. | On OpenRouter frontier models cached prefix tokens dominate cost. The paper's cost arguments against a large tool set and against planning overstate what a cached prefix actually costs. |
| Rule-based compiled-state compaction by default (`compactMessagesViaArtifacts`): no model call, no latency, structured extraction of files, tasks, failures. | M3 summarization is an extra call to the same model every time it fires. | The paper's own cost win for T4 came from firing summarization less often. Autopilot avoids the call entirely by default. |
| Structural reduction at write time (`src/tools/reducer.ts`): error-block extraction, consecutive-line dedupe, matches-per-file caps, file outlines; raw archived for `expand_artifact`. | Tail truncation at 24k chars; a noisy log costs 24k tokens on every request until it is stale. | Smaller fresh observations on every request, and the kept part is the informative part. |
| Stuck detection blocks on the third identical call, one recovery, then stop (`loop.ts:528`). | Reminder at 5, terminate at 8 identical failing calls. | Two to five fewer wasted calls per spin. |
| Code Mode (`execute_code`) bundles read/grep/glob/bash into one sandboxed program; only `console.log` output enters history. | Bash-only interface for strong models. | Same bundling benefit the paper credits for bash-only's win, without losing structured edit tools, state tracking, or permission previews. |
| Completion check (`completion-check.ts`): one small external yes/no call at turn end, skipped on light-tier turns. | Planning re-injected every turn, partly to stop weak models ending without an edit. | Targets the paper's main weak-model failure mode (runs ending without an edit) with far less per-turn overhead. |
| Per-turn intent tiers gate the completion check, subagent delegation, and Code Mode. | One static configuration per run. | This is the paper's own conclusion ("choose components per model, task, budget") applied per turn rather than per benchmark. |
| Memory, skills, AGENTS.md, LSP, checkpoints, permission prompts with diff previews. | Out of scope. | Most of the paper's failed runs died in Localize; project context and cross-session memory attack exactly that, but single-shot benchmarks cannot reward them. |

Consequences for the phases below: the reducer-cap change in Phase 1 is an experiment with a rollback, not a planned loosening; Phase 3 is demoted to eval-only until measured; and the paper's LLM summarization stays off by default.

---

## 3. Proposed changes

Rule for every phase: Autopilot is already good to use, and the paper's results are conditional on model and task. No change below ships as a default without a Phase 0 matched comparison showing it is not worse on success, cost, and turns for the models users actually run. Changes that only add missing substrate (Phase 4) are the exception, since they add information without removing any.

Ordered by expected value per unit of work. Each phase names the files it touches and how we will know it worked.

### Phase 0 — Headless evaluation harness (prerequisite)

Without this, phases 1–5 are opinions. The paper's whole contribution is that component effects flip sign across models.

- Add `scripts/eval/` (or `src/eval/`) that drives Autopilot in print/SDK mode (`src/print-mode.ts`, `src/sdk/`) over a task set, one worktree per task (`src/runs/worktrees.ts` already does this for workers).
- Task sources, in order of cheapness: (a) a 30–50 task slice of SWE-Bench Verified via the Harbor runner the paper used; (b) a hand-built "Autopilot-bench" of 20–30 tasks from this repo's own closed issues/PRs with their test commands (closest to our real distribution); (c) Terminal-Bench 2.1 later.
- Every harness knob below becomes an explicit config flag (`KimiConfig` in `src/config.ts` or an eval-only override object) so arms are matched.
- Output: one JSONL trajectory per run in the trace format from the companion plan, plus a summary table (success, cost from OpenRouter `usage.cost`, turns, overflow count, tool-call histogram).
- Paired comparison script: McNemar on success, mean cost, median turns.
- Exit criterion: can run the same 30 tasks on two models under two configs in under an afternoon.

### Phase 1 — Staged context management (T4 shape)

Goal: fewer `ContextBudgetError`s on small-window models, lower cost on large-window models, no accuracy loss.

1. **Budget-relative thresholds.** Replace the fixed `80_000` token / `12` turn triggers in `shouldCompact` and `PROACTIVE_COMPACTION_CAP_TOKENS` with soft `0.6 × effectiveInputBudget` and hard `0.85 × effectiveInputBudget`. Keep an absolute cap only as a cost control, configurable, default off for ≥128k windows.
2. **Elision pass before summarization.** New `elideStaleObservations(messages, budget)` in `src/agent/` that, when estimated tokens ≥ soft threshold, walks the *middle region* (everything after the system prompt / first user message and before the verbatim recent window of ≥ 2 turns or 0.3 × budget) and replaces bulky `tool` message bodies with a stub: `[tool output elided: N lines / M chars; re-run the tool if needed]`. Keep the `artifactId` in the stub so `expand_artifact` keeps working for now. Only when tokens are still ≥ hard threshold run the existing summarizer on the oldest middle turns.
3. **Experiment only: larger caps for fresh observations.** Once stale observations are elided, the reducer's caps for `read`/`bash`/`grep` could in principle rise (the paper used 24k chars). Treat this strictly as a Phase 0 experiment with a rollback: the current structural reduction is plausibly already cheaper per request than the paper's tail truncation (see §2.1), and larger fresh observations cost tokens on every request until elided. Run arms at today's caps, 2×, and 3×; keep the cheapest arm that is not worse on success. The reducer's structural work (outline, error-block extraction, dedupe) stays in every arm. Any cap change must be a function of the model's context window, never a global raise.
4. **Fire `PreCompact` before elision too** so the hook contract in `src/hooks/types.ts` stays honest.
5. **Measure recall.** Count `expand_artifact` calls and heuristic `recallArtifacts` hits per run in traces. If after Phase 0 runs they are as rare as the paper's `recall_event` (median 0), remove the heuristic recall injection and keep `expand_artifact` only as an opt-in tool, reclaiming prompt tokens and code.

Files: `src/agent/context-budget.ts`, `src/agent/artifact-compaction.ts`, `src/agent/llm-summarize.ts`, `src/agent/run-compact.ts`, `src/tools/reducer.ts`, `src/app.tsx` (auto-compaction call site), `src/sdk/`. Tests co-located; add a test that a 32k-window model running a 40-turn scripted session never throws `ContextBudgetError` and never summarizes before the hard threshold.

Success metric (Phase 0 harness): overflow failures → 0 on a 32k arm; cost per task on a 128k arm ≤ today's; success rate not significantly worse (McNemar).

### Phase 2 — Planning that is re-injected, lighter, and tier-gated

1. **Re-inject the live plan each turn.** Keep `tasks_set` as the write path, but before each model request append an ephemeral `<system-reminder>Current plan: …</system-reminder>` to the *end* of the request messages (not persisted, not in `messagesRef`). Append at the end so OpenRouter prompt caching of the stable prefix (`cacheStable` in `loop.ts:430`) is unaffected. This also makes the plan independent of compaction, which today keeps at most a one-line digest of it.
2. **Relax the protocol.** Replace the system-prompt rule "MUST call `tasks_set` immediately before each new step and after completing each step … Do not execute mutating tools without updating task progress first" with the paper's protocol: plan first on ~3+ step tasks, keep exactly one `in_progress`, mark completed when done, skip on trivial requests. Keep the auto-advance heuristic as the safety net for the UI.
3. **Gate by tier and model.** Use the existing intent classifier (`src/intent/classify.ts`: light / medium / heavy) and model tier: no plan reminder for `light`; for strong models, plan nudging only on `heavy`. Expose as config so Phase 0 can A/B it.
4. **Verification budget.** The paper's cost win for strong models came from trimming redundant post-edit verification. Add a soft reminder when the model has run ≥ N test/verification commands after its last edit with no new edits ("You have verified this change N times with no new changes; finish or state what is still uncertain").

Files: `src/agent/system-prompt.ts`, `src/agent/loop.ts` (request assembly), `src/tools/tasks.ts`, `src/intent/`. Metric: for a strong model, median turns and cost per task drop with no success loss; for a weak model, fraction of runs ending with zero edits drops.

### Phase 3 — Model-dependent tool profiles (eval-only until measured)

Demoted after §2.1. With a cached prompt prefix, the token cost of 28 tool schemas is small, so the paper's cost argument mostly does not transfer. The remaining hypothesis is that a smaller tool set reduces model confusion and round-trips for strong models, and Code Mode may already capture most of that. Build profiles behind an eval-only flag; promote to a user-facing default only if Phase 0 shows a win.


1. Introduce named tool profiles in `src/tools/executor.ts` beside `getWorkerTools`: `full` (today's `ALL_TOOLS`), `lean` (bash, read, edit, write, tasks_set, memory_*, subagent, github_create_pr), and `bash-first` (bash, edit, write, tasks_set) for eval only.
2. Select by model capability: a per-model `toolProfile` hint in `src/models/` (seeded for the frontier models; default `full`) and a user override in config.
3. Interactive caveat: in the TUI every `bash` call can prompt. A `lean` profile only pays off together with a sensible read-only allowlist in `src/permissions-evaluator.ts` (the paper's harness auto-allowed `git status/diff/log`, `ls`, `rg`, `cat`, `head`, `tail`, `wc`). Autopilot already classifies read-only commands; make sure the lean profile ships with that allowlist on.
4. Measure out-of-interface tool emissions (model calls a tool that is not exposed) per run; this is the paper's signature of a model that needs the full profile.

Files: `src/tools/executor.ts`, `src/models/`, `src/config.ts`, `src/permissions-evaluator.ts`. Metric: for frontier models, tool calls per task and cost drop; success unchanged. For small OpenRouter models, keep `full`.

### Phase 4 — Fixed substrate the paper had and we lack

1. **Post-edit diagnostics.** After a successful `edit`/`write`, append a compact diagnostics block to the tool result: LSP diagnostics for that file when a server is up (`src/lsp/manager.ts`, with a short debounce), else a language-specific fast check (`node --check` / esbuild transform for JS/TS, `python -m py_compile` / `ruff` if present, `go vet` single package). Cap at the reducer's lsp limits. Make it opt-out.
2. **Read-before-write with content hash.** Track `{path → sha256 at last read/write}` in the tool executor for the session. `edit` refuses when the file has never been read this session, or when its hash changed since (external modification), returning a `ToolError` that tells the model to re-read. Allow `write` to create new files freely.
3. **Stuck detection tuning.** Split `LOOP_THRESHOLD` into identical-any (reminder) and identical-failing (terminate) thresholds, both configurable, and log every trip (companion plan). Current defaults are stricter than the paper's; keep them until traces say otherwise.

Files: `src/tools/edit.ts`, `src/tools/write.ts`, `src/tools/executor.ts`, `src/lsp/manager.ts`, `src/agent/loop.ts`. Metric: fewer wasted test runs after syntax-broken edits; fewer "edit old_string not found" retries.

### Phase 5 — Trajectory analytics

Port the paper's annotation schemes so we can explain *why* a number moved, not just that it moved:

- Rule-based first pass from tool names (read/grep/glob → Localize; edit on repo file → Fix; bash matching test runners → Verify; create/run a repro file → Reproduce) over trace JSONL.
- Optional LLM-judge pass with the paper's Figure 40–42 prompts for ambiguous bash commands (Terminal-Bench style 10-symbol taxonomy: I S C M E X T V N G).
- Failure-stage attribution for unresolved runs: file localization → line localization → patch → verification, earliest-failure convention.
- Report: survival curve of active runs per turn by phase, fraction of runs ending without an edit, re-patch rate, verification turns after last edit.

This is the same tooling the companion plan needs to filter and weight traces for post-training.

---

## 4. Things the paper argues *against* doing

- Don't invest further in recoverable elision (recall). Measure `expand_artifact` first; expect to shrink it.
- Don't adopt a single "best" harness for all models. OpenRouter users run everything from 8B to frontier models; the profile must follow the model.
- Don't assume planning is free. For strong models it is a cost lever, not an accuracy lever, and the current "before every mutating tool" rule is likely net negative for them.
- Don't treat context management as a quality feature on large windows. On 128k+ windows the gap was 2.7 points; the lever there is cost.

## 5. Caveats when transferring results

- Paper tasks are single-shot, non-interactive, Python-only. Autopilot sessions are multi-turn with a human in the loop, permission prompts, and mixed languages. Phase 0 should include our own task set for that reason.
- Temperature 0, 300-step cap, 16k output cap per turn in the paper; Autopilot defaults differ (`DEFAULT_MAX_COMPLETION_TOKENS = 16_384` matches).
- "Bash-only" in the paper bundled the loss of state tracking and diagnostics; a lean profile here should keep diagnostics (Phase 4) attached to `edit`/`write`.
- Effects were measured once per task; Terminal-Bench contrasts were mostly directional. Expect noise; use paired tests.

## 6. Suggested order and rough sizing

| Phase | Size | Depends on |
| --- | --- | --- |
| 0 Eval harness | 3–5 days | trace format from companion plan |
| 1 Staged context mgmt | 2–3 days | 0 |
| 4.1 Post-edit diagnostics, 4.2 read-before-write | 1–2 days | none |
| 2 Planning | 1–2 days | 0 |
| 3 Tool profiles (eval-only) | 2 days | 0, 4; promote only on measured win |
| 5 Trajectory analytics | 2–3 days | 0 |
