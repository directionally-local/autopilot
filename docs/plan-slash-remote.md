> **Retired (2026-10):** `/remote` and the Cloudflare remote agent were removed (#730). Kept as a design record.

# Plan: `/slash remote` — Cloudflare Sandbox + Artifacts

> Status: Planning phase. Do not build yet.

---

## 1. What We Learned About the Primitives

### Cloudflare Artifacts (Git-compatible storage)
- **What it is:** Versioned storage that speaks Git. Each "repo" is a Git remote.
- **REST API:** `POST /repos` → returns `{ remote: "https://<ACCOUNT>.artifacts.cloudflare.net/git/<ns>/<repo>.git", token: "art_v1_...?expires=..." }`
- **Lifecycle:** Repos persist until explicitly `DELETE /repos/:name`. No auto-cleanup.
- **Limits:** 10 GB/repo, 1 TB/account, 2,000 control-plane req/10s, 2,000 git req/10s per namespace.
- **Auth:** Cloudflare API token for control plane; repo token embedded in the remote URL.

### Cloudflare Sandbox SDK (isolated execution)
- **What it is:** Secure, isolated code execution environments built on Cloudflare Containers.
- **Key APIs:** `getSandbox(env.Sandbox, id)`, `sandbox.exec()`, `sandbox.writeFile()`, `sandbox.readFile()`, `sandbox.destroy()`
- **Lifecycle:**
  - Containers **auto-sleep after 10 minutes of inactivity** but still count toward account limits.
  - `destroy()` immediately terminates the container and permanently deletes all state (files, processes, sessions, ports).
  - `setKeepAlive(true)` sends heartbeat pings every 30s to prevent sleep.
- **Limits:** Workers Free = 50 subrequests/request; Workers Paid = 1,000 subrequests/request. WebSocket transport avoids subrequest limits.
- **Instance types:** `lite` (0.25 vCPU, 0.5 GiB), `basic` (0.5 vCPU, 1 GiB), up to large sizes.

### KimiFlare Internals (relevant)
- Slash commands handled in `handleSlash()` in `src/app.tsx`.
- Built-ins registered in `src/commands/builtins.ts`.
- Agent loop (`src/agent/loop.ts`) has `maxToolIterations` default **50**.
- Config stored in `~/.config/kimiflare/config.json` (accountId, apiToken, model, etc.).
- Onboarding UI (`src/ui/onboarding.tsx`) already exists for Cloudflare credentials.

---

## 2. Proposed Architecture

```
┌─────────────────┐     HTTP/SSE      ┌─────────────────────────────┐
│  KimiFlare TUI  │◄─────────────────►│  Cloudflare Worker          │
│  (user machine) │   (long-running)  │  (orchestrator + OAuth)     │
└─────────────────┘                   └──────────────┬──────────────┘
                                                     │
                          ┌──────────────────────────┼──────────────────────────┐
                          │                          │                          │
                          ▼                          ▼                          ▼
                   ┌─────────────┐          ┌─────────────┐            ┌─────────────┐
                   │  Sandbox    │          │  Artifact   │            │  GitHub     │
                   │  (Container)│◄────────►│  (Git repo) │            │  (OAuth)    │
                   │             │  git ops │             │            │             │
                   │  KimiFlare  │          │  working    │            │  PR create  │
                   │  installed  │          │  directory  │            │  push       │
                   └─────────────┘          └─────────────┘            └─────────────┘
```

### Flow

1. **User types:** `/remote refactor the auth middleware to use JWT`
2. **TUI sends:** `POST /jobs` to the orchestrator Worker with `{ prompt, repoUrl?, branch?, githubToken? }`
3. **Worker:**
   a. Creates an Artifact repo via `POST /repos`.
   b. Gets or creates a Sandbox instance.
   c. Clones the user's GitHub repo into the Artifact (or forks it).
   d. Installs KimiFlare inside the Sandbox (`npm install -g kimiflare` or `npx`).
   e. Runs KimiFlare in the Sandbox with the user's prompt, streaming stdout/stderr back via SSE.
   f. When KimiFlare finishes (or hits the 50-tool limit), evaluates if the task is done.
   g. If not done, loops back to (e) with a "continue" system message (up to an outer limit).
   h. When done, pushes the Artifact to GitHub and opens a PR.
   i. Destroys the Sandbox and optionally deletes the Artifact.
4. **TUI:** Receives streamed logs and a final "PR opened: #123" message.

---

## 3. Critical Open Questions

These must be answered before writing code. They represent product, security, and architectural forks.

### Q1: Who owns and deploys the orchestrator Worker?

| Option | Pros | Cons |
|--------|------|------|
| **A. KimiFlare team hosts a shared Worker** | Zero user setup; smooth onboarding; we control updates | We pay for Containers + Workers AI; multi-tenancy complexity; abuse risk |
| **B. User deploys their own Worker** | User pays their own bill; no multi-tenancy | Requires Wrangler, `wrangler deploy`, binding Sandbox + Artifacts; huge friction |
| **C. Hybrid: shared Worker for orchestration, user's account for AI** | User pays for AI; we pay for Containers | Complex auth; user still needs Cloudflare creds |

**My recommendation:** Start with **A** (shared Worker) for the MVP, but design the protocol so it could become **B** later. The onboarding question "Is Wrangler set up?" only makes sense for Option B. If we go with A, the onboarding becomes "Is your GitHub connected?"

### Q2: How does the TUI authenticate to the Worker?

- API key? JWT? Cloudflare Access?
- If the Worker is shared, we need user identity. Do we build a simple signup/login flow?
- Or do we piggyback on GitHub OAuth — "authenticate with GitHub" gives us identity + repo access in one step?

### Q3: How does KimiFlare inside the Sandbox get AI credentials?

- **Option A:** Pass the user's `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` into the Sandbox as env vars. **Risk:** user's token lives inside a container we control.
- **Option B:** The Worker proxies AI calls. KimiFlare inside the Sandbox calls a local endpoint (`http://localhost:8788/ai`) that forwards to Workers AI using the Worker's own credentials. **Risk:** more infra, but better isolation.
- **Option C:** The Sandbox runs KimiFlare in "remote mode" where it doesn't call Workers AI directly; instead, it streams tool calls back to the Worker, which executes them and returns results. **Risk:** massive protocol complexity, but maximum control.

**My recommendation:** Option A for MVP (pass credentials), with clear documentation that the token is ephemeral (only lives for the session). Option B for v2.

### Q4: GitHub OAuth — Device Flow vs. Web Flow?

- **Device Flow** is the standard for CLI apps (like `gh auth login`). User gets a code, visits `github.com/login/device`, enters code, authorizes.
- **Web Flow** requires a callback URL. Our Worker can act as the callback endpoint. The TUI opens the browser, the user authorizes, the Worker receives the code, exchanges it for a token, and notifies the TUI (via polling or WebSocket).

**My recommendation:** Device Flow is simpler and doesn't require the Worker to be a callback server. But Web Flow feels smoother (one click). If we already have a Worker, Web Flow is viable.

### Q5: What is the exact GitHub → Artifact → GitHub workflow?

The user said: "Artifact is a Git server." So the Artifact holds the working tree. But we need to get code *from* GitHub *into* the Artifact, and then create a PR *on* GitHub.

Two approaches:

1. **Mirror approach:**
   - Clone user's GitHub repo into the Artifact.
   - Run KimiFlare inside the Sandbox, working against the Artifact repo.
   - When done, push the Artifact to a new branch on GitHub.
   - Open PR via GitHub API.
   - **Problem:** The Artifact remote is `artifacts.cloudflare.net`. To push to GitHub, we need to add GitHub as a second remote and push there. Or we can use `git format-patch` + GitHub API to create commits.

2. **GitHub-as-source approach:**
   - Don't use Artifact as the primary working directory.
   - Instead, the Sandbox clones the GitHub repo directly to `/workspace/repo`.
   - Use Artifact only for intermediate snapshots or caching.
   - **Problem:** This undermines the "Artifact is a Git server" value prop. Also, if the Sandbox dies, work is lost.

3. **Hybrid (recommended):**
   - Artifact is the canonical working repo.
   - On start: `git clone --mirror <github-repo>` into the Artifact, or use the Artifact `import` API.
   - KimiFlare works in the Artifact.
   - On finish: add GitHub as a remote, push the branch, open PR via GitHub API.
   - **Question:** Does the GitHub token need `repo` scope? Yes. And potentially `workflow` scope if modifying GitHub Actions.

### Q6: Sandbox cleanup — deterministic lifecycle

From the docs: *"Containers automatically sleep after 10 minutes of inactivity but still count toward account limits. Use `destroy()` to immediately free up resources."*

We need a **deterministic cleanup strategy**:

| Trigger | Action |
|---------|--------|
| Task completes successfully | `destroy()` sandbox, `DELETE` artifact (or keep for 24h for debugging) |
| Task fails / errors | Same as above, but maybe keep artifact for inspection |
| User cancels (Ctrl+C in TUI) | TUI sends `DELETE /jobs/:id` → Worker calls `destroy()` |
| TUI disconnects / crashes | Worker needs a TTL. Durable Object alarm? Cron trigger? |
| 50-tool limit hit, loop continues | `keepAlive` must be on; don't destroy between iterations |
| Outer loop limit exceeded | `destroy()` + notify user |

**Open question:** Should we use a Durable Object to hold the sandbox reference and set an alarm for cleanup? Or can the Worker manage stateless cleanup via a `jobs` table in D1/KV?

### Q7: The 50-tool-call loop — inner vs. outer

KimiFlare's `runAgentTurn()` defaults to `maxToolIterations = 50`. Inside the Sandbox, KimiFlare will hit this limit and return a "I need to continue" message (or just stop).

Two ways to handle this:

1. **Outer loop in the Worker:**
   - Worker runs KimiFlare in the Sandbox.
   - When it exits, Worker inspects the exit code / last message.
   - If it looks like "need to continue," Worker appends a system message "Continue where you left off" and runs KimiFlare again.
   - Repeat up to, say, 10 outer iterations (500 total tool calls).
   - **Pros:** No changes to KimiFlare core.
   - **Cons:** Each iteration is a fresh `runAgentTurn`, so context compaction may kick in. The agent loses the "flow" of the current turn.

2. **Inner loop modification:**
   - Add a `--remote` or `--continue-on-limit` flag to KimiFlare.
   - When the inner loop hits 50, instead of returning, it automatically starts a new turn with a "continue" prompt.
   - **Pros:** Smoother experience; context is preserved within the same process.
   - **Cons:** Requires modifying KimiFlare's core loop. Risk of infinite loops.

**My recommendation:** Option 1 (outer loop in Worker) for MVP. It's safer and doesn't touch the core agent loop. We can add a special exit code or marker file that the Worker checks.

### Q8: Streaming — how does the TUI see progress?

The user wants to "stream back" progress. Options:

1. **SSE from Worker to TUI:** The Worker runs the Sandbox and pipes `sandbox.execStream()` output through an SSE stream to the TUI.
2. **Polling:** TUI polls `GET /jobs/:id/logs` every few seconds.
3. **WebSocket:** TUI connects via WebSocket to the Worker (or a Durable Object).

**My recommendation:** SSE is the sweet spot for this. The Worker can use `execStream()` to get sandbox output as an SSE stream, then forward it to the TUI as another SSE stream. Both are push-based and work well over HTTP.

### Q9: What repo does KimiFlare work on?

When the user types `/remote refactor auth`, which repo is being refactored?

- **Option A:** The repo the user is currently in (detected from `process.cwd()`). The TUI sends the repo URL to the Worker.
- **Option B:** Any repo the user specifies: `/remote refactor auth in github.com/user/repo`.
- **Option C:** The Artifact starts empty, and KimiFlare creates a new project from scratch.

**My recommendation:** Option A as default, Option B via explicit argument. The TUI can detect the remote URL via `git remote get-url origin`.

### Q10: Cost transparency

Running a Sandbox on Containers costs money. Workers AI costs money. Artifacts storage costs money.

- Do we show the user an estimated cost before starting?
- Do we cap the max runtime (e.g., 30 minutes)?
- Do we cap the max outer loop iterations?
- What happens if the user hits their Cloudflare account limits?

---

## 4. Proposed Onboarding Flow

If we go with the **shared Worker + GitHub OAuth** model:

```
User types /remote for the first time
    │
    ▼
TUI checks config for "remoteWorkerUrl" and "githubToken"
    │
    ├── Missing remoteWorkerUrl? ──► Show: "Remote execution requires a worker.
    │                                 [Use shared worker]  [Set custom worker URL]"
    │
    ├── Missing githubToken? ──────► Show: "Connect GitHub to open PRs.
    │                                 [Open github.com/login/device]  Code: ABCD-EFGH"
    │                                 (or Web Flow with callback to Worker)
    │
    └── Both present? ─────────────► Proceed to execution
```

If we go with the **user-deployed Worker** model:

```
User types /remote for the first time
    │
    ▼
TUI checks: Is Wrangler installed? Is a Worker deployed with Sandbox + Artifacts bindings?
    │
    ├── No Wrangler? ──────────────► Show install instructions + link to docs
    │
    ├── No Worker? ────────────────► Show: "Deploy remote worker? [Yes]"
    │                                 → TUI runs `wrangler deploy` under the hood
    │
    └── Worker ready? ─────────────► Check GitHub auth → Proceed
```

**My strong recommendation:** Start with the shared Worker model. The user-deployed model is too much friction for a "type /remote and go" experience.

---

## 5. Phased Implementation Plan

### Phase 0: Foundation (no user-facing changes)
- [ ] Answer the 10 open questions above.
- [ ] Decide on shared Worker vs. user-deployed Worker.
- [ ] Set up the orchestrator Worker repo (separate from KimiFlare CLI).
- [ ] Design the TUI ↔ Worker HTTP protocol (job creation, SSE streaming, cancellation).

### Phase 1: MVP — "Run KimiFlare in a Sandbox"
- [ ] Build the orchestrator Worker:
  - `POST /jobs` — create sandbox + artifact, run KimiFlare.
  - `GET /jobs/:id/stream` — SSE stream of sandbox output.
  - `DELETE /jobs/:id` — cancel and cleanup.
  - Auto-cleanup on timeout (Durable Object alarm or KV TTL).
- [ ] Add `/remote` slash command to KimiFlare TUI:
  - Parse prompt.
  - Send to Worker.
  - Render SSE stream in chat (new event kind: `remote`).
  - Handle cancellation (Ctrl+C sends DELETE).
- [ ] KimiFlare inside Sandbox uses user's Cloudflare creds (Option A from Q3).
- [ ] No GitHub PR yet — just run and show results in TUI.
- [ ] No loop yet — single 50-tool-call run.

### Phase 2: GitHub Integration
- [ ] GitHub OAuth (Device Flow or Web Flow).
- [ ] Store `githubToken` in KimiFlare config.
- [ ] Worker clones GitHub repo into Artifact before running.
- [ ] Worker pushes branch to GitHub and opens PR after completion.
- [ ] TUI shows "PR opened: #123" with a clickable link.

### Phase 3: Loop & Resilience
- [ ] Outer loop in Worker: detect "need to continue" and re-run KimiFlare.
- [ ] Configurable outer loop limit (default 10).
- [ ] Better error handling: retry on sandbox failure, graceful degradation.
- [ ] Cost estimation / runtime caps.

### Phase 4: Polish
- [ ] Artifact retention policy (auto-delete after N hours).
- [ ] Resume interrupted remote jobs.
- [ ] Multiple sandbox instance types (user picks lite/basic/pro).
- [ ] Support for private GitHub repos (already works with token, but verify).

---

## 6. Risks & Concerns

1. **Security:** Passing user's `CLOUDFLARE_API_TOKEN` into a shared Sandbox is a trust boundary issue. We should document this clearly and aim for Option B (proxy) in v2.
2. **Cost:** Containers are not free. A long-running KimiFlare session could cost dollars. We need runtime caps and clear user communication.
3. **Complexity:** This is essentially building a CI/CD pipeline inside a Cloudflare Worker. The failure modes are numerous (sandbox OOM, network issues, Git conflicts, GitHub rate limits).
4. **State management:** The Worker needs to track job state (running, completed, failed). Durable Objects are the right tool but add complexity.
5. **Git merge conflicts:** If the user's repo has changed since the Artifact was cloned, pushing will fail. We need to handle rebase/merge or at least fail gracefully.
6. **KimiFlare inside KimiFlare:** Running KimiFlare inside KimiFlare is meta. The inner instance needs to not recursively try to spawn another remote session.

---

## 7. The Most Important Question

> **Do we build and host the orchestrator Worker ourselves, or do we make the user deploy it?**

This single decision determines:
- Whether "Is Wrangler set up?" is part of onboarding (user-deployed) or not (shared).
- Who pays for Containers + AI usage.
- The security model for user credentials.
- The complexity of the initial MVP.

**My recommendation:** Build a shared Worker. It aligns with the "type `/remote` and go" UX vision. We can always add a "bring your own Worker" option later.

---

*Plan written 2026-05-03. Do not build until the 10 open questions are resolved.*
