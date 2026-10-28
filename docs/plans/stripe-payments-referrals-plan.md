# KimiFlare Payments, Subscriptions & Referrals — Deep Plan

> Status: planning / decision-ready  
> Scope: Stripe billing, free-trial tokens, monthly plans, credit top-ups, referrals  
> Out of scope for this doc: actual implementation (waiting for go/no-go on option set)  

---

## 1. What we are trying to solve

The managed **KimiFlare Cloud** (the hosted worker + D1-backed service you run) has been operating on a manual grant system. The last free-access cohort shows:

- 58 registered users, 43 active
- ~1.21B prompt+completion tokens consumed in ~7 days
- ~$495 in model cost
- Wildly skewed usage: top 2 users burned ~$205 each in a week; median users burned <$2

We need to replace the manual grant system with:

1. **Free trial** — a starting bucket of tokens for every new signup.
2. **Monthly subscription** — recurring fee that includes a token allowance.
3. **Credit top-ups** — pay-as-you-go when the monthly allowance is exhausted.
4. **Referrals** — invitees earn the inviter bonus tokens when they sign up and pay/subscribe.
5. **Stripe integration** — the canonical billing provider.

This doc is a decision aid. It contains market research, cost analysis, three pricing option packs, a technical architecture sketch, and a phased implementation plan. **Do not start coding until an option is chosen.**

---

## 2. Market research — what competitors charge

We looked at terminal/cloud AI coding agents that bundle model access. The market has converged on **subscription + usage caps + credit top-ups**.

### 2.1 OpenCode Go (closest model-bundling competitor)

- **Price:** $10/mo (first month $5)
- **Model mix:** 14 open-weight models (DeepSeek V4 Pro/Flash, Qwen 3.7, MiniMax M3, Kimi K2.5/2.6, GLM 5.1, MiMo, etc.)
- **Usage caps (dollar value, not tokens):**
  - $12 per 5-hour rolling window
  - $30 per week
  - $60 per month
- **Overage:** Falls back to a prepaid "Zen balance" (zero markup on provider cost)
- **Request examples per month:**
  - DeepSeek V4 Flash: ~158k requests
  - Kimi K2.5: ~9,250 requests
  - GLM 5.1: ~4,300 requests
- **Positioning:** Cheapest bundled access; flat fee with caps; credits for overage.

### 2.2 Claude Code (Anthropic)

- **Pro:** $20/mo
  - Claude Code CLI + web/desktop
  - ~45 messages per 5-hour rolling window
  - v2 model family
- **Max 5x:** $100/mo — 5× Pro quota
- **Max 20x:** $200/mo — 20× Pro quota
- **API (BYOK):** ~$3/M input, $15/M output for Claude models
- **Positioning:** Premium, model-locked, quota-based.

### 2.3 OpenAI Codex CLI

- **Free:** $0
- **Go:** $8/mo
- **Plus:** $20/mo
- **Pro 5x:** $100/mo
- **Pro 20x:** $200/mo
- **Business:** pay-as-you-go per seat
- **API:** gpt-5.1-mini ~$0.75/M input, $14/M output
- **Positioning:** Tied to ChatGPT plans; heavy users pushed to $100–$200 tiers.

### 2.4 Cursor

- **Free:** 50 fast requests/mo
- **Pro:** $20/mo — ~500 fast requests/mo
- **Pro+:** $60/mo
- **Ultra:** $200/mo
- **Business:** $40/user/mo
- **Positioning:** Request-based, not token-based; IDE-first.

### 2.5 Windsurf

- **Free:** 25 credits/mo
- **Pro:** $20/mo — ~50–70 prompts/day (~1,500–2,000/mo)
- **Max:** $200/mo
- **Teams:** $40/user/mo
- **Enterprise:** $60/user/mo
- **Add-on credits:** $40 per 1,000 credits
- **Positioning:** Credit-based; tab completion/inline edits unlimited; agent prompts consume credits.

### 2.6 GitHub Copilot (post-June 2026)

- **Pro:** $10/mo — includes $10 of AI credits
- **Pro+:** $39/mo — includes $39 of AI credits
- **Business:** $19/user/mo
- **Overage:** metered token billing beyond included credits
- **Positioning:** Cheap entry point, but heavy users pay overage.

### 2.7 Key takeaways for KimiFlare

1. **$10–$20/mo is the psychological entry point** for individual AI coding tools.
2. **Power-user tiers cluster at $100–$200/mo.**
3. **Usage caps are the norm** — unlimited all-you-can-eat is unsustainable.
4. **Credit top-ups are standard** for overage (OpenCode Zen, Windsurf add-ons, Copilot credits).
5. **Token-based billing is rare at the consumer layer**; most products abstract to "requests", "credits", or dollar-value caps. Token-based is more honest but harder to market.
6. **Kimi K2.7-code is cheap** relative to Claude/OpenAI frontier models, so we can undercut them on raw token cost while still covering our COGS.

---

## 3. KimiFlare cost basis

### 3.1 Model pricing (from `src/models/registry.ts`)

| Model | Input | Cached input | Output |
|-------|-------|--------------|--------|
| `@cf/moonshotai/kimi-k2.7-code` | $0.95/M | $0.19/M | $4.00/M |
| `@cf/moonshotai/kimi-k2.6` | $0.95/M | $0.16/M | $4.00/M |
| `@cf/moonshotai/kimi-k2.5` | $0.55/M | $0.11/M | $2.19/M |
| `@cf/zai-org/glm-5.2` | $1.40/M | $0.26/M | $4.40/M |

Default model is **Kimi K2.7-code**.

### 3.2 Cohort cost analysis (usage report)

| Metric | Value |
|--------|-------|
| Active users | 43 |
| Days of data | ~7 |
| Total requests | 26,591 |
| Prompt tokens | 1,203,335,912 |
| Completion tokens | 7,465,631 |
| Cached tokens | 857,962,816 |
| **Tokens (p+c)** | **1,210,801,543** |
| **Estimated cost** | **$495.24** |

**Effective blended cost:**

```
$495.24 / 1,210.8M tokens = ~$0.41 per million p+c tokens
```

This is far below nominal pricing because **71% of prompt tokens were cached** at the cheap cached rate.

**Theoretical uncached cost (no caching):**

```
(1,203M - 858M) uncached input × $0.95/M  = $327
858M cached input × $0.19/M                = $163
7.5M output × $4.00/M                      = $30
-------------------------------------------
Total                                      = ~$520
```

So caching saved only ~$25 in this cohort. The bigger driver of low cost is that **Kimi K2.7-code is already cheap**.

### 3.3 Per-user distribution matters

| Percentile | 7-day cost | Annualized (×52) |
|------------|-----------:|-----------------:|
| Top 1 user | $207.69 | ~$10,800 |
| Top 2 users | $204.27 | ~$10,600 |
| 90th | $19.43 | ~$1,010 |
| 75th | ~$5.50 | ~$286 |
| Median | ~$1.20 | ~$62 |
| 25th | ~$0.20 | ~$10 |

**Implication:** A flat monthly plan will be heavily subsidized by light users and eaten by power users. We need:

- A generous but finite monthly allowance.
- Overage at a fair mark-up.
- Optionally a higher-tier plan for power users.

---

## 4. Pricing options

All options assume:

- **Free trial:** granted on signup, no card required.
- **Monthly plan:** auto-renews, includes allowance.
- **Credit top-ups:** one-time purchases when allowance exhausted.
- **Referral bonus:** inviter gets tokens when invitee signs up + subscribes (or consumes trial).

### 4.1 Option A — "Token Honest" (recommended for transparency)

| Plan | Price | Includes | Overage |
|------|-------|----------|---------|
| Free trial | $0 | 10M tokens | — |
| Starter | $12/mo | 50M tokens/mo | $2.50 per 10M tokens |
| Pro | $25/mo | 150M tokens/mo | $2.00 per 10M tokens |
| Power | $99/mo | 750M tokens/mo | $1.50 per 10M tokens |

- **Referral:** inviter gets 10M tokens; invitee gets 5M bonus trial tokens.
- **Why:** Directly maps to our COGS. 50M tokens at blended $0.41/M = ~$20 cost, so Starter at $12 is slightly lossy for uncached users but profitable for typical cached users. Pro and Power have healthy margins.
- **Positioning vs competitors:** Cheaper per token than Claude/Codex; comparable to OpenCode Go but more transparent.

### 4.2 Option B — "OpenCode-style caps" (recommended for simplicity)

| Plan | Price | Includes | Overage |
|------|-------|----------|---------|
| Free trial | $0 | $5 of usage (~12M tokens) | — |
| Starter | $10/mo | $20 of usage (~50M tokens) | Prepaid credits at cost + 20% |
| Pro | $25/mo | $60 of usage (~150M tokens) | Prepaid credits at cost + 10% |
| Power | $100/mo | $300 of usage (~750M tokens) | Prepaid credits at cost |

- **Referral:** inviter gets $5 credit; invitee gets $3 credit.
- **Why:** Dollar-value caps are easier to explain than raw tokens. Matches OpenCode Go's mental model. The $10 entry point is attractive.
- **Risk:** Users may not understand why one session costs $0.50 and another costs $2.00 (model/caching variance).

### 4.3 Option C — "Request + Token hybrid" (Cursor/Windsurf style)

| Plan | Price | Includes | Overage |
|------|-------|----------|---------|
| Free trial | $0 | 20 "agent turns" or 10M tokens, whichever comes first | — |
| Starter | $15/mo | 100 agent turns + 25M tokens | $5 per 25M tokens or $0.10/turn |
| Pro | $30/mo | 300 agent turns + 100M tokens | $4 per 25M tokens or $0.08/turn |
| Power | $120/mo | Unlimited turns + 500M tokens | $3 per 25M tokens |

- **Referral:** inviter gets 25 turns; invitee gets 10 turns.
- **Why:** Aligns user cost with perceived value ("I asked the agent 50 times"). Reduces sticker shock from huge token counts.
- **Risk:** More complex to implement and explain. KimiFlare is a terminal harness, not an IDE, so "turns" can be ambiguous (tool loops, multi-turn sessions).

### 4.4 Pricing decision matrix

| Criterion | A Token Honest | B OpenCode-style | C Hybrid |
|-----------|:------------:|:----------------:|:--------:|
| Easy to explain | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐ |
| Maps to COGS | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| Competitive entry price | ⭐⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| Sustainable margins | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |
| Implementation complexity | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐ |
| Fits KimiFlare terminal UX | ⭐⭐⭐⭐ | ⭐⭐⭐⭐ | ⭐⭐⭐ |

**Recommendation:** Start with **Option B (OpenCode-style caps)** for marketability, but expose token-equivalent numbers in the UI so power users understand the value. Keep the internal ledger in **tokens** (Option A's unit) because that is what Cloudflare bills us in.

---

## 5. Free trial sizing

From the cohort:

- Median 7-day usage: ~1.2M tokens
- 75th percentile: ~5.5M tokens
- 90th percentile: ~19M tokens

A **10M-token free trial** lets ~70% of users explore for a week without paying. A **$5 credit trial** (~12M tokens) is the dollar-value equivalent.

**Suggested:**

- Free trial: **$5 credit / ~10M tokens**
- Expires: never, but account must add a card to continue after depletion
- Card not required to start

---

## 6. Referral program design

### 6.1 Mechanics

1. Every user gets a unique referral code (e.g., `https://kimiflare.cloud/r/abc123`).
2. Invitee signs up via the link.
3. When the invitee **subscribes to any paid plan**, the inviter receives a bonus.
4. Optionally: inviter also gets a smaller bonus when invitee consumes their free trial (lower-friction reward).

### 6.2 Reward sizes

| Event | Inviter reward | Invitee reward |
|-------|---------------:|---------------:|
| Invitee signs up | — | +5M trial tokens |
| Invitee subscribes | +10M tokens (or $5 credit) | +5M tokens |

### 6.3 Guardrails

- One reward per unique invitee (prevent self-referral loops).
- Referral codes tied to Stripe Customer metadata or D1 `referrer_id`.
- Abuse detection: same IP, same GitHub email, same device fingerprint → flag for review.

---

## 7. Technical architecture

### 7.1 Assumptions about the existing cloud stack

The open-source repo (`directionally-local/autopilot`) contains:

- CLI/TUI (`src/index.tsx`, `src/app.tsx`)
- Agent loop and tool executor
- Usage tracker (`src/usage-tracker.ts`)
- Remote agent container (`remote/agent/`)
- Remote worker **scaffolding only** (`remote/worker/` is empty except `node_modules`)

The managed KimiFlare Cloud (with D1 user DB and usage logs) appears to live **outside this repo**. The plan below assumes we will build or extend that cloud backend.

### 7.2 New cloud components

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   KimiFlare CLI │────▶│  Cloudflare      │────▶│   Stripe        │
│   (TUI / print) │◀────│  Worker (Hono)   │◀────│   (Checkout,    │
│                 │     │  + D1 + Durable  │     │   Portal,       │
│                 │     │    Objects       │     │   Webhooks)     │
└─────────────────┘     └──────────────────┘     └─────────────────┘
         │                       │
         ▼                       ▼
┌─────────────────┐     ┌──────────────────┐
│  Usage tracker  │     │  AI Gateway      │
│  (local + cloud)│     │  (model cost)    │
└─────────────────┘     └──────────────────┘
```

### 7.3 D1 schema (proposed)

```sql
-- Users and auth
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id TEXT UNIQUE,
  email TEXT UNIQUE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT,
  plan TEXT DEFAULT 'trial', -- trial, starter, pro, power
  trial_tokens_granted INTEGER DEFAULT 0,
  trial_tokens_used INTEGER DEFAULT 0,
  monthly_tokens_allowance INTEGER DEFAULT 0,
  monthly_tokens_used INTEGER DEFAULT 0,
  credit_balance_tokens INTEGER DEFAULT 0, -- purchased top-ups
  referrer_id TEXT REFERENCES users(id),
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  current_period_start DATETIME,
  current_period_end DATETIME
);

-- Usage events (append-only)
CREATE TABLE usage_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  session_id TEXT,
  request_id TEXT,
  prompt_tokens INTEGER,
  completion_tokens INTEGER,
  cached_tokens INTEGER,
  model TEXT,
  estimated_cost_usd REAL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Purchases / credit top-ups
CREATE TABLE credit_purchases (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  stripe_payment_intent_id TEXT,
  tokens_purchased INTEGER NOT NULL,
  usd_paid REAL NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Referrals
CREATE TABLE referrals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  referrer_id TEXT NOT NULL,
  invitee_id TEXT UNIQUE NOT NULL,
  status TEXT DEFAULT 'signed_up', -- signed_up, converted
  reward_tokens INTEGER DEFAULT 0,
  rewarded_at DATETIME
);

-- Stripe webhook log (idempotency)
CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  processed_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
```

### 7.4 Stripe products (proposed)

| Stripe Product | Price | Metadata |
|----------------|-------|----------|
| `starter_monthly` | $10/mo | `plan=starter`, `allowance_tokens=50000000` |
| `pro_monthly` | $25/mo | `plan=pro`, `allowance_tokens=150000000` |
| `power_monthly` | $99/mo | `plan=power`, `allowance_tokens=750000000` |
| `credit_topup_10m` | $2.50 one-time | `tokens=10000000` |
| `credit_topup_50m` | $10.00 one-time | `tokens=50000000` |
| `credit_topup_100m` | $18.00 one-time | `tokens=100000000` |

Use Stripe Checkout for initial subscription and one-time credit purchases. Use the Stripe Customer Portal for plan changes/cancellations.

### 7.5 Request gating logic (worker)

Before proxying a request to AI Gateway:

```ts
function canSpendTokens(user: User, estimatedCostTokens: number): boolean {
  const available =
    (user.monthly_tokens_allowance - user.monthly_tokens_used) +
    user.credit_balance_tokens +
    (user.trial_tokens_granted - user.trial_tokens_used);
  return available >= estimatedCostTokens;
}
```

Deduction order:

1. Trial tokens (if any)
2. Monthly allowance
3. Credit balance

After the request completes, reconcile with actual usage from AI Gateway logs.

### 7.6 CLI/TUI changes

New commands:

```bash
kimiflare auth login          # existing GitHub device flow
kimiflare billing status      # show plan, allowance, usage, credits
kimiflare billing subscribe   # open Stripe Checkout
kimiflare billing credits     # buy credit top-up
kimiflare billing portal      # open Stripe Customer Portal
kimiflare referral            # show referral link and rewards
```

TUI additions:

- Status bar showing remaining tokens/credits.
- Soft warning at 80% of monthly allowance.
- Hard block when balance exhausted with a `/billing subscribe` shortcut.
- Referral link in welcome/onboarding.

### 7.7 Local usage tracker integration

`src/usage-tracker.ts` already records per-session token usage. For cloud users, it should:

1. Report usage to the worker after each turn (or batch every N seconds).
2. Receive back the remaining balance.
3. Surface balance in the TUI via `usageEvents` emitter.

---

## 8. Merge-conflict context

There is a `feat/billing-notice` branch that is **highly divergent** from `main` (it deletes large parts of the codebase, including memory, LSP, MCP, logging, etc.). It only adds a billing notice to the README and welcome screen.

**Decision needed:** Do not merge `feat/billing-notice` as-is. If we want the billing-notice copy, we should cherry-pick just those text changes onto a fresh branch from `main`.

Recommended branch strategy:

```
main
  └── feat/payments-stripe
        ├── cherry-pick billing notice copy (optional)
        ├── cloud: D1 schema + Stripe webhooks
        ├── worker: token gating + subscription sync
        ├── cli: billing commands + TUI status
        └── remote/agent: report usage to worker
```

---

## 9. Phased implementation plan

### Phase 0 — Decisions (this doc)

- [ ] Choose pricing option (A/B/C) and exact numbers.
- [ ] Confirm cloud backend repo/location.
- [ ] Confirm Stripe account and tax handling.

### Phase 1 — Cloud backend foundation

- [ ] Create `remote/worker/` Hono app with D1 bindings.
- [ ] Implement D1 schema.
- [ ] Add `/auth/github` device-flow endpoint (or reuse existing).
- [ ] Add Stripe webhook handler (`checkout.session.completed`, `invoice.paid`, `customer.subscription.updated`, etc.).
- [ ] Add `/billing/status`, `/billing/checkout`, `/billing/portal` endpoints.

### Phase 2 — Token gating

- [ ] Middleware to deduct tokens before proxying to AI Gateway.
- [ ] Post-request reconciliation with actual usage.
- [ ] Return `X-KimiFlare-Balance` header to CLI.

### Phase 3 — CLI/TUI

- [ ] Add `billing` subcommand.
- [ ] Show balance in TUI status bar.
- [ ] Add paywall screen when balance exhausted.
- [ ] Add referral command and onboarding nudge.

### Phase 4 — Referrals

- [ ] Referral link generation.
- [ ] Reward attribution on signup + subscription.
- [ ] Abuse guardrails.

### Phase 5 — Launch

- [ ] Stripe test mode end-to-end validation.
- [ ] Pricing page on docs site.
- [ ] Gradual rollout (invite-only or limited free trial).

---

## 10. Risks and mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| Power users cost more than they pay | High | Strict monthly caps + overage credits; offer $99 Power plan |
| Users confused by token vs credit | Medium | Show dollar-equivalent and token count in UI |
| Stripe webhook failures desync balance | High | Idempotency table; reconcile via AI Gateway logs nightly |
| Self-referral abuse | Medium | One reward per invitee; IP/email/device fingerprint checks |
| Free trial farming | Medium | Require GitHub auth; limit one trial per verified account |
| Tax/VAT complexity | Medium | Use Stripe Tax or limit to US/major markets initially |
| Cloud backend repo is outside this one | High | Confirm repo location; plan assumes separate worker project |

---

## 11. Open questions for you

1. **Which pricing option?** A (token-honest), B (OpenCode-style caps), or C (hybrid)?
2. **Where is the KimiFlare Cloud backend repo?** The open-source repo's `remote/worker/` is empty.
3. **Stripe Tax / VAT:** Do you want Stripe to handle tax, or launch in a limited set of countries?
4. **Free trial:** $5 credit / 10M tokens, or a different size?
5. **Referral reward:** Tokens only, or also a small credit?
6. **Billing cadence:** Monthly only, or also annual with a discount?
7. **BYOK path:** Should self-hosted / BYOK users remain completely free, or also get an optional paid tier?

---

## 12. Bottom-line recommendation

Launch with **Option B (OpenCode-style caps)** using these numbers:

| Plan | Monthly price | Included usage | Overage |
|------|--------------:|---------------:|---------|
| Free trial | $0 | $5 (~10M tokens) | — |
| Starter | $10 | $20 (~50M tokens) | Credits at cost + 20% |
| Pro | $25 | $60 (~150M tokens) | Credits at cost + 10% |
| Power | $99 | $300 (~750M tokens) | Credits at cost |
| Credit packs | $2.50 / $10 / $18 | 10M / 50M / 100M tokens | — |

This undercuts Claude Code Pro ($20 for ~45 msgs/5h) and OpenAI Codex Plus ($20) while being competitive with OpenCode Go ($10). It is sustainable because:

- The $10 Starter plan covers ~$20 of model usage only if the user is typical (cached, K2.7-code). Heavy uncached users pay overage.
- The $99 Power plan has strong margin even for the top-2 users from the cohort.
- Credit top-ups keep power users paying their own way.

Next step: confirm the option and the cloud backend repo, then begin Phase 1.
