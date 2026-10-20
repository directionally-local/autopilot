> **Retired (2026-10):** `/remote` and the Cloudflare remote agent were removed (#730). Kept as a design record.

# `/slash remote` — Refined Plan (v3)

> Status: Decisions updated. Ready to implement.

---

## Updated Decisions

| Question | Decision |
|---|---|
| **Budget persistence** | **Ask every time.** No saved default. Each `/remote` is independent. |
| **Budget explanation** | Show a brief message before asking: *"Complex tasks may hit KimiFlare's tool-call limit. We'll auto-continue, but we need a token budget to prevent runaway costs."* |
| **Failure reporting** | **Create a GitHub issue for failures.** The user closed their laptop — they won't see the TUI. A GitHub issue is persistent and actionable. |
| **Job history** | TUI queries the Worker on startup to show status of recent remote jobs. |

---

## Failure Taxonomy — What Happens in Each Case

| Scenario | Outcome | GitHub Action |
|---|---|---|
| **Success — code changes** | Task completed, files modified | Open PR with changes |
| **Success — research/plan** | Task completed, no file changes | Open issue with findings |
| **Budget exhausted — partial work** | Hit token cap, some work done | Open PR with partial changes + comment: *"Budget exhausted. Review and continue manually or re-run with higher budget."* |
| **Budget exhausted — no work** | Hit token cap, nothing useful done | Open issue: *"Task exceeded budget without producing changes. Consider simplifying the prompt or increasing budget."* |
| **Inner crash / error** | KimiFlare threw an exception | Open issue: *"Remote task failed"* with error log + prompt improvement suggestions |
| **Sandbox crash** | Container OOM or killed | Open issue: *"Sandbox crashed"* with logs + suggestion to try with larger instance type (future) |
| **TTL timeout (30 min)** | Process still running, DO killed it | Open issue: *"Task timed out"* with partial branch + suggestion to increase budget or simplify |

---

## Why GitHub Issues for Failures?

The user closed their laptop. They will not see the TUI. Their next touchpoint is either:
1. GitHub (checking for the PR/issue they expected)
2. Reopening KimiFlare later

If we create nothing on failure, they check GitHub → nothing there → confusion → "Is it still running? Did it fail?"

A GitHub issue is the **persistent, async notification** they need. It says: *"Here's what happened, here's the error, here's how to fix your prompt next time."*

### Alternative: TUI Job Dashboard

When the user reopens KimiFlare, the TUI queries the Worker:
```
GET /jobs?limit=10
```

And shows:
```
Recent remote tasks:
  ✅ refactor auth middleware  →  PR #123  (2 hours ago)
  ❌ optimize database queries  →  Failed: token budget exhausted  (5 hours ago)
  ⏳ write tests for utils      →  Running...  (started 10 min ago)
```

This is **complementary** to GitHub issues, not a replacement. The GitHub issue is the async notification. The TUI dashboard is the "what did I miss?" summary.

---

## The Budget Prompt (exact UX)

```
User: /remote refactor the auth middleware to use JWT

TUI: �� Remote execution
     
     Complex tasks may hit KimiFlare's tool-call limit (50 calls per turn).
     We'll automatically tell the agent to continue, but we need a token
     budget to prevent runaway costs.
     
     Max input token budget? [5,000,000]  (~$0.50–$2.00)
     
User: [presses Enter]  → accepts 5M
      or types: 10000000  → 10M
      or types: 500000   → 500K

TUI: Budget: 5,000,000 input tokens.
     Deploying sandbox...
     You can close your laptop. A PR or issue will be created when done.
```

### Budget → Cost Mapping (shown to user)

| Budget | Estimated Cost (Kimi-K2.6) |
|---|---|
| 500K | ~$0.05–$0.20 |
| 1M | ~$0.10–$0.40 |
| 5M | ~$0.50–$2.00 |
| 10M | ~$1.00–$4.00 |
| 50M | ~$5.00–$20.00 |

These are rough estimates. Actual cost depends on output tokens too, but input tokens are the controllable variable.

---

## Inner KimiFlare Flags

```bash
kimiflare --print "<prompt>" \
  --dangerously-allow-all \
  --continue-on-limit \
  --max-input-tokens <budget>
```

### New core loop behavior (`src/agent/loop.ts`)

```ts
let cumulativeInputTokens = 0;

for (let iter = 0; iter < max; iter++) {
  // ... run turn ...
  
  if (lastUsage) {
    cumulativeInputTokens += lastUsage.prompt_tokens;
    
    if (opts.maxInputTokens && cumulativeInputTokens >= opts.maxInputTokens) {
      // Graceful budget exhaustion
      opts.messages.push({
        role: "system",
        content: "You have reached the token budget. Summarize what you've accomplished, prepare final output, and indicate whether the task is complete or needs more work."
      });
      // Run one final synthesis turn
      // Then exit with special code 42
      return { status: "budget_exhausted", cumulativeInputTokens };
    }
  }
  
  if (toolCalls.length === 0) {
    return { status: "complete", cumulativeInputTokens };
  }
  
  if (opts.continueOnLimit && iter === max - 1) {
    // Hit 50-tool limit, but we have budget left
    opts.messages.push({
      role: "system",
      content: "You have reached the tool-call limit for this turn. Continue from where you left off to complete the task."
    });
    iter = -1; // reset counter, loop continues
    continue;
  }
}
```

### Exit codes (for the Durable Object to interpret)

| Exit Code | Meaning |
|---|---|
| 0 | Success — task completed |
| 42 | Budget exhausted — partial or no work |
| 1 | Error — crash, exception, or unhandled failure |

---

## Durable Object Logic (simplified)

```ts
export class RemoteJobDurableObject {
  async fetch(request: Request) {
    const url = new URL(request.url);
    
    if (url.pathname === '/start') {
      // 1. Create Artifact repo
      // 2. Create Sandbox
      // 3. Clone GitHub repo
      // 4. Install KimiFlare
      // 5. Run KimiFlare with --continue-on-limit --max-input-tokens
      // 6. Stream output to TUI via SSE
      
      const result = await this.runKimiFlare();
      
      // 7. Interpret result
      if (result.exitCode === 0) {
        await this.createPRorIssue('success');
      } else if (result.exitCode === 42) {
        await this.createPRorIssue('budget_exhausted');
      } else {
        await this.createPRorIssue('failure', result.errorLog);
      }
      
      // 8. Cleanup
      await this.sandbox.destroy();
      await this.deleteArtifact();
      
      return Response.json({ status: 'done', result: result.status });
    }
    
    if (url.pathname === '/stream') {
      // SSE stream of sandbox logs
    }
    
    if (url.pathname === '/cancel') {
      await this.sandbox.destroy();
      await this.deleteArtifact();
      return Response.json({ status: 'cancelled' });
    }
  }
  
  async alarm() {
    // 30-minute TTL fired
    // User never cancelled, process never finished
    // Create issue: "Task timed out"
    await this.sandbox.destroy();
    await this.deleteArtifact();
  }
}
```

---

## Summary of What We're Building

1. **Core loop change**: Add `--continue-on-limit` and `--max-input-tokens` to KimiFlare's agent loop.
2. **Worker template**: A Cloudflare Worker with Durable Objects that manages one job each.
3. **TUI integration**: `/remote` command with onboarding wizard (Wrangler check, Worker deploy, GitHub Device Flow, budget prompt).
4. **Streaming**: SSE from DO → TUI for real-time logs.
5. **Cleanup**: 30-minute TTL alarm, deterministic `destroy()` + `DELETE` artifact.
6. **Outcomes**: PR for code, issue for research, issue for failures — always something on GitHub.

---

*Plan finalized. Ready to implement when you say go.*
