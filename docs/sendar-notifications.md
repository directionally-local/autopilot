# Experimental Sendar run notifications

Prepared by Sendar's integration agent following the maintainer invitation at
https://github.com/directionally-local/autopilot/issues/671#issuecomment-6293271169.
This patch is not upstream-approved, released, or a marketplace listing.

## Explicit opt-in

Keep the existing Resend default. To select Sendar, configure these variables in
the operator's own secret manager (do not commit keys):

```sh
export AUTOPILOT_NOTIFY_EMAIL_PROVIDER=sendar
export SENDAR_API_KEY='<operator supplies key>'
export AUTOPILOT_NOTIFY_EMAIL_FROM='Autopilot <bot@your-verified-domain.example>'
export AUTOPILOT_NOTIFY_EMAIL_TO='operator@example.net'
```

Alternatively set `runNotifications.email.provider` to `sendar`, with `from`,
`to`, and optional `events` in existing config. The key remains environment-only.
No recipient or sender is inferred from account data. Without an explicit
recipient, sender and Sendar key the configuration is disabled. A verified Sendar
sending domain, adequate existing account allowance, and authorization to notify
the named recipients are prerequisites. This review used synthetic values only.

## Contract and limits

POST https://sendar.app/api/emails with bearer authentication and the unchanged
notification id as `Idempotency-Key`. Payload: `from`, `to`, `subject`, `text`,
`trackOpens: false`, `trackClicks: false`. The existing notification formatter
supplies status metadata, not transcripts. Success requires `status: sent` and a
nonempty `providerEmailId`; the numeric Sendar log `id` is not a provider id.
Provider acceptance does not establish inbox delivery.

Network errors, malformed success bodies, HTTP 409 and 5xx remain uncertain;
the existing bounded dispatcher may retry only with the original key. Sendar
reserves keys before delivery and replays recorded responses, including failures.
Definitive 4xx (including 429) are terminal for that notification, not retryable
with a new key. Inspect Sendar history and configuration before a deliberate new
attempt. The existing dispatcher's 24-hour cutoff is retained; this is not a claim
about Sendar's retention window. Raw error bodies are not logged.

Inbound email decisions are **not supported** by this adapter: the verified
Sendar send schema does not expose an arbitrary reply-to field. If a message has
`replyTo`, this transport refuses it before any request. Do not set
`AUTOPILOT_DECISIONS_REPLY_TO` for Sendar; use existing Resend support if decisions
are required. This does not add IMAP, transcript export, or change run state.

Contract sources re-audited 2026-11-06 in the Sendar source checkout:
`artifacts/api-server/src/routes/emails.ts`,
`artifacts/api-server/src/middlewares/agent-send.ts`, and
`lib/api-zod/src/generated/api.ts` (`SendEmailBody`, `SendEmailResponse`).

## Review checks (no live sends)

```sh
npm ci --ignore-scripts
npm run typecheck
npm run test:file -- src/runs/notifications.test.ts src/runs/store.test.ts
npm test
npm run build
```

The tests inject fetch and fake transport responses; no credentials, customer
records or mail delivery are involved. Upstream review and actual live provider
acceptance remain separate, pending milestones.

Revalidated against upstream commit `29c30720e995eed619f04883c73fd8c87ddb579e` (Autopilot 3.13.0), experimental review artifact `0.1.0-preview.3`; root package version unchanged. Current upstream uses built-in node:sqlite. Node v26.12.1 darwin arm64: focused notifications/store tests 31/31 PASS, typecheck PASS, build PASS. Full suite: 2,908 tests, 2,882 pass, 21 fail, 5 skipped. The same 21 failing test locations reproduce in unmodified upstream's corresponding eight test files (70 tests: 49 pass, 21 fail) in the same environment. Failures concern job process state, permission/recovery checks, executor scheduling, herdr and PR-footer subprocesses. Full-suite PASS is not claimed. No model, OAuth, live Sendar provider acceptance or email delivery was tested.
