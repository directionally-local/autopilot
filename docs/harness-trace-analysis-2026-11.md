# dl / autopilot harness — trace analysis (Nov 4–7, 2026)

> Local telemetry deep-dive. Read-only research, no code changes. Main pulled to v3.14.0 (3b17ffd) at the time of analysis.

| | |
|---|---|
| LLM API requests | 893 |
| logged user turns | 93 |
| prompt tokens (2 days) | 228.7M (96% cached) |
| total gateway cost | ~$3.41 |
| median time-to-first-token | 3.0s (p99 13.7s) |
| max API calls in one turn | 130 |
| turns with memory recalled | 0 / 93 |
| turns offered a subagent | 0 / 24 |

## TL;DR

The harness is functionally working (only ~1 real failure in 900 requests), but three things dominate the experience: **multi-second TTFT on nearly every request** (~51 cumulative minutes of pure first-token wait in 2 days), **context bloat up to 442K tokens per turn** with per-turn cache-hit ratios swinging between 0 and 0.98, and **very deep agent loops** (up to 130 API calls / 356 consecutive tool calls in a single turn). Meanwhile three adaptive subsystems that already exist — memory, subagents, and output reduction — effectively **never fire**. The telemetry already written is a labeled dataset: with two schema fixes it's directly usable to train routing, compaction, and safety predictors, and the A/B rig (eval runner + paired McNemar) already exists to prove any learned policy helps.

## 1. Data inventory — what exists on this machine

| Source | Path | Size | Contents |
|---|---|---|---|
| Request-level log | `~/.config/autopilot/logs/2026-11-04..07.jsonl` | ~2.8 MB | 9,770 events: request/TTFT/stream timings keyed by requestId, bash spawn/exit, code-mode spans, retries, errors |
| Turn-level cost/debug | `~/.local/share/autopilot/cost-debug.jsonl` | 54 rows | Per-turn: durationMs, preTurnMs, token usage + cached_tokens, cacheDiagnostics, promptSections, intent classification, toolStats, toolSavingsPct, codeMode, memoryRecalled |
| Session transcripts | `~/.local/share/autopilot/sessions/*.jsonl` | 6 sessions | Claude-format JSONL; the big Nov-6 session alone is 1,623 entries with 793 tool_use calls |
| Daily rollup | `~/.local/share/autopilot/history.jsonl` | 2 rows | Per-day prompt/completion/cached token totals, request counts, cost |
| Subagent telemetry | `~/.local/share/autopilot/subagents.jsonl` | 24 rows | Near-empty: only `{offered:false, guidance:"none"}` per turn — no task, duration, or outcome |
| Session traces | `src/trace` (KIMIFLARE_TRACE=1) | — | Not enabled on this machine — no trace.jsonl found |

Note on coverage: ~2 days of active use by one operator, mostly one marathon session ("taking over engineering for Directionally Local"). Great for finding harness pathologies, too small to train anything serious on its own — but it proves the data pipeline exists end-to-end.

## 2. Where the time goes (speed)

### 2.1 Time-to-first-token is the single biggest latency

n=889 requests, mean 3.46s → **≈51 minutes of the 2 days spent purely waiting for the first token**.

| TTFT | |
|---|---|
| p50 | 3,055 ms |
| p75 | 4,172 ms |
| p90 | 5,359 ms |
| p99 | 13,658 ms |
| max | 34,437 ms |

Streaming itself is fast by comparison (median 1.0s, p90 4.5s). TTFT scales with prompt size — and prompts are enormous (§3), so this compounds.

### 2.2 TTFT by model — the default is not the fastest

| Model (via OpenRouter) | Requests | TTFT p50 | TTFT p90 | Mean |
|---|---|---|---|---|
| deepseek/deepseek-v4.1-flash-1017 (default) | 868 | 3,032 ms | 5,068 ms | 3,435 ms |
| moonshotai/kimi-k2.5 | 8 | 1,802 ms | 2,419 ms | 1,603 ms |
| openai/gpt-6-luna | 7 | 5,108 ms | 10,694 ms | 5,342 ms |
| moonshotai/kimi-k3 | 10 | 6,811 ms | 7,219 ms | 6,159 ms |

### 2.3 Turn-level timing

Median turn **90s**, p90 **277s**, total logged turn time **5.4 hours** across 93 turns. Outliers: one turn ran **2h14m** (8,031s), another 23m (1,402s). Harness-side pre-turn overhead (memory routing, skills, prompt assembly) is fine: **p50 = 11ms**, but p90/max spikes to **1.5s** — worth investigating what's slow on those turns (cold start per session?).

### 2.4 Agent loop depth — the hidden multiplier

API requests per user turn, from the request log: 36, 6, 1, 128, 1, 29, 3, 8, 116, 25, 2, 130, 1, 1, 2, 1, 1, 33, 1, 8, 10, 11. In the big session transcript there is a streak of **356 consecutive execute_code calls** with nothing else in between. Every one of those requests pays the ~3s TTFT on the full (often ~1MB) context.

**The 3× loop tax:** each loop iteration pays (a) ~1.15MB request body upload, (b) ~3s TTFT, (c) stream + tool execution. A 130-request turn is ~6.5 minutes of TTFT alone before any work happens. Cutting loop depth 30% is worth more than any model swap.

## 3. Context bloat & caching

- Max prompt tokens/turn: **442,504**; median request body **1.15 MB**; mean prompt tokens/turn 64.8K; 96.8% cached on Nov 6 by tokens.

### 3.1 The big session's prompt never shrank

Progression across the Nov-6 marathon session (tokens per turn): 391K → 401K → 408K → 439K → 392K → 440K → 440K → 442K. The conversation was effectively append-only for hours. Output was tiny (median completion ~600 tokens) — the spend is on *re-reading*, not writing.

### 3.2 Caching is doing all the work — and it's brittle turn-to-turn

Nov 6: 224.8M prompt tokens, 217.6M cached → **96.8% hit by tokens**, which is why the day only cost $2.97 despite quarter-million-token prompts. But the *per-turn* cacheHitRatio oscillates wildly: 0.98 → 0.98 → **0.02** → **0.00** → 0.00 → 0.02 → 0.96 → 0.00. Every bust re-prices ~400K tokens at full rate and adds to TTFT.

**Instrumentation gap:** `cacheDiagnostics.changedSegment` is `"none"` in all 93 rows even when cacheHitRatio = 0 — meaning the prompt prefix did *not* change locally, so those busts are provider-side (idle cache expiry or an upstream provider switch). That distinction is not directly recordable today because the upstream `provider_name` is not logged (see §7 status).

### 3.3 Tool output reduction barely saves anything

`toolSavingsPct`: median 0%, mean 2%. Across all turns: 803 KB raw → 785 KB reduced (**2.3% saved**). Given bash/read/grep dominate tool traffic and are the main context growers, this lever is currently decorative. Meanwhile prompts are 17.3M chars over 93 turns.

## 4. Failure & waste patterns

| Pattern | Evidence | Cost |
|---|---|---|
| **Unbounded home-directory scans** | 3 bash kill_timeouts in one day — all `grep -rln ... ~` or `find ~ -maxdepth 4` over the entire home dir | Each burned a full timeout + retry + re-reasoning |
| **Network flakiness** | 4× fetch_error with model_retry backoff; one turn hard-failed after 3 attempts | Backoff 0.9–2.9s each; one dead turn |
| **User interruption** | 1× user_stopped mid-turn, 1× SIGINT | User gave up waiting — a latency symptom |
| **Tool errors** | 1/278 tool calls failed (github_update_pr); 1 hooks:project_settings_untrusted | Negligible |

Overall reliability is good: 821/828 stream_end, 4 retries recovered. The waste is structural (loops, timeouts, bloat), not crashes.

## 5. Adaptive subsystems that never fired

| Subsystem | Evidence over Nov 6–7 | Status |
|---|---|---|
| Cross-session memory | `memoryRecalled: false` in 93/93 turns; the repo has a memory.db and the loop has one-shot recall injection | dormant |
| Subagent routing | `offered:false, guidance:"none"` in 24/24 rows; subagent-policy returns "none" for light tier | dormant |
| Output reduction | 2.3% savings; p50 toolSavingsPct = 0 | ineffective |
| Intent classification | Works (verify 46, explore 15, qa 14, other 13, small_edit 5) — heuristic, "verify" dominating suggests over-classification | working, un-validated |

## 6. ML menu (from the report)

1. **Learned intent → model/effort router** — k2.5's p50 TTFT (1.8s) is already 40% faster than the flash default on this traffic; a router sending qa/verify turns to the fastest cheap model is the single highest-ROI *model-side* speedup. Impact: high. Effort: small.
2. **Loop-runaway predictor → early compaction or subagent handoff** — training labels (requests-per-turn) already exist in logs. Directly attacks the 2.2-hour turns. Impact: high. Effort: medium.
3. **Bash-command risk classifier** (timeout / sweep detection) — 3/3 killed commands were home-dir sweeps. Can start rules-based. Impact: medium-high. Effort: small.
4. **Cache-break attribution, then prediction** — needs schema fix first (see §3.2 / #8 in the incident report). Impact: high. Effort: small.
5. **Tool-sequence model → speculative parallelization / prefetch** — grep→read chains, read→write pairs are predictable. Impact: medium. Effort: medium.
6. **Memory recall trigger tuning** — no ML needed to start: log gate decisions, fix the 0/93 rate. Impact: medium. Effort: tiny.

Any learned policy can be validated with the existing `autopilot eval run / eval compare` harness (paired McNemar on autopilot-bench).

## 7. Status vs main (verified as of 37e7af8, 2026-11-07 — #1189 opt-in model router and #1191 bash sweep guard, items 5 and 3 below)

Prioritized recommendations from both this report and the sibling incident report (`../autopilot-slow-session-2026-11-06.md`):

| # | Action | Status |
|---|---|---|
| — | Kill the whole process group on bash timeout/abort | ✅ **Done & merged** — #1179 (25a6f4c): commands spawn in their own POSIX process group, timeout/abort SIGKILLs the tree |
| — | Cap the context (autoCompactCapTokens) | ✅ **Done & merged** — #1177 (3441328): compaction thresholds capped at 150k tokens by default |
| — | Per-test timeout for the suite | ⚠️ **Partial** — package.json runs `--test-timeout=120000 --test-force-exit`, but `src/server/routes-github-proxy.test.ts` can still hang at the individual-test level; the underlying hang is unfixed |
| 1 | Telemetry schema fixes: join key requestId↔turn, per-turn outcome label, real subagent.jsonl payloads | ❌ Not done. Cache-break attribution partially exists (`changedSegment` static/session/dynamic in `src/cost-debug.ts`) but reads `"none"` in practice — busts were provider-side, and §8 below is needed to prove it |
| 2 | Debug why memory recall and subagent guidance fire 0% | ❌ Not done — no gate-decision logging exists |
| 3 | Bash sweep guard: reject/scope `grep -r ~`-style commands | ✅ **Done & merged** — #1191 (37e7af8): `guardSweep` (src/tools/bash.ts) blocks recursive grep/rg/find sweeps of bare `~`/`$HOME`/`/` (pipes, `cd ~ &&` prefixes and `-maxdepth 4`-style false shallows included; `find/fd` with `-maxdepth ≤3` allowed) and points the agent at scoped paths; escape hatch `AUTOPILOT_ALLOW_HOME_SWEEP=1` |
| 4 | **Cap loop depth adaptively**: at ~50 requests with no progress, force compaction or ask the user | ✅ **Done & merged** — #1182 (3914677): the stall guardrail tracks the last file-changing iteration; after 50 iterations with no progress (`stallIterations`, 0 disables) it warns the model once, grants one more window, then ends the turn with a tool-free summary |
| 5 | A/B a model router on eval bench (k2.5-class for qa/verify/light turns) | ✅ **Shipped (opt-in)** — #1189 (ea250f4): config `modelRouting: { "light": "<model>" }` routes light/medium turns to a faster model while the session runs the default model (a /model pick wins). Off by default pending cache-impact measurement: watch per-turn `cacheHitRatio`/`modelRouting` in cost-debug.jsonl; eval A/B still open |
| 6 | Strengthen output reduction (2.3% → 30–60%) for bash/read/grep | ✅ **Done & merged** — #1186 (0d86b09): bash pass-through now also gates on char and per-line caps (long minified/JSON lines no longer sail through), grep's `maxOutputChars` is enforced, read caps scale to 4% of the context window with a 48k ceiling (was 6% / 120k), `defaultMaxChars` 10k → 8k |
| 7 | Turn on KIMIFLARE_TRACE=1 locally | ❌ User-config item |
| 8 | Log upstream `provider_name` in cost-debug.jsonl (from OpenRouter `/api/v1/generation`) | ✅ **Join key shipped** — cost-debug.jsonl entries now carry `generationId`, which joins to usage.json's `gatewayLogs[].provider` (provider_name has been recorded there all along). A direct `provider` field on the entry is still open |
| — | Background CI waits instead of blocking `github_pr_checks` | ✅ **Done & merged** — #1188 (b663366): with `wait_seconds` set and checks still pending, the tool starts/reuses a durable managed job running `gh pr checks --watch` and returns immediately; unattended runs yield with `wait_for`, interactive sessions keep working. Falls back to in-line polling on Windows / missing gh |
| — | Fewer/larger steps (batch reads/edits, merge tasks_set into next call) | ❌ Not done |
| — | Pin faster upstream (openrouterProvider.order) | ❌ User-config item, deliberately not a code default (sticky-routing trade-off documented in `src/agent/client.ts`) |

## Methodology

Parsed 9,770 events from `~/.config/autopilot/logs` (Nov 4–7), 54 cost-debug rows, 6 session transcripts (1,623 entries in the Nov-6 session), history/subagents rollups. All figures computed from those files; no code was modified. Original HTML version: `dl-harness-trace-analysis.html` at the repo root.
