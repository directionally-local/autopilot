# Incident report: slow Autopilot session on 2026-11-06

**Date:** 2026-11-06 (14:59–17:58 JST)
**Classification:** Performance: model latency, tool timeouts, and a bug where processes survive a timeout.
**Session:** `~/.local/share/autopilot/sessions/2026-11-06T05-59-13-544Z_you-re-taking-over-engineering-for-direc.jsonl`
**Model:** `deepseek/deepseek-v4.1-flash-1017` through OpenRouter (`"provider": "openrouter"` in `~/.config/autopilot/config.json`)
**Autopilot code referenced:** `origin/main` at 3b17ffd (release 3.14.0)

## Summary

The session felt slow, but nothing failed. Over 3 hours of wall time, about 65 minutes went to 800 model calls, 73 minutes to tool calls, and 43 minutes to waiting on the user. Four things drove the slowness:

1. **Many small steps, each paying a fixed delay.** Each model call took 4.9 s on average and wrote only about 500 tokens.
2. **OpenRouter split requests across two upstream providers.** One of them is about 2.5× slower to return the first token.
3. **Very large contexts, and a cold prompt cache after an idle gap.** Prompts reached about 520k tokens.
4. **Tool calls that waited or timed out.** These took 34 minutes in total. Timed-out commands also kept running as orphaned processes, which is a bug.

## Correction: this was not Luminal

My first analysis said the latency was Luminal's. That was wrong. I took the "Luminal is slow: first token p50 ~4.6 s" line from the task prompt, which describes the **dl free-tier service** the agent was building. I matched it to Autopilot's own step latency without checking which provider Autopilot was actually using. Autopilot was configured for OpenRouter, and every request ID is an OpenRouter generation ID (`gen-…`). The two medians matching was a coincidence.

## Evidence

### Where the time went

| Bucket | Time | Detail |
|---|---|---|
| Model calls | 65 min | 800 calls. Median 4.0–4.7 s per hour of the day, p90 about 7–8 s, worst 39 s |
| Tool calls | 73 min | 20 min of `github_pr_checks` waits, 14 min in 3 calls that timed out |
| Waiting on the user | 43 min | |

### Upstream providers

I sampled 40 requests (every 20th) through OpenRouter's `GET /api/v1/generation`:

| Upstream | Requests | Median time to first token | Worst |
|---|---|---|---|
| PrimeIntellect | 24 | 1.2 s | 2.4 s |
| Cohere | 16 | 3.1 s | 6.1 s |

OpenRouter chooses the upstream because Autopilot sends no `provider` preferences. That is deliberate: the comment in `src/agent/client.ts` explains that setting `order` or `sort` turns off sticky routing, which keeps requests on one provider so the prompt cache keeps hitting.

### The 39 s step was a cold cache

- **Request:** `gen-1793954149-DmAAhdomZEZoOWJUzoGt`, at 17:35 JST.
- **Size and timing:** a 207,807-token prompt. OpenRouter reported 31.4 s to the first token and 36.2 s of generation time.
- **What came before:** a 14-minute wait on the user.
- **Cache:** `cost-debug.jsonl` shows a cache hit ratio of **0.04** for that request, against about 0.99 for the rest of the session. It also cost about 7× a typical step ($0.037).

The prompt cache had expired during the idle gap, so the provider had to process the whole 200k-token prompt again.

### Context size

Prompt size climbed to about 528k tokens before compaction brought it down to about 208k. It then grew again to about 341k. Autopilot only compacts at 60% (soft) and 85% (hard) of the model's input budget (`src/agent/context-budget.ts`). With a very large context window, that means it rarely compacts. `autoCompactCapTokens` (or the env var `AUTO_COMPACT_CAP_TOKENS`) is not set.

### Tool calls that waited or timed out

| When (UTC) | Call | Time |
|---|---|---|
| 08:46 | Full client test suite in `~/wt/starter-client` (`tsx --test "src/**/*.test.ts"`). The agent asked for a 900 s timeout; the tool capped it at 600 s | 600 s, timed out with no output |
| 08:12 | `github_pr_checks` with `wait_seconds: 300` | 304 s |
| 08:07 | `github_pr_checks` with `wait_seconds: 180` | 185 s |
| 07:56 | `grep -rln … ~` across the whole home directory | 120 s, timed out |
| 07:58 | `find ~ -maxdepth 4 …` | 120 s, timed out |

Waiting on CI is something the system prompt asks for (`src/agent/system-prompt.ts:78`, `src/agent/completion-check.ts`). The home-directory searches were a poor choice by the agent.

### Bug: timeouts don't kill the whole command

`src/tools/bash.ts` starts each command with `spawn(shell, [...shellArgs, command], {...})` and does not set `detached`. When the timeout fires, it calls `child.kill("SIGKILL")`. That kills only the shell, so any child processes are re-parented to launchd and keep running. On 2026-11-06 at about 17:00 JST:

- **PID 10114:** the home-directory `grep`, still alive after 65 minutes.
- **PIDs 20489, 20502, 20503 and 29643:** the `npm exec tsx --test` process chain, still alive after 13 minutes. It was stuck in `src/server/routes-github-proxy.test.ts`, which runs with `--test-timeout=0`, so it is probably a test that hangs.

These processes were idle when I looked, so they weren't using CPU at that moment. But a CPU-heavy orphan would compete with the next command, and the agent wrongly concludes the command has stopped.

## Recommendations

Ordered by speedup per unit of effort.

> **Status as of main @ 5f4215b (2026-11-07):**
> - ✅ **#4 (cap the context) — DONE & MERGED.** `autoCompactCapTokens` now defaults to 150k (#1177). Set it to `0` to opt out.
> - ✅ **#1 (kill process group on timeout) — DONE & MERGED.** #1179 (`fix: bash timeouts and aborts kill the whole process tree`, 25a6f4c): commands run in their own POSIX process group and timeout/abort SIGKILLs the whole group.
> - ⬆️ **#2 partially done:** the global test script runs with `--test-timeout=120000` and `--test-force-exit` (package.json), but `src/server/routes-github-proxy.test.ts` can still hang individually and the underlying hang is not fixed.
> - ❌ #3 (pin faster upstream) — user-config item, unchanged; no code change.
> - ❌ #5 (background CI waits), #6 (fewer/larger steps), #7 (home-dir sweep guard), #8 (log upstream `provider_name` in cost-debug.jsonl) — NOT done.
>
> Cross-reference: the sibling trace analysis lives at `docs/harness-trace-analysis-2026-11.md`. Its former top un-fixed item — an **adaptive loop-depth guardrail** — is now **DONE & MERGED** as #1182 (`feat: the stall guardrail ends runaway turns that make no file progress`, 3914677): after 50 tool iterations with no file-changing progress (`stallIterations`, 0 disables) the loop warns the model once, grants one more window, then ends the turn with a tool-free summary.

1. **Kill the whole process group on timeout or abort** (`src/tools/bash.ts`). Spawn with `detached: true` and call `process.kill(-child.pid, "SIGKILL")`, falling back to `child.kill` on Windows. Add a test that a background child like `sleep 1000 &` is gone after a timeout. This is a correctness fix, and it stops leftover processes from slowing later commands.
2. **Find and fix the hanging test** in `src/server/routes-github-proxy.test.ts` in `starter-client`/autopilot, and run test suites with a per-test timeout such as `--test-timeout=60000`. A hung suite then fails in a minute instead of using up the whole 10-minute bash limit.
3. **Pin the faster upstream, then measure.** In `~/.config/autopilot/config.json`:
   ```json
   "openrouterProvider": { "order": ["PrimeIntellect"], "allow_fallbacks": true }
   ```
   The expected gain is about 2 s on 40% of steps, which is roughly 10 minutes over a session like this one. The risk is the one the code comment warns about: `order` turns off sticky routing. Compare cache hit ratio in `cost-debug.jsonl` before and after. If hits fall below about 95%, the cache savings outweigh the faster first token, and the setting should be reverted.
4. **Cap the context.** Set `autoCompactCapTokens` to something like 150000. That keeps each step's prompt to about a third of the 520k peak. It also shrinks the cost of a cold cache after an idle gap: the 31 s step would have been closer to 10–15 s. Possible follow-up: compact when the user returns from a gap long enough that the cache has expired, since that request pays full price anyway.
5. **Wait for CI in the background.** Instead of blocking on `github_pr_checks` with `wait_seconds: 300`, let the agent continue with other work, or end the turn and get woken by the `job_*` tools when checks finish. That would remove most of the 20 minutes.
6. **Fewer, larger steps.** The model often spends a full step on one small action, like a lone `tasks_set` or a "Let me do it." message. Two options:
   - Encourage batching independent reads and edits into one `execute_code` call.
   - Have the harness merge `tasks_set` into the next tool call.

   Each step saved is about 5 s. At 800 steps, a 25% cut would save about 15 minutes.
7. **Guard against searching the whole home directory.** Have the bash tool warn when a command runs `grep -r`/`find` on `~` or `/` without `-maxdepth`/`--include` limits, or point the agent to `rg` with the project root.
8. **Record the upstream provider in `cost-debug.jsonl`.** OpenRouter returns `provider_name` from `/api/v1/generation`. With it logged, the next slowness question needs no API calls, and would have prevented my Luminal mistake.

## Open questions

- I have no logs from earlier days on this laptop, so I can't say whether this session was slower than usual or typical.
- I sampled only 40 of 800 requests, so the PrimeIntellect/Cohere split is an estimate.
