> **Retired (2026-10):** `/remote` and the Cloudflare remote agent were removed (#730). Kept as a design record.

# `/slash remote` — Finalized Plan

> Status: Decisions made. Ready to implement.

---

## Decisions

| Question | Decision | Rationale |
|---|---|---|
| **Worker deployment** | Wrangler CLI | Standard path. Bindings for Sandbox + Artifacts are trivial in `wrangler.toml`. |
| **Worker model** | **One persistent Worker per user** | Deploy once, reuse forever. Uses Durable Objects to manage individual jobs. Future `/parallel 20` becomes "spawn 20 DOs from the same Worker" — no architectural block. |
| **GitHub auth** | **Device Flow** | User preference. Simpler, no callback server needed, standard CLI pattern. |
| **Artifact lifecycle** | **One per job** | Isolated Git server per task. No cross-contamination. |
| **Cleanup** | **30-minute TTL with auto-destroy** | Sleeping containers are cheap but not free. 30 min is the safety default. Configurable later. |
| **Success criteria** | **PR for code tasks, GitHub issue for research/planning** | The inner KimiFlare decides which to create based on the prompt. |
| **Inner mode** | **Always "auto"** | No human in the sandbox to approve tool calls. |

---

## Architecture

```
┌─────────────────┐     HTTP/SSE      ┌─────────────────────────────────────┐
│  KimiFlare TUI  │◄─────────────────►│  User's Cloudflare Worker           │
│  (user machine) │   (long-running)  │  (deployed once via wrangler)       │
└─────────────────┘                   └──────────────┬──────────────────────┘
                                                     │
                          ┌──────────────────────────┼──────────────────────────┐
                          │                          │                          │
                          ▼                          ▼                          ▼
                   ┌─────────────┐          ┌─────────────┐            ┌─────────────┐
                   │  Durable    │          │  Sandbox    │            │  Artifact   │
                   │  Object     │◄────────►│  (Container)│◄──────────►│  (Git repo) │
                   │  (per job)  │  manages │             │  git ops   │             │
                   └─────────────┘          │  KimiFlare  │            │  working    │
                                            │  installed  │            │  tree       │
                                            └─────────────┘            └─────────────┘
```

### Why Durable Objects?

Each `/remote` call creates a **new Durable Object instance**. The DO:
- Owns the lifecycle of exactly one Sandbox + one Artifact.
- Streams logs back to the TUI via SSE.
- Sets a 30-minute alarm. If the TUI hasn't called `DELETE /jobs/:id` by then, the DO calls `sandbox.destroy()` + `DELETE` artifact.
- For `/parallel 20`, we create 20 DOs. Each is independent. No shared state.

The **Worker** is just a thin router:
- `POST /jobs` → `env.JOBS.newUniqueId()` → `id.getStub().fetch(req)`
- `GET /jobs/:id/stream` → `env.JOBS.get(id).fetch(req)`
- `DELETE /jobs/:id` → same

---

## Onboarding Flow (first `/remote`)

```
User types "/remote refactor auth middleware"
    │
    ▼
TUI checks config for "remoteWorkerUrl"
    │
    ├── Missing? ──────────────────► Check if wrangler is installed
    │                                 │
    │                                 ├── Not installed? ──► "Installing wrangler..."
    │                                 │                      (npm install -g wrangler)
    │                                 │                      If fails → "Please run: npm install -g wrangler"
    │                                 │
    │                                 └── Installed? ──────► "Deploying remote worker..."
    │                                                        (wrangler deploy from bundled worker code)
    │                                                        Parse output for Worker URL
    │                                                        Save to config.json
    │
    └── Present? ──────────────────► Check GitHub token
                                     │
                                     ├── Missing? ────────► "Connect GitHub to open PRs/issues"
                                     │                      Device Flow: open github.com/login/device
                                     │                      Code: XXXX-XXXX
                                     │                      Poll for token
                                     │                      Save to config.json
                                     │
                                     └── Present? ────────► Proceed to execution
```

### Permission Checks

Before deploying, we validate the user's Cloudflare API token has:
- `Cloudflare Workers:Edit`
- `Account:Read` (for listing)
- `User:Read`

If any are missing, we show:
> "Your API token is missing permissions: Workers:Edit. Please create a new token at https://dash.cloudflare.com/profile/api-tokens with these permissions: [list]. Press Enter when done."

---

## Execution Flow

```
1. TUI sends POST /jobs
   Body: {
     prompt: "refactor auth middleware",
     repoUrl: "https://github.com/user/repo",      // from git remote get-url origin
     branch: "main",                                // current branch
     githubToken: "gho_...",
     cfAccountId: "...",
     cfApiToken: "...",
     mode: "auto"                                   // always auto for remote
   }

2. Worker routes to new Durable Object

3. Durable Object:
   a. POST /repos (Artifacts API) → create isolated Git repo
   b. getSandbox(env.Sandbox, jobId) → create container
   c. sandbox.exec('git clone <repoUrl> /workspace/repo')
   d. sandbox.exec('cd /workspace/repo && git config user.email ... && git config user.name ...')
   e. sandbox.exec('npm install -g kimiflare')     // or use npx
   f. sandbox.exec('cd /workspace/repo && KIMIFLARE_REMOTE=1 kimiflare --print "<prompt>"')
      → stream stdout/stderr back to TUI via SSE
   g. When KimiFlare exits:
      - Inspect exit code, last output, and working tree changes
      - If changes exist:
        * Code detected → push branch, open PR via GitHub API
        * Research/plan detected → open GitHub issue via GitHub API
      - If no changes → report "Task completed, no changes needed"
   h. sandbox.destroy()
   i. DELETE /repos/:name (Artifact cleanup)
   j. Return final result to TUI

4. TUI renders streamed logs as chat events (new kind: "remote")
```

### The 50-Tool Loop (Outer Loop in Worker)

KimiFlare inside the Sandbox hits `maxToolIterations = 50` and exits. The Durable Object:

```
outerIterations = 0
maxOuter = 10

while outerIterations < maxOuter:
    run kimiflare in sandbox
    if exit_code == 0 and no "continue" marker in output:
        break  // done
    if working tree has meaningful changes:
        git commit -m "WIP: iteration ${outerIterations}"
    append system message: "Continue where you left off. Previous context preserved."
    outerIterations += 1

if outerIterations == maxOuter:
    report: "Hit maximum iterations. Partial work committed to branch."
```

The inner KimiFlare doesn't know about the loop. It just runs to its 50-tool limit, exits, and the DO decides whether to continue.

---

## Cleanup Guarantees

| Scenario | Cleanup Action |
|---|---|
| Success (PR/issue created) | `destroy()` + `DELETE` artifact immediately |
| Failure (KimiFlare crashes) | `destroy()` + `DELETE` artifact after 30-min DO alarm |
| User cancels (Ctrl+C) | TUI sends `DELETE /jobs/:id` → immediate cleanup |
| TUI crashes / disconnects | DO alarm fires at +30 min → cleanup |
| Outer loop exhausted | Cleanup + report partial branch |

**Why 30 minutes?** A typical KimiFlare run is 2–10 minutes. 30 min gives enough buffer for the outer loop (10 iterations × ~2 min = 20 min) plus headroom. It's short enough to prevent surprise bills, long enough to not interrupt legitimate work.

---

## File Layout (new files)

```
src/
  remote/
    index.ts              # Main orchestration: deploy worker, run job, stream
    deploy.ts             # Wrangler CLI wrapper: check, install, deploy
    worker-code.ts        # The Worker + DO source code (as a template string)
    github-auth.ts        # Device Flow implementation
    protocol.ts           # TUI ↔ Worker HTTP types
    cleanup.ts            # TTL alarm logic (lives in DO, but types here)
  ui/
    remote-wizard.tsx     # Onboarding UI for /remote (wrangler, GitHub)
    remote-stream.tsx     # Render SSE stream in chat
  commands/
    builtins.ts           # Add "remote" to BUILTIN_COMMANDS
  app.tsx                 # Add /remote branch in handleSlash
  config.ts               # Add remoteWorkerUrl, githubToken fields
```

The actual Worker code lives as a **template string** in `src/remote/worker-code.ts`. When the user runs `/remote` for the first time, we:
1. Write the template to a temp directory.
2. Generate `wrangler.toml` with their accountId + bindings.
3. Run `wrangler deploy`.
4. Parse the deployed URL from stdout.

---

## Cost Estimate (for user transparency)

| Resource | Cost Driver | Typical Run |
|---|---|---|
| **Sandbox (Container)** | vCPU-seconds + memory-seconds while running | ~5 min × 0.5 vCPU × 1 GiB ≈ $0.01–0.05 |
| **Sandbox (sleeping)** | Minimal — just disk storage | ~$0.001/day |
| **Artifacts** | Storage + git operations | Negligible for single job |
| **Workers AI** | Same as local KimiFlare | $0.01–0.50 depending on prompt |
| **Durable Object** | Requests + storage | Negligible |

**Total per `/remote` call: roughly $0.02–0.50** (mostly AI, not infrastructure).

A 30-minute TTL means worst-case you pay for 30 min of container time if something goes wrong. A 24-hour TTL would be ~20× more expensive for a leaked container. **30 minutes is the right default.**

---

## Open Questions (last call)

1. **Should the Worker be deployed per-user (one for all their repos) or per-project (one per git repo)?**
   - *My recommendation: per-user.* Simpler, one deployment ever. The DOs are per-job anyway.

2. **Should we support running `/remote` without a GitHub repo (greenfield)?**
   - *My recommendation: MVP requires a git repo with a GitHub remote.* Greenfield can come later.

3. **Should the inner KimiFlare use the same model as the outer TUI, or a fixed model?**
   - *My recommendation: same model.* Pass `cfg.model` through to the sandbox.

If you're good with these three, **we're ready to build.**
