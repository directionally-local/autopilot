# Plan: replace Cloudflare with OpenRouter as the model provider

> **Superseded (2026-10-20):** the "provider is not user-choosable" decision below was reversed in
> #801. OpenRouter stays the default and the only provider with billed-cost confirmation, subagents
> and Jev, but users can now choose another provider (OpenAI, DeepSeek, Moonshot, Z.ai, Ollama, …);
> see `src/providers/` and the README's *Providers* section. This document is kept as the record of
> the Cloudflare → OpenRouter migration.

Written by the ops agent, 2026-09-19, after reading the codebase and commit history.

**Status (2026-09-25): implemented on `feat/openrouter-provider`** — steps 2–5 landed together
(OpenRouter route + live catalog, onboarding, per-turn cost confirmation, Cloudflare removal,
README). Open question 1 stayed as-is: the npm package is still `kimiflare`. Decisions made while
implementing, from verifying OpenRouter's API: every request sends `provider.require_parameters:
true` (some endpoints serve a model without tool calling) and `session_id` (sticky routing keeps the
prompt cache warm); cost is confirmed from the stream's inline `usage.cost`, with
`GET /generation` as the fallback; memory embeddings use OpenRouter's `baai/bge-base-en-v1.5`, the
same model Workers AI served, so existing memory DBs stay valid. Commute workers now receive
`userOpenRouterKey` — the Commute server (separate repo) needs to use it.

**Scope decided by Sina, 2026-09-19: full replacement, not additive.** Cloudflare goes away as
the model provider; OpenRouter becomes the only one. The provider is not user-choosable — "the
provider war has already won" — but the *model* stays fully user-choosable, since that market
isn't settled. Earlier draft of this doc asked A-vs-B; this revision reflects the answer.

## What this repo is today

KimiFlare (currently at `github.com/directionally-local/autopilot`, `package.json` name still
`kimiflare`, previously `camouflage` — see `CAMOUFLAGE_MIGRATION.md` for that precedent) is a
terminal coding agent whose entire identity is built around Cloudflare:

- Onboarding is **Log in with Cloudflare** (OAuth) or a pasted API token; there is no path that
  skips Cloudflare entirely from the wizard.
- Model calls go through one of three routes, all Cloudflare (`src/models/registry.ts`
  `routeFor()`): direct **Workers AI** (`api.cloudflare.com/.../ai/run/{model}`), the
  **Cloudflare model catalog** for third-party models like Kimi K3
  (`.../ai/v1/chat/completions`), or the **AI Gateway Universal Endpoint** for everything else
  (Anthropic/OpenAI/Google), with Cloudflare's Unified Billing or BYOK.
- The model list is a **hardcoded array** (`SEED` in `registry.ts`): 4 Kimi models + 1 GLM model,
  all Workers-AI or CF-catalog. Nothing outside that list is chosen through the UI; an unknown
  model id falls back to generic, conservative capability guesses (`getModelOrInfer`).
- Cost tracking, the `/cost` command, and the "estimate → gateway-confirmed" UX all read from
  Cloudflare's AI Gateway logs API — this is Cloudflare-specific end to end.
- There's a `feedback-worker` and other Cloudflare Pages/Workers infra outside `src/`.

**One important head start:** a custom-endpoint escape hatch already exists
(`KIMIFLARE_BASE_URL` / `KIMIFLARE_API_KEY`, added Aug 20 by Sina + Claude, commits `93ef6ce`
through `ba9ff81`). It sends every request to `<baseUrl>/chat/completions` with a bearer token,
bypassing all Cloudflare paths. **This is not the right vehicle for the feature below** — its own
doc comment says it's for a *host application* embedding kimiflare and owning its own broker. Used
as the OpenRouter path it would give every OpenRouter model the same generic 128k/no-reasoning
defaults, no real model picker, no per-model pricing, and no cost tracking — a visibly worse
experience than what Cloudflare users get today. It's still useful as a reference for the request
plumbing, and for local/offline testing against a mock endpoint.

## Three separate things currently wear the Cloudflare name — only one is in scope

Reading further, "Cloudflare" in this codebase is actually three unrelated roles wearing one
name. Worth being precise about which one this plan touches, because conflating them would blow
the scope far past what was asked for:

1. **Model provider + billing** (`src/models/registry.ts` routing, Workers AI, the CF model
   catalog, AI Gateway Universal Endpoint, Unified Billing/BYOK, `src/cloud/{ai-gateway-api,
   billing}.ts`) — **this is what's being replaced.**
2. **Account/OAuth onboarding** ("Log in with Cloudflare", `src/cloud/{cloudflare-oauth,auth,
   availability,report}.ts`, ~1,350 lines) — tied to #1, goes away with it.
3. **Remote execution hosting substrate** (`src/remote/deploy-commute.ts`, the `/multi-agent`
   "Commute" feature) — deploys a per-user Cloudflare Worker + sandbox container so the agent can
   run remotely instead of on the user's machine. This is a *hosting* concern, not a *model
   provider* concern — it's arguably the existing embryo of the "lift it in the cloud" headless
   future, not something this plan touches. Also `feedback-worker/` (a small Worker collecting
   in-app feedback) — unrelated to model provider, left alone.

**This plan replaces #1 and #2. #3 and `feedback-worker` are explicitly out of scope** unless you
say otherwise — flag it if the headless-first direction means Commute's design should change too;
that reads as a separate, later conversation.

## Who holds the OpenRouter key — decided: bring-your-own

Sina, 2026-09-19: "I don't wanna use the managed service... people will bring their own OpenRouter
key. I don't wanna pay for other people's stuff." Settled — no hosted mode in this plan. Each user
supplies their own OpenRouter key; onboarding (§4) is a single key-paste step, nothing more.

For the record, since it took reading the code to find: `src/cloud/` already contains a complete,
currently-disabled hosted service ("KimiFlare Cloud" — device-code sign-in, a free-token grant,
Stripe billing, all against a backend at `api.kimiflare.com`, gated off by one flag,
`CLOUD_MODE_ENABLED = false`). Not used here, not being built on — noted only so it isn't
rediscovered and re-proposed later without this context. That backend also lives outside this
checkout, in a separate repo.

**Headless configuration.** Since users bring their own key and the direction is toward
non-interactive/headless use (a VM running this unattended, driven by email or an API rather than
someone sitting at the TUI), the key needs a path in *besides* the interactive onboarding wizard —
an env var (`OPENROUTER_API_KEY`, matching how `KIMIFLARE_BASE_URL`/`KIMIFLARE_API_KEY` already
work as env-var overrides for headless/host-app use) and a config-file field, both checked before
falling back to the interactive prompt. This is what makes "no human ever touches this onboarding
screen" possible for a cloud-hosted instance.

## Plan

### 1. First-class OpenRouter route (not the custom-endpoint escape hatch)

- Add `"openrouter"` to `ModelProvider` (`src/models/registry.ts`).
- New branch in `buildKimiRequestTarget()` (`src/agent/client.ts`), parallel to the existing
  `workers-ai` / `cf-catalog` / `gateway` branches: `POST
  https://openrouter.ai/api/v1/chat/completions`, `Authorization: Bearer <key>`, plus OpenRouter's
  recommended attribution headers (`HTTP-Referer`, `X-Title` — cheap, and it's how projects show
  up in OpenRouter's public rankings). OpenRouter's wire format is standard OpenAI-compatible
  chat-completions with SSE streaming, which is very likely close enough to the existing `gateway`
  branch's parsing that most of the stream-handling code is reusable as-is — need to confirm no
  Cloudflare-specific response wrapping is assumed there before assuming a clean reuse.
- `routeFor()` gets a fourth branch for `"openrouter"`; `isUnifiedEligible()` returns `false` for
  it (OpenRouter has no Cloudflare-style unified billing — it's the user's own OpenRouter key,
  full stop, which is actually a simpler mental model than the current three-tier CF logic).

### 2. Dynamic model catalog instead of a hardcoded list

`GET https://openrouter.ai/api/v1/models` is public (no auth needed to list) and returns every
model OpenRouter serves: id, `context_length`, `pricing.prompt` / `pricing.completion` (per
token), and `supported_parameters` (which reveals tool-calling support, whether `temperature` is
accepted, etc. — the same shape `ModelCapabilities` already wants).

- Fetch + cache this list (e.g. `~/.kimiflare/openrouter-models.json`, TTL-based refresh, fall
  back to the stale cache on a failed fetch so a network blip doesn't break the picker).
- Map each entry into `ModelEntry` and merge into `listModels()` — this is the literal mechanism
  for "let users pick any model available on OpenRouter": the picker becomes a live, complete list
  instead of a maintained-by-hand array, and it stays current as OpenRouter adds or removes
  models with zero code changes here.
- Free/very-cheap models (there are several genuinely free ones on OpenRouter) are worth
  surfacing distinctly in the picker — good default for people who don't want to think about cost
  yet.

### 3. Cost tracking

OpenRouter's `GET /api/v1/generation?id=<id>` returns authoritative per-generation cost after the
fact — the same shape of "fast local estimate, then a confirmed real number" the product already
does for Cloudflare's AI Gateway logs. Plan to reuse that UX pattern (`/cost`, the status-bar
estimate-then-confirm) rather than inventing a new one, so this feels like the same product rather
than a bolted-on second system.

### 4. Onboarding — replace, not fork

Today's wizard (`src/ui/onboarding.tsx`, ~1,040 lines) is entirely Cloudflare OAuth/token setup.
With Cloudflare gone as a concept, this becomes a single, much shorter flow: paste an OpenRouter
key (`sk-or-...`, a plain bearer token — no account-id/OAuth dance, no gateway provisioning step),
done — same TUI screen, checked against `OPENROUTER_API_KEY`/config first so the screen is simply
skipped when a headless instance already has a key configured (see above). OpenRouter does support
a PKCE-style OAuth key-provisioning flow for a no-copy-paste experience — fast-follow polish, not
blocking the first ship.

### 5. Testing — the part you specifically flagged

You're right that a terminal agent is easy to quietly break: a change to routing or model
selection can silently change what actually gets sent to the model, or what a tool call round-trip
looks like, without any test failing. Concretely:

- Unit tests for the new pure logic (URL building, model-list mapping, capability inference),
  following the existing pattern (`config.test.ts`, `permissions-evaluator.test.ts`,
  `models/registry.test.ts`), run via the existing `npm test` (Node's built-in test runner via
  `tsx --test`).
- A small **golden-transcript smoke test**: a couple of fixed prompts sent through the real
  OpenRouter path against a free/cheap model, asserting the response has the expected shape (tool
  call round-trips correctly, streamed text is non-empty, no silently-swallowed error) — this is
  the literal "does the prompt the harness sends match the output it gives back" check you asked
  for, scoped small enough to run in CI without real spend beyond a free-tier model.
- Before this branch is proposed for merge: a manual pass actually running the TUI against
  OpenRouter end-to-end (not just unit tests), the same way the `demos/*.tape` recordings imply
  this project already verifies real terminal behavior before release.

### Sequencing

Kept incremental despite the bigger overall scope — each step its own branch and PR, so review
stays small per step rather than one large diff landing at once:

1. This plan doc (this PR) — your review.
2. OpenRouter registry + routing (§1, §2), **added alongside** the existing Cloudflare paths —
   the new route exists and is fully testable (headless via the SDK/RPC mode that already exists)
   before anything Cloudflare-shaped is removed. Lower risk: if something's wrong, main still
   works exactly as today throughout this step.
3. Onboarding rewrite (§4) — the OpenRouter-only flow ships, gated so it's easy to flip which
   path is default while both still exist in the code.
4. Cost tracking (§3) moves to OpenRouter's generation-cost API.
5. **Removal pass**: delete `src/cloud/{cloudflare-oauth,ai-gateway-api,billing,auth,
   availability,report}.ts` and their tests, the Workers-AI/cf-catalog/gateway branches in
   `buildKimiRequestTarget`, Unified Billing/BYOK-alias logic, `cf-aig-*` headers, and rewrite the
   README (hero copy, badges, logo, Quick Start) off the Cloudflare pitch. This is the step that
   actually breaks existing Cloudflare-configured installs, so it's last and deliberate, not a
   side effect of an earlier step.
6. Tests throughout (§5), not bolted on at the end — each of 2–5 ships with its own tests.

## Open questions for you

1. Keep the `kimiflare` name for the npm package for now, or is the rename to `autopilot`
   happening in parallel with this work? (Affects whether step 5 also touches `package.json`'s
   `name`/`bin`/repo URLs, or that's a separate rename PR mirroring `CAMOUFLAGE_MIGRATION.md`'s
   playbook.)
2. `/multi-agent` Commute (per-user Cloudflare Worker remote execution) — Sina is sending over
   the `kimiflare-commute` repo separately to evaluate for the headless-hosted direction below;
   staying out of scope for *this* plan either way, revisit once that repo's in hand.

## Where this is headed (context, not scope for this plan)

Sina described the eventual target state: after these provider PRs land, a persistent cloud
instance of this harness (a GCP VM to start), fed prompts by email — send mail to a dedicated
address, it becomes a prompt into the running instance, the reply comes back by mail. Whether that
instance runs the TUI or a headless mode is left to whoever builds it. Noted here because it's
exactly the shape of the mail-poller/send-mail pattern already running the ops channel this plan
itself was written through — that's a working, proven reference for the "email in, agent output,
email out" half of it when that work starts. A further-out idea layered on top: the harness
eventually being able to build and deploy artifacts itself (e.g. a generated webpage shipped to
the user's own Cloudflare Workers/Pages) — flagged by Sina as "later," including the open problem
of handing over Cloudflare access safely through an email-only channel (the same class of problem
this plan's deploy-key approach solves for GitHub push access). Not part of this PR; recorded so
the provider work doesn't quietly foreclose it.
