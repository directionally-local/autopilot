# Aster API v1 and VM runbook

Aster is a native iOS client. Autopilot on the VM owns model credentials, prompts, tool execution, workspace roots, conversation history, approvals, and run lifecycle. The Aster API is a separate Bearer-authenticated control plane under `/api/v1`; it does not use the legacy `/prompt` or `/runs` contract.

## Security boundary

- Keep `autopilot serve` bound to `127.0.0.1:4096`. Do not open this port in Hetzner firewall/UFW and do not use Tailscale Funnel or a public reverse proxy.
- Development access uses an SSH local forward. Physical iPhone access requires a private tailnet (recommended: Tailscale Serve, not Funnel) plus an expiring, workspace-scoped Aster credential stored in the iOS Keychain. The current VM has no Tailscale installation/enrollment; Aster cannot reach it from a phone until the operator enrolls the VM and phone in the same tailnet.
- `/api/v1/*` requires `Authorization: Bearer aster_…`. Credentials are workspace-scoped, expire (default 30 days), are stored only as SHA-256 hashes, and can be revoked. Legacy routes keep their separate Basic auth.
- The API exposes only `read`, `write`, and `edit`; no shell, external job, browser, web, GitHub, or artifact-expansion tools. Reads/writes/edits resolve inside the conversation worktree, reject traversal/symlinks out of root, and block credential/VCS paths. `write` and `edit` require a per-action human approval.
- Provider credentials remain in the VM service environment/config. They are never sent to Aster or included in API responses/events. Provider-like secrets in turn text or proposed write arguments are rejected; assistant deltas are redacted defensively.
- Each conversation runs inside its own Hotcell microVM with no host network and no host filesystem. Model access is brokered by Hotcell's credential gateway with a per-conversation, per-model, spend-capped, TTL-bound egress token that is revoked on destroy. Prompts and file contents never appear in Hotcell exec commands or logs; control traffic uses fixed commands with request bodies passed through `0600` files inside the cell.

## Configure the Hotcell provider

Aster conversation cells require a Hotcell deployment reachable from the service. Set these on `autopilot.service` (conversation creation returns `503 hotcell_unavailable` without them):

| Variable | Purpose |
| --- | --- |
| `AUTOPILOT_HOTCELL_ENDPOINT` | Hotcell control API; HTTPS required unless loopback |
| `AUTOPILOT_HOTCELL_API_KEY` | Hotcell API key (kept server-side only) |
| `AUTOPILOT_HOTCELL_DRIVER` | `firecracker`, `applevz`, or `container` (Docker; for hosts without KVM, weaker kernel isolation) |
| `AUTOPILOT_HOTCELL_NETWORKED` | `true` gives cells general outbound internet (npm, git, pip) besides the LLM gateway |
| `AUTOPILOT_HOTCELL_ANY_MODEL` | `true` lets a cell's gateway token call any model, so conversations can switch models |
| `AUTOPILOT_HOTCELL_SLEEP_AFTER_MS` | Idle time before Hotcell pauses a cell (default 0 = never). On the container driver a pause is a cold stop that frees CPU and memory; files persist and the next request wakes the cell |
| `AUTOPILOT_HOTCELL_IMAGE` | Cell image; bake the Autopilot runtime into it to skip the per-cell `npm install` |
| `AUTOPILOT_HOTCELL_MEMORY_MB` | Per-cell memory (default 4096) |
| `AUTOPILOT_HOTCELL_CPUS` | Per-cell vCPUs (default 2) |
| `AUTOPILOT_HOTCELL_PIDS` | Per-cell PID limit (default 256) |
| `AUTOPILOT_HOTCELL_SPEND_CAP_USD` | Per-conversation egress spend cap (default 10) |
| `AUTOPILOT_HOTCELL_TOKEN_TTL_MS` | Egress token TTL (default 24h) |

The provider fails closed: it refuses to create a cell if the Hotcell API auth is disabled, the configured driver is unavailable, or the daemon has no egress route for the configured LLM provider (`hotcell_egress_unavailable`). Creation is label-adoptive: cells carry a stable `autopilot.conversation_id` label, and a retry after an uncertain create adopts the labeled cell instead of provisioning a duplicate.

### Which LLM provider the cells use

Cells reach their LLM through the Hotcell egress route named after the provider in `aster.json` (below); the route is named exactly like Autopilot's provider preset id (`openrouter`, `openai`, `deepseek`, `moonshot`, `anthropic`, `gemini`, `minimax`, `xai`, `mistral`, `groq`, `cerebras`, `together`, `fireworks`, `deepinfra`, `vercel`, `kimi-code`, `zai`, `zai-coding`, `requesty`, and the keyless `ollama` and `lmstudio`). The daemon mints a per-cell egress token scoped to the conversation's model, and the server configures the cell's Autopilot with:

| Cell env | Value |
| --- | --- |
| `AUTOPILOT_PROVIDER` | the provider id |
| `AUTOPILOT_BASE_URL` | the route's gateway URL plus the preset's API path (`…/openai/v1`, `…/deepseek`, `…/ollama/v1`) |
| the preset's key env (`DEEPSEEK_API_KEY`, `OPENAI_API_KEY`, …) | the cell's egress token; absent for keyless routes with no token |

OpenRouter keeps the daemon's own `OPENROUTER_BASE_URL`/`OPENROUTER_API_KEY` injection. The real provider key only ever lives on the Hotcell daemon.

## Local macOS bootstrap

On a Mac, Autopilot can own the Aster workspace config and issue a short-lived, workspace-scoped credential without a system-wide `/etc` config. The config contains repository roots and model policy only; the database stores only the credential hash. The Mac app stores the one-time bearer token in Keychain.

```sh
autopilot aster setup --workspace "$HOME/src/my-project" --json
# or, for cells that talk to another provider (optionally at a non-default URL):
autopilot aster setup --workspace "$HOME/src/my-project" --provider deepseek
autopilot aster setup --workspace "$HOME/src/my-project" --provider ollama --base-url http://gpu-box:11434/v1
# Use the returned workspace ID:
autopilot aster token create --name "Aster for Mac" --workspace my-project --expires-in-days 30 --json
autopilot serve --hostname 127.0.0.1 --port 4096
```

`aster setup` writes `~/.config/autopilot/aster.json` with mode `0600` in a mode `0700` directory. It validates that each workspace is an existing Git repository root. Repeating setup for an already-configured root returns its existing workspace ID; it refuses to replace a config or silently widen its workspace list. Set `AUTOPILOT_ASTER_CONFIG` to select another config path. `aster token create --json` emits the token once on stdout for a trusted local caller; never log or persist that output except in Keychain. The default database is `~/.local/state/autopilot/aster.db` and can be overridden with `AUTOPILOT_ASTER_DB`.

The local Mac app launches Hotcell and Autopilot as loopback-only child processes and supplies the daemon API key to Autopilot through its environment. Provider credentials remain in Autopilot's existing provider configuration and Hotcell's host Keychain keystore; they are not copied into the Aster config or token database.

## Configure server-owned workspaces and models

Create `/etc/autopilot/aster.json` (do not put credentials in it):

```json
{
  "provider": { "id": "deepseek", "baseUrl": "https://api.deepseek.com", "apiKeyEnv": "DEEPSEEK_API_KEY" },
  "models": "catalog",
  "approvalTtlMs": 300000,
  "workspaces": [
    {
      "id": "default",
      "displayName": "Default workspace",
      "rootPath": "/var/lib/autopilot/workspaces/default"
    }
  ]
}
```

- `provider` (optional) names the LLM provider every cell uses, by Autopilot provider preset id. Absent, it is OpenRouter, so every aster.json written before the block existed keeps working. `baseUrl` defaults to the preset's API base URL (required for `custom`); `apiKeyEnv` defaults to the preset's key variable and names the env var on the *server* that holds its own key for the catalog call below, and the variable the cell's egress token is handed in.
- `models` is either a fixed list of model ids (works for any provider) or `"catalog"` (the older spelling `"openrouter"` still means the same): every selectable model of the provider's live list. For OpenRouter that is its public catalog, tool-capable models only (cached on the server, refreshed every 6 hours); for every other provider it is `GET {baseUrl}/models` in the OpenAI-compatible shape, authenticated with the server's `apiKeyEnv` key (or unauthenticated for keyless providers), cached for five minutes, falling back to the preset's default model when the call fails.

`id` is the only workspace selector accepted from clients. The API never accepts a client-supplied cwd or filesystem path. Roots must be existing, non-overlapping directories; each workspace root must be a Git repository so its tracked tree can be seeded into the conversation cell at creation.

On the VM, provision the root for the dedicated service identity, seed an initial commit, and install the config as root-owned/read-only to the service:

```sh
sudo install -d -o autopilot -g autopilot -m 0700 /var/lib/autopilot/workspaces/default
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default init --initial-branch=main
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default config user.name "Autopilot"
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default config user.email "autopilot@localhost"
printf '# Default workspace\n' | sudo -u autopilot tee /var/lib/autopilot/workspaces/default/README.md >/dev/null
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default add README.md
sudo -u autopilot git -C /var/lib/autopilot/workspaces/default commit -m "Initialize workspace"
sudo chown root:autopilot /etc/autopilot
sudo chmod 0750 /etc/autopilot
sudo install -o root -g autopilot -m 0640 aster.json /etc/autopilot/aster.json
```

Set `AUTOPILOT_ASTER_CONFIG=/etc/autopilot/aster.json` in the existing `autopilot.service` `Environment=` entries, then `systemctl daemon-reload && systemctl restart autopilot`. Do not change `--hostname 127.0.0.1` or open a port.

## Issue/revoke the iPhone credential

Create credentials as the service user so the CLI and daemon share the same private database:

```sh
sudo -u autopilot env HOME=/var/lib/autopilot AUTOPILOT_ASTER_CONFIG=/etc/autopilot/aster.json \
  /usr/bin/node /opt/autopilot/bin/autopilot.mjs aster token create \
  --name "Aster iPhone" --workspace default
```

The token is printed once. Import it into the iOS Keychain; never commit it, put it in a prompt, or paste it into chat. Revoke immediately if the phone is lost:

```sh
sudo -u autopilot env HOME=/var/lib/autopilot \
  /usr/bin/node /opt/autopilot/bin/autopilot.mjs aster token revoke <credential-id>
```

## Access paths

Development over SSH (works now):

```sh
ssh -i ~/.ssh/google_compute_engine -N -L 4096:127.0.0.1:4096 root@2.29.49.61
```

Then use `http://127.0.0.1:4096` with the scoped Bearer token. For a physical iPhone, enroll both VM and phone in the same approved Tailscale tailnet, then use **Tailscale Serve only** to proxy HTTPS to `http://127.0.0.1:4096`. Do not enable Funnel or change Autopilot’s loopback bind. Enrollment requires the operator to complete Tailscale’s interactive device authorization; it is not done by this code change.

## Pair a client without copying keys

A laptop CLI or desktop app pairs itself with a device code, like `gh auth login`, and receives an ordinary Aster credential (the five client scopes, every configured workspace, 90 days). Nothing is copied by hand: the server's provider and GitHub credentials never leave it.

1. **Owner (once per browser).** On the server, print a one-time link valid for 24 hours. The installer runs this for you:

   ```sh
   autopilot aster owner link --url https://acme.example.com   # or set AUTOPILOT_PUBLIC_URL
   ```

   Opening it and pressing the button makes that browser the owner: the server issues a `pairing:approve`-only Aster credential (365 days) and stores it in an `HttpOnly; Secure; SameSite=Strict` cookie scoped to `/api/v1/auth`. It cannot call any other API. The link is single-use. Revoke an owner browser like any credential (`autopilot aster token revoke <id>`).

2. **Client.** `POST /api/v1/auth/device` (no auth) with an optional `{"clientName":"MacBook"}` returns:

   ```json
   {"deviceCode":"aster_device_…","userCode":"BCDF-GHJK","verificationUri":"https://acme.example.com/api/v1/auth/approve","verificationUriComplete":"https://acme.example.com/api/v1/auth/approve?code=BCDF-GHJK","expiresIn":600,"interval":5}
   ```

   The client shows the user code, opens `verificationUriComplete`, and polls `POST /api/v1/auth/device/token` with `{"deviceCode":"…"}` every `interval` seconds. Until a decision, the poll returns `400` with error code `authorization_pending` (or `slow_down` when polling faster than the interval). It also returns `400` with `access_denied` after a denial and with `expired_token` once the code has expired or was already redeemed. After approval it returns `200` once with `{token, credentialId, name, workspaceIds, scopes, expiresAt}`; keep the token in the OS keychain.

3. **Approve.** The owner's browser shows the client name and code with Approve / Deny buttons. Form posts must be same-origin. Without an owner browser, approve on the server instead:

   ```sh
   autopilot aster pair list
   autopilot aster pair approve BCDF-GHJK    # or: deny
   ```

Codes are 8 letters without vowels and expire after 10 minutes. At most 20 can wait at once (`429 too_many_pending`). `verificationUri` uses `AUTOPILOT_PUBLIC_URL` when set; otherwise it uses the request's `X-Forwarded-Host`/`Host` and `X-Forwarded-Proto` (`https` unless the host is loopback). All pairing routes live under `/api/v1`, so a gateway that proxies only the Aster API keeps working.

## API contract

All paths below require the scoped Bearer credential. Unknown IDs outside the token’s workspace scope are returned as `404` to avoid disclosing their existence. JSON errors use `{ "error": { "code": "...", "message": "..." } }`.

### Capabilities and discovery

`GET /api/v1/health`

```json
{
  "status": "ok",
  "service": "autopilot",
  "apiVersion": "v1",
  "serviceVersion": "1.5.0",
  "capabilities": ["workspaces", "conversations", "turns", "event-replay", "cancellation", "human-approvals"]
}
```

`GET /api/v1/workspaces` returns only configured, credential-scoped IDs and display names:

```json
{"workspaces":[{"id":"default","displayName":"Default workspace"}]}
```

`GET /api/v1/models` returns `{models: [id…], catalog: [{id, name, contextWindow, inputPerMtok, outputPerMtok, created, reasoning, vision}…], provider: {id, name}, defaultModel}`, never provider credentials. `provider` is the configured provider (`{"id":"openrouter","name":"OpenRouter"}` by default); `defaultModel` is the preset's default model when it is selectable, else the first selectable model. For a DeepSeek server with a fixed list:

```json
{"models":["deepseek-v4-pro","deepseek-flash"],"catalog":[{"id":"deepseek-v4-pro"},{"id":"deepseek-flash"}],"provider":{"id":"deepseek","name":"DeepSeek"},"defaultModel":"deepseek-v4-pro"}
```

Conversation creation and model switches (`400 model_not_allowed`) validate against this list; with `AUTOPILOT_HOTCELL_ANY_MODEL` the cell's token may still call any model the route serves.

### Conversations and turns

Every conversation is bound to exactly one private Hotcell microVM at creation. The cell owns the Autopilot session (`autopilot-ai` JSON-RPC bridge), the `/workspace` volume seeded from the configured workspace's Git tree, and a scoped egress token for the configured provider's gateway route (conversation model only, spend-capped, TTL-bound). Provider credentials never enter the cell image, its env, or its logs; only structured SDK events leave it. Server restart or cell pause never loses the session: on resume the bridge restores the same session ID from the cell volume, and the event cursor survives because it is journaled in the cell.

`POST /api/v1/conversations`

Requires an `Idempotency-Key` header (1-128 safe characters). The key is hashed with the credential ID and bound to one durable conversation/cell/session reservation before any Hotcell create call, so retries across timeouts and server restarts return the original conversation (`200`) instead of duplicating a cell, and reuse with different parameters returns `409 idempotency_conflict`. After an uncertain create (timeout between Hotcell create and record), the retry adopts the cell by its stable conversation label; the server never blindly creates a second cell.

```json
{"workspaceId":"default","model":"moonshotai/kimi-k2.6"}
```

Returns `201` with an opaque conversation ID and cursor; no filesystem paths or agent history:

```json
{"conversationId":"<uuid>","workspaceId":"default","model":"moonshotai/kimi-k2.6","status":"ready","activeRunId":null,"lastEventId":1,"createdAt":"...","updatedAt":"..."}
```

**Uncommitted local work.** A code conversation may also carry `baseCommit` (a full 40-character SHA the repository already has) and `patch` (a `git diff --binary` against it, at most 3 MiB). The cell fetches that exact commit instead of the default branch tip; it never falls back to another commit (provisioning fails with `503` if the commit is unavailable). The patch is written into the cell through a `0600` file and applied with `git apply --index`. It becomes the first commit on the conversation branch ("Apply local changes"), so the pull request contains it. `patch` requires `baseCommit` (`400 base_commit_required`). Patches that look like they contain a provider key are rejected (`400 patch_contains_secret`). Both fields are part of the `Idempotency-Key` fingerprint, so a retry must resend the same changes.

```json
{"workspaceId":"default","model":"moonshotai/kimi-k2.6","kind":"code","repository":"acme/project","baseCommit":"<40-hex sha>","patch":"diff --git a/…"}
```

`GET /api/v1/conversations?limit=50` lists the calling credential's conversations, newest first (limit 1-200, destroyed ones omitted), each in the shape `GET /api/v1/conversations/{conversationId}` returns. For code conversations that includes `repository`, `branch`, and, once opened, `pullRequestURL`.

`GET /api/v1/conversations/{conversationId}` resumes metadata by opaque ID. Conversation history remains server-side; Aster does not replay it on later requests.

`POST /api/v1/conversations/{conversationId}/turns`

The existing iOS client submits the legacy text-only shape, which remains supported:

```json
{"text":"Summarize the failing test and propose a fix."}
```

A legacy request returns `202` with `{conversationId,runId,status:"running"}`. Requests without `clientTurnId` are independent, non-idempotent submissions: the server never deduplicates by comparing text. Callers **must not automatically retry an ambiguous submission** (for example, after a timeout or lost response), because that may start a second turn. If another turn is still active, the request returns `409 conversation_busy`; after it finishes, another text-only submission is treated as a new turn, even if its text is identical.

New clients can opt into durable idempotency by including a stable `clientTurnId`:

```json
{"clientTurnId":"turn-550e8400-e29b-41d4-a716-446655440000","text":"Summarize the failing test and propose a fix."}
```

`clientTurnId` is 1-128 ASCII letters, digits, `.`, `_`, `:`, or `-`, starting with a letter or digit, and is scoped to its conversation. Keep and resend the same ID for every retry of the same logical turn. The server compares the JSON-decoded `text` exactly for key reuse; it trims the text before appending it to the conversation and sending it to the model. Text is capped at 500,000 characters (the model's context window is the practical limit); request bodies are capped at 4 MiB. The workspace cannot be changed by a turn request. A turn may include `"model"`: when it differs from the conversation's model, the server switches the in-cell session to it before starting the turn (`400 model_not_allowed` for models outside the catalog).

The first accepted keyed request returns `202` with `{conversationId,clientTurnId,runId,status:"running"}` and stores that acceptance response, text, and run ID in SQLite in the same transaction that claims the conversation's active turn. Repeating the same ID and same text returns the original `202` response and run ID without appending another user message or starting another run, including after completion or restart. A restarted server marks uncertain work interrupted and does not replay it; a keyed retry still returns the original acceptance receipt, while conversation metadata/SSE reports current state. Reusing the ID with different text returns stable `409 idempotency_conflict`.

Only one active turn per conversation is allowed. A different, previously unused keyed request submitted while another turn is active returns `409 conversation_busy` and does not consume its ID; it may be retried after the active turn ends. An exact retry of an already accepted keyed request replays its response rather than returning busy. If `clientTurnId` is present but malformed (including `null`), the server returns `400 invalid_client_turn_id`; it never silently falls back to legacy mode.

### Autonomy, tool output, and checkpoints

The in-cell agent runs in `auto` mode: every tool call (shell, write, edit, …) is auto-approved, so no `approval.required` events are raised for cell conversations. The phone sees what happened instead: `tool.activity` events carry `{tool, toolCallId, activity: "started", input}` (the shell command or file path) and `{tool, toolCallId, activity: "completed" | "failed", output}` (redacted, at most 16,000 characters with the middle elided).

`/workspace` is a git repository. After every turn, including cancelled or failed ones, the server commits whatever changed and emits `checkpoint.created` `{id, message, createdAt}` before the terminal status event. `.aster/` (bridge state) is excluded.

`GET /api/v1/conversations/{conversationId}/checkpoints` lists up to 100 checkpoints, newest first. `POST /api/v1/conversations/{conversationId}/checkpoints/{sha}/restore` (only between turns; `409 turn_active` otherwise) makes the workspace match that checkpoint, recorded as a new commit so the restore itself can be undone, emits `checkpoint.restored`, and tells the agent about it on its next prompt. Conversation history is not rewound.

`POST /api/v1/conversations/{conversationId}/cancel` is idempotent. It aborts the in-cell turn (`abort` RPC over the bridge), updates durable run state, cancels pending approvals, and returns the current conversation.

`POST /api/v1/conversations/{conversationId}/pause` suspends the cell. On microVM drivers (firecracker/applevz) Hotcell snapshots memory, so the Autopilot session resumes alive; on other drivers the workspace volume survives and the session is restored from it. Pause is only accepted at a safe boundary: with an active turn it returns `409 turn_active`. Turns submitted while paused return `409 conversation_paused`. Pausing is idempotent.

`POST /api/v1/conversations/{conversationId}/resume` restarts the cell, restores the same session ID from the cell volume, and returns to `ready`. Resuming a non-paused conversation is a no-op.

`DELETE /api/v1/conversations/{conversationId}` revokes every scoped egress token through the Hotcell provider, destroys the cell and its volume, and poisons the original `Idempotency-Key` (`410 conversation_destroyed` on reuse). It cancels any active turn first. If token revocation or destruction fails, the mapping is marked `cleanup_pending` and the request returns `503`; retrying `DELETE` resumes cleanup. `DELETE` is idempotent (`200` when already destroyed).

All conversation routes require the creating credential: another credential scoped to the same workspace receives `404`.

### Events and reconnect

`GET /api/v1/conversations/{conversationId}/events` is SSE. Supply `Last-Event-ID: <sequence>` (or `?after=<sequence>`) to replay only later events. IDs are monotonic per conversation. Delivery is at-least-once: clients should de-duplicate by event ID. Reconnect with the last fully processed ID; replayed events are followed by live polling. A `usage` event follows each model step and reports cumulative totals for the current run as `{inputTokens, outputTokens, costUsd, cumulative: true}`. A `todo.updated` event is emitted whenever the agent's task list changes and always contains the full list as `{items: [{title, status}] }`, where status is `pending`, `in_progress`, or `done`.

Example frames:

```text
id: 7
event: assistant.delta
data: {"delta":"I found the failing test."}

id: 8
event: tool.activity
data: {"tool":"edit","activity":"proposed"}

id: 9
event: approval.required
data: {"approvalId":"<uuid>","tool":"edit","explanation":"Edit src/example.ts in this workspace","expiresAt":...}

id: 10
event: usage
data: {"inputTokens":500,"outputTokens":40,"costUsd":0.002,"cumulative":true}

id: 11
event: todo.updated
data: {"items":[{"title":"Run tests","status":"in_progress"},{"title":"Review diff","status":"pending"}]}

id: 12
event: completed
data: {}
```

Tool events contain only names/status summaries, not raw arguments/results. Approval details are fetched separately after authentication. Terminal conversation states are `completed`, `failed`, `cancelled`, and `interrupted`; `waiting_approval` is nonterminal. On server restart, uncertain turns are marked interrupted and pending approvals expire; no action is replayed.

### Human approvals

`GET /api/v1/approvals/{approvalId}` returns the exact reviewable action/arguments and expiry. Secret-like payloads and paths outside the conversation worktree are rejected before an approval is created. The SSE `approval.required` event contains only the stable ID, tool name, concise explanation, and expiry. An unanswered approval keeps the run paused while the service is up, regardless of whether an SSE client is connected. Closing the app does not cancel it: the conversation remains `waiting_approval`, and `approval.required` is journaled and replayed after reconnect until a decision or `expiresAt`. Server restarts still follow the recovery behavior described above.

When APNs is configured, an approval sends a push with `aps.category = "APPROVAL"`, alert text `"<tool>: <explanation>"`, and custom data `{conversationId, approvalId}`. Completed and failed runs send custom data `{conversationId}` only when no client is connected to that conversation's SSE stream at the moment the run ends.

`POST /api/v1/approvals/{approvalId}`

```json
{"decision":"allow"}
```

Use `deny` to reject. Decisions are single-use; repeating the same decision is idempotent, a conflicting decision returns `409 approval_already_resolved`, and expired approvals return `410 approval_expired`. Deny/expiry never execute the proposed tool action.

## Interactive client: `autopilot attach-remote`

`autopilot attach-remote` opens Autopilot's own interactive UI (Camouflage) on a code conversation that runs in a cell on the server. It is the API's interactive client: other tools (for example Directionally Local's `dl`) launch it with the server and credential in the environment, never in argv.

```sh
AUTOPILOT_REMOTE_URL=http://127.0.0.1:53817 AUTOPILOT_REMOTE_TOKEN=aster_… \
  autopilot attach-remote --workspace default --repo acme/project --model moonshotai/kimi-k2.6 \
  [--base-commit <40-hex sha> [--patch-file local.patch]] --state-file state.json --title "dl · acme/project"
# later:
autopilot attach-remote --conversation <id> --state-file state.json
```

- New conversations are created with an `Idempotency-Key`; `--patch-file` is read and sent as `patch` (never logged). `--conversation` replays the conversation's events from 0, then follows live. `--state-file` gets `{"conversationId","branch","repository"}` (mode `0600`, written atomically) as soon as the conversation exists.
- Each message is a turn with its own `clientTurnId`. Messages typed while a turn runs queue and are sent, in order, when it ends. `/model <id>` sends `model` with the next turn. Shell (`!`), laptop image attachments and local-only slash commands are refused with a message; `/help`, `/model`, `/status`, `/pr` and `/exit` work.
- Events render like a local session's: assistant text, `tool.activity` rows with input and output, `todo.updated`, `usage` cost, checkpoints, outcomes and errors; `approval.required` opens the permission prompt and posts the decision. After a turn the conversation's `pullRequestURL` is shown (again whenever it changes). The SSE stream reconnects with `Last-Event-ID` and drops duplicate IDs.
- Esc cancels the running turn (`POST …/cancel`). Quitting (Ctrl-D, `/exit`, closing the terminal, SIGTERM/SIGHUP) only detaches: the conversation keeps running on the server. Exit code 0 on detach, 1 on errors (a `401` means the credential was revoked or expired).

## Operations, retention, and rollback

- Service: `systemctl status autopilot`; logs: `journalctl -u autopilot`. Autopilot is a non-root systemd service with `Restart=on-failure`, loopback bind, and a health endpoint. Keep journald bounded (for example, an operator-approved `/etc/systemd/journald.conf.d/` cap); the current VM has no Autopilot-specific journald retention override.
- Before an upgrade, stop the service and make an offline backup of the Aster DB, run DB, sessions, worktrees, and workspace data. Encrypt the archive off-host with an operator-held `age` recipient; do not store a private decryption key on the VM.
- Roll back by stopping the service, checking out the previous known-good commit in `/opt/autopilot`, running `npm ci && npm run build`, and restarting. Keep the databases: schema changes are additive, and deleting them would lose conversations/approvals. Restore a backup only if the migration is incompatible, and restore the matching app version with it.
- The deployment smoke check must exercise create conversation, first turn, event replay, follow-up turn, approval resolution, and cancellation through an SSH tunnel. A one-turn health check alone is insufficient.

## Current operator setup gap

This runbook describes the required private path, but the inspected VM currently has no Tailscale client/enrollment. Until an operator enrolls the VM and iPhone into an approved tailnet and configures Serve (never Funnel), only the SSH-tunnel development path is available. Autopilot must remain loopback-bound in the meantime.
