# Use Autopilot with Agent Beacon

[Agent Beacon](https://github.com/Asymptote-Labs/agent-beacon) records coding-agent sessions as structured events. It can serve reviewed memory back to agents over MCP, and forward events to SIEMs. Everything stays local unless you configure forwarding.

Autopilot exposes the two signals Beacon reads:

- **Hooks.** Every hook payload carries Claude Code's field names: `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, `tool_call_id` and `transcript_path`, with Claude Code's tool names and shapes (see [Tool names and result shapes](#tool-names-and-result-shapes)). `Stop` carries `last_assistant_message`, and every payload carries `"beacon.harness.name": "autopilot"`. Autopilot also fires `SessionStart` and `SessionEnd`.
- **OpenTelemetry events.** With `KIMIFLARE_OTEL_ENDPOINT` set, Autopilot emits OTLP log events named `autopilot.session.start`, `autopilot.api_request`, `autopilot.tool_result` and `autopilot.session.end`. They carry the OpenTelemetry GenAI attributes (`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cached_input_tokens`), plus `cost.usd`. These cover token usage and cost, which hooks can't carry.

Neither ever contains API keys or provider tokens. OTel events carry sizes, names, ids, usage and outcomes, never prompt or tool content.

## Hooks

Until Beacon ships an `autopilot` platform, use its Claude Code mode. Add this to `~/.config/autopilot/settings.json`, or to `.autopilot/settings.json` for a single project (see [Settings location](#settings-location)):

```json
{
  "hooks": {
    "SessionStart": [{ "id": "beacon-session-start", "command": "beacon-hooks --platform claude session-start" }],
    "UserPromptSubmit": [{ "id": "beacon-prompt", "command": "beacon-hooks --platform claude prompt-submit" }],
    "PreToolUse": [{ "id": "beacon-pre-tool", "command": "beacon-hooks --platform claude pre-tool" }],
    "PostToolUse": [{ "id": "beacon-post-tool", "command": "beacon-hooks --platform claude post-tool" }],
    "PreCompact": [{ "id": "beacon-pre-compact", "command": "beacon-hooks --platform claude pre-compact" }],
    "Stop": [{ "id": "beacon-stop", "command": "beacon-hooks --platform claude stop" }],
    "SessionEnd": [{ "id": "beacon-session-end", "command": "beacon-hooks --platform claude session-end" }]
  }
}
```

With Beacon's endpoint installed, sessions appear as `session.started` / `session.ended` events, with `prompt.submitted`, `tool.invoked`, `file.read`, `file.modified` (with a diff for each write and edit), `command.executed` (with the exit code when a command fails) and `agent.message` (the turn's final reply) in between, all keyed by Autopilot's session id. In this mode they're labelled `harness.name: claude_code`.

Run `/hooks reload` in a running session to pick up the change.

### Session and prompt events

Every host (the interactive UI, `autopilot -p`, `--emit-events`, `autopilot serve` and the SDK, so also RPC) fires the session events in this order: `SessionStart`, then `UserPromptSubmit` for each prompt, then the turn's tool events and `Stop`, and `SessionEnd` when the session ends. Each one carries the session id, the first prompt of a new session included. Steering messages typed during a turn are not separate prompts.

`UserPromptSubmit` can block the prompt (exit 2, or a `deny`/`block` decision); nothing is sent to the model:

| Host | A blocked prompt |
| --- | --- |
| Interactive UI | shows `hook blocked the prompt: <reason>` and waits for the next prompt |
| `autopilot -p` | prints the reason (`json`: an `error` and `blocked.reason`; `stream-json`: an `error` event) and exits with code 44 |
| `--emit-events` | emits a `RuntimeError` with the reason; one-shot exits 44, `--multi-turn` waits for the next prompt |
| `autopilot serve` | `POST /prompt` and `/session/:id/prompt` answer `403 {"error": "prompt_blocked", "reason": …}`; `--attach` exits 44 |
| SDK / RPC | `session.prompt()` rejects with `PromptBlockedError` (`code: "prompt_blocked"`, `reason`); RPC answers the `prompt` command with an error |

`SessionEnd` fires once on every way out: `/exit`, Ctrl+C twice (within the renderer's double-press window), a closed terminal (SIGHUP), SIGINT or SIGTERM, bounded by a 3-second shutdown deadline. A session with no prompt yet has no `SessionStart`, so it has no `SessionEnd` either.

### Settings location

The canonical hook settings files, which an installer should write, are:

- global: `$XDG_CONFIG_HOME/autopilot/settings.json` (default `~/.config/autopilot/settings.json`)
- project: `<project>/.autopilot/settings.json`

Autopilot still reads the legacy `~/.config/kimiflare/settings.json` (once Autopilot has moved `~/.config/kimiflare`, a link to the autopilot file, read once) and `.kimiflare/settings.json`. All four are merged in this order: legacy global, global, legacy project, project. Within an event, hooks run in that order, and an entry with the same `id` as an earlier one replaces it, so writing the Beacon hooks above with their fixed ids to the autopilot file never runs them twice. In code these paths come from `globalSettingsPath()`, `projectSettingsPath(cwd)`, `legacyGlobalSettingsPath()`, `legacyProjectSettingsPath(cwd)` and `hookSettingsLocations(cwd)` in `src/hooks/settings.ts`.

Hook commands also get `AUTOPILOT_HOOK_*` env vars (`EVENT`, `CWD`, `SESSION_ID`, `TOOL`, `PATH`, `TIER`, `PAYLOAD`, …), each set under its older `KIMIFLARE_HOOK_*` name too.

### Matchers

A hook `matcher` is a case-sensitive regex tried against both the Autopilot name and the Claude Code name in the table below (and `MultiEdit` for an edit with `edits[]`), so `bash`, `Bash` and `Bash|Edit` all work, as do matchers copied from a Claude Code config. `*`, an empty matcher or none matches every tool. `BASH` matches nothing.

### Tool names and result shapes

`tool_name` and `tool_input` use Claude Code's names. Autopilot's own name stays in `tool` and `autopilot_tool_name`, its own arguments in `args`. Hook `matcher`s match either name (see [Matchers](#matchers)).

| Autopilot tool | `tool_name` | `tool_input` |
| --- | --- | --- |
| `bash` | `Bash` | `command`, `timeout` (from `timeout_ms`) |
| `edit` with `old_string`/`new_string` | `Edit` | `file_path`, `old_string`, `new_string`, `replace_all` |
| `edit` with `edits[]` | `MultiEdit` | `file_path`, `edits: [{old_string, new_string, replace_all?}]` (a single pair passed beside `edits[]` comes first) |
| `write` | `Write` | `file_path`, `content` |
| `read` | `Read` | `file_path`, `offset`, `limit` |
| `glob` | `Glob` | `pattern`, `path` |
| `grep` | `Grep` | `pattern`, `path`, `glob`, `-i` (from `case_insensitive`), `output_mode` (`files` → `files_with_matches`) |
| `web_fetch` | `WebFetch` | `url` |
| `search_web` | `WebSearch` | `query` |
| anything else (MCP, LSP, memory, subagent, …) | unchanged | unchanged |

`file_path` and `path` are absolute, resolved against the session's `cwd`.

`PostToolUse`'s `tool_response` keeps Autopilot's `ok`, `content` and `errorCode` (except a successful `write`'s `content`, below), and adds:

- `success` and `is_error`: whether the call did what it was asked. A `bash` command that exits non-zero or is killed counts as a failure here, although its `ok` stays `true`.
- For `bash`: `stdout`, `stderr` (separately, each capped at 4 KB), `exit_code` (`null` when killed) and `interrupted` (timed out or aborted).
- For a successful `write` or `edit`: `filePath`, and Claude Code's diff fields (when a `PostToolUse` or `PostToolUseFailure` hook is enabled):
  - `structuredPatch`: the change as hunks, `[{oldStart, oldLines, newStart, newLines, lines}]`, with real line numbers, 3 lines of context, and each line prefixed by ` `, `-` or `+`. `[]` for a new file. Left out when the file (before or after) is over 1 MiB.
  - `originalFile`: the file before the call; `null` for a new file. Left out when the file was over 256 KiB (the patch still shows the change).
  - `write` (`Write`): `type` (`"create"` or `"update"`) and `content`, which is the text written to the file, as in Claude Code; this replaces Autopilot's own result line, which stays in `result.content`. `edit`: `oldString`, `newString`, `replaceAll` (`Edit`) or `edits` (`MultiEdit`).

  With `structuredPatch`, Beacon's `file.modified` diff has the edit's real line numbers, and a `Write` over an existing file shows as an update rather than a whole-file create.

A failed call also gets Claude Code's failure fields at the top level:

- `error`: for a command that exited non-zero, `Exit code N` followed by its output (Beacon reads the exit code from this line); otherwise Autopilot's error text.
- `is_interrupt`: the call was aborted or timed out.
- A failed `write` or `edit` keeps its own name (`write`, `edit`) in `tool_name`. `Write`, `Edit` and `MultiEdit` mean the file changed; Beacon's Claude mode records a `file.modified` diff for any call so named, so a write that never landed would otherwise be logged as one. Beacon records it as `tool.failed` instead.

`PostToolUse` still fires for failures, so the setup above already records them; check `error` or `tool_response.is_error`. Autopilot also fires Claude Code's `PostToolUseFailure` (see below).

### Failures and approval prompts

Autopilot fires two more Claude Code events:

- `PostToolUseFailure`, for a failed call, alongside `PostToolUse`. It carries `tool_name`, `tool_input`, `tool_use_id`, `error` and `is_interrupt`, with the same naming rules as above. The setup above already records failures through `PostToolUse`, so registering `beacon-hooks --platform claude post-tool` on `PostToolUseFailure` as well would record each failure twice. Use it for other observers that only want failures.
- `PermissionRequest`, when Autopilot is about to ask you to approve a call. It carries `tool_name`, `tool_input`, `tool_use_id` and `permission_mode`. Add it so Beacon sees approval prompts:

  ```json
  "PermissionRequest": [{ "id": "beacon-permission", "command": "beacon-hooks --platform claude permission-request" }]
  ```

  A deny from the hook (exit 2, `permissionDecision: "deny"`, or Claude Code's `decision.behavior: "deny"`) answers the prompt with no; an `allow` answers it with yes, except in plan mode. Beacon only answers when a policy denies the call.

If a hook times out, crashes or its command is missing, Autopilot carries on (fail-open), shows a warning once per hook per session, and emits an `autopilot.hook.failed` OTel event (below). Set `"failClosed": true` on a policy hook to block instead; see the README's "Hook failures and `failClosed`".

## Transcript

Every hook payload with a session id carries `transcript_path` and `transcript_format: "claude-jsonl"`. The path points at a transcript in Claude Code's JSONL format, which Autopilot writes next to its own session file:

```
~/.local/share/autopilot/sessions/<session id>.json    Autopilot's session (unchanged)
~/.local/share/autopilot/sessions/<session id>.jsonl   the transcript
```

(`$XDG_DATA_HOME` replaces `~/.local/share` when set.) Every host that has a session id writes one: the TUI, print mode, `--emit-events`, `autopilot serve`'s `/prompt`, and the SDK.

Each line is one JSON object. Entries are appended as the session runs, so the file can be read mid-session and every line on disk is complete:

| When | Entry |
| --- | --- |
| A turn starts | `type: "user"`, `message: {role: "user", content: "<prompt>"}`, plus a new `promptId` |
| A model response completes | `type: "assistant"`, `message: {id, type: "message", role: "assistant", model, content, stop_reason, usage}`, plus `requestId` |
| A tool call finishes | `type: "user"`, `message: {role: "user", content: [{type: "tool_result", tool_use_id, content, is_error}]}`, plus `promptId` and `sourceToolAssistantUUID` |
| Input typed during a turn | a `user` entry with its own `promptId` |
| A background subagent's report is delivered | a `user` entry with `isMeta: true` (Claude Code's mark for injected messages) |

Every entry also carries `uuid`, `parentUuid` (the previous entry's `uuid`, so the entries form one chain), `timestamp`, `sessionId`, `cwd`, `isSidechain: false`, `userType: "external"` and `entrypoint: "autopilot"`.

- **Assistant `content`** is a list of blocks: `thinking` (the model's reasoning, when the provider returns it), `text`, and one `tool_use` block per tool call (`{type, id, name, input}`). The `tool_use` blocks use Claude Code's tool names and input shapes, the same as `tool_name` and `tool_input` in hook payloads (see [Tool names and result shapes](#tool-names-and-result-shapes)). Each `tool_result`'s `tool_use_id` matches the `id` of its `tool_use`.
- **`usage`** uses Anthropic's field names: `input_tokens` (prompt tokens that were not read from or written to the cache), `output_tokens`, `cache_read_input_tokens` and `cache_creation_input_tokens`. `message.id` and `requestId` are the provider's response id when it reports one, so Beacon counts each response once.
- **Images** in a prompt are written as a `[Image]` text block, never as base64.
- **Not written:** the system prompt and Autopilot's internal nudges (system messages).

**Redaction and size.** The transcript is redacted the same way as the session trace (`KIMIFLARE_TRACE`): OpenRouter keys, GitHub tokens, `Bearer`/`Basic` credentials, private-key blocks, and the values of `api_key=`, `token:`, `secret`, `password` and `authorization` pairs become `<redacted>`. A block over 256 KB is cut and marked `[truncated: N bytes total]`, the way the trace cuts its blobs. A transcript stops growing at the trace's per-session cap (200 MB). Transcripts are kept with their session files and only deleted by `autopilot history prune`.

**Resume.** A resumed session (`--continue`, `--session`, `/resume`) appends to its existing transcript and continues the `parentUuid` chain.

**Turning it off.** Set `KIMIFLARE_TRANSCRIPT=0`. Hook payloads then point `transcript_path` at the session JSON, with `transcript_format: "autopilot-json"`.

With Beacon's Claude mode, hooks read the newest `promptId` from the transcript and stamp it as `prompt.id` on `tool.invoked`, `command.executed` and `agent.message`. Beacon's Claude session reader also parses the file: it finds the prompt, each assistant message, the tool calls and their results, and a `token.usage` event per response.

## OpenTelemetry

Point Autopilot at Beacon's local OTLP/HTTP collector:

```sh
export KIMIFLARE_OTEL_ENDPOINT=http://127.0.0.1:4318   # /v1/logs is appended
```

The resource carries `service.name: autopilot` and `beacon.harness.name: autopilot`, and the instrumentation scope is `autopilot`.

When a hook fails (timeout, crash, missing command), Autopilot emits `autopilot.hook.failed` at WARN severity with `hook.id`, `hook.event`, `hook.failure` (`timeout`, `spawn_failed`, `command_not_found` or `nonzero_exit`), `hook.reason`, `hook.allowed` (`false` only when `failClosed` blocked the action), `hook.fail_closed` and `hook.failure_count`. Every failure is sent, not only the first, so Beacon can tell which calls ran without a policy check.

## Shared memory over MCP

Add Beacon's local MCP server (no network) to Autopilot's `mcpServers` config:

```json
{ "mcpServers": { "beacon": { "type": "local", "command": ["beacon", "mcp", "serve"] } } }
```

## Setup

In `beacon` setup, choose **Local**. That keeps events on this machine (Beacon Cloud is otherwise preselected).
