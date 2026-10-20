> **Retired (2026-10):** `/remote` and the Cloudflare remote agent were removed (#730). Kept as a design record.

# Development Plan: `/slash remote`

## Phase 0: Core Loop Changes (KimiFlare itself)

**Goal:** Make KimiFlare capable of running headlessly with auto-continue and token budgeting.

**Files to touch:**
- `src/agent/loop.ts` — Add `continueOnLimit` and `maxInputTokens` to `AgentTurnOpts`
- `src/index.tsx` — Add CLI flags `--continue-on-limit`, `--max-input-tokens`

**Behavior:**
- When `--continue-on-limit` is set and the inner loop hits 50 tool calls, append a system message and reset the counter instead of throwing.
- Track cumulative `prompt_tokens` across turns.
- When cumulative tokens hit `--max-input-tokens`, run one final synthesis turn and exit with code 42.
- Normal completion exits 0. Crashes exit 1.

**Deliverable:** `kimiflare --print "..." --dangerously-allow-all --continue-on-limit --max-input-tokens 5000000` works locally.

---

## Phase 1: MVP — End-to-End `/remote`

**Goal:** A user can type `/remote <prompt>` and get a PR or issue on GitHub without touching their laptop again.

### 1.1 Worker Template

**New file:** `src/remote/worker-code.ts` (template string containing the full Worker + DO source)

The Worker:
- `POST /jobs` → creates a new DO instance, returns job ID
- `GET /jobs/:id/stream` → SSE stream from the DO
- `DELETE /jobs/:id` → cancels and cleans up
- `GET /jobs` → list recent jobs (for TUI dashboard)

The Durable Object (`RemoteJobDO`):
- Creates Artifact repo via REST API
- Creates Sandbox via `getSandbox()`
- Clones user's GitHub repo into the Sandbox
- Installs KimiFlare (`npm install -g kimiflare`)
- Runs KimiFlare with the prompt + flags
- Streams stdout/stderr back via SSE
- Interprets exit code (0 = success, 42 = budget exhausted, 1 = crash)
- Pushes branch to GitHub, opens PR or issue
- Calls `sandbox.destroy()` + `DELETE` artifact
- Sets 30-minute alarm for emergency cleanup

### 1.2 TUI Integration

**New files:**
- `src/remote/index.ts` — Orchestration: deploy worker, start job, stream
- `src/remote/deploy.ts` — Wrangler CLI wrapper
- `src/remote/github-auth.ts` — GitHub Device Flow
- `src/remote/protocol.ts` — HTTP types
- `src/ui/remote-wizard.tsx` — Onboarding UI
- `src/ui/remote-stream.tsx` — SSE stream renderer

**Changes to existing:**
- `src/commands/builtins.ts` — Add `"remote"` to `BUILTIN_COMMANDS`
- `src/app.tsx` — Add `/remote` branch in `handleSlash`
- `src/config.ts` — Add `remoteWorkerUrl?: string`, `githubToken?: string`

### 1.3 Onboarding Flow (first `/remote`)

```
User: /remote refactor auth

TUI: �� Setting up remote execution...

     [1/3] Checking Wrangler...  ✅ (or installing)
     [2/3] Deploying worker...   ✅ (or showing permission error)
     [3/3] Connecting GitHub...  ✅ (Device Flow)

     Complex tasks may hit KimiFlare's tool-call limit.
     We'll auto-continue, but need a token budget.

     Max input token budget? [5,000,000]  (~$0.50–$2.00)

     Starting... You can close your laptop.
```

### 1.4 Streaming & Outcomes

- TUI shows streamed logs as chat events (new `kind: "remote"`)
- User can press Ctrl+C to cancel → sends `DELETE /jobs/:id`
- On completion, TUI shows: "✅ PR created: #123" or "❌ Failed — see GitHub issue #456"

### 1.5 Failure Handling (MVP level)

| Exit | GitHub Action |
|---|---|
| 0 (success, code changes) | Open PR |
| 0 (success, no changes) | Open issue with findings |
| 42 (budget exhausted) | Open PR if changes exist, else issue |
| 1 (crash) | Open issue with error log |
| TTL timeout | Open issue "Task timed out" |

**MVP excludes:**
- Prompt improvement suggestions in failure issues (just raw error log)
- Job history dashboard in TUI
- Resume/cancel from a reopened TUI
- Cost tracking beyond the budget prompt

---

## Phase 2: Resilience & Polish

**Goal:** The feature feels production-ready.

### 2.1 TUI Job Dashboard

When TUI starts, query `GET /jobs` and show:
```
Recent remote tasks:
  ✅ refactor auth    →  PR #123    (2h ago)
  ❌ optimize db      →  Failed     (5h ago)
  ⏳ write tests      →  Running    (10m ago)
```

### 2.2 Better Failure Reporting

- Parse error logs to suggest prompt improvements
- Include sandbox logs in GitHub issues
- Distinguish "KimiFlare crashed" vs "Sandbox OOM" vs "GitHub API error"

### 2.3 Resume / Cancel

- Reopened TUI can query running jobs
- User can cancel a running job from the dashboard
- User can see real-time progress of a running job

### 2.4 Configurable TTL

- `remoteTtlMinutes` in config (default 30)
- Show in budget prompt: "Budget: 5M tokens. TTL: 30 min."

### 2.5 Cost Transparency

- Track actual tokens spent per job
- Show in dashboard: "Used 2.3M / 5M tokens (~$0.80)"

---

## Phase 3: Future (not in this effort)

- **`/parallel N`** — Spawn N sandboxes from the same Worker, each with its own prompt
- **Greenfield support** — `/remote "create a new React app"` with no existing repo
- **Custom instance types** — Let user pick `lite` vs `basic` vs larger
- **Notifications** — Webhook, email, or Slack when job completes
- **Artifact retention** — Keep artifacts for debugging (configurable)
- **Pre-built container image** — Include KimiFlare in the Docker image to skip `npm install`

---

## Estimated Effort

| Phase | Files | Complexity | Est. Time |
|---|---|---|---|
| Phase 0 | 2 | Low | 1 day |
| Phase 1 | ~12 | High | 1–2 weeks |
| Phase 2 | ~4 | Medium | 3–5 days |
| **Total MVP (P0 + P1)** | **~14 files** | **High** | **1.5–3 weeks** |

---

## What We Build First

If you want to start **today**, the order is:

1. **Phase 0** — Core loop changes. This is self-contained and testable locally.
2. **Worker template** — Write the DO code as a standalone file first, test with `wrangler dev`.
3. **TUI integration** — Wire `/remote` → deploy → start job → stream.
4. **GitHub Device Flow** — Add the auth step.
5. **End-to-end test** — Run `/remote` on a real repo, verify PR creation.

**Ready to start with Phase 0?**
