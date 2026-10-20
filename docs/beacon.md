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

With Beacon's endpoint installed, sessions appear as `session.started` / `session.ended` events, with `tool.invoked`, `file.read`, `file.modified` (with a diff for each write and edit), `command.executed` (with the exit code when a command fails) and `agent.message` (the turn's final reply) in between, all keyed by Autopilot's session id. In this mode they're labelled `harness.name: claude_code`.

Run `/hooks reload` in a running session to pick up the change.

### Settings location

The canonical hook settings files, which an installer should write, are:

- global: `$XDG_CONFIG_HOME/autopilot/settings.json` (default `~/.config/autopilot/settings.json`)
- project: `<project>/.autopilot/settings.json`

Autopilot still reads the legacy `~/.config/kimiflare/settings.json` and `.kimiflare/settings.json`. All four are merged in this order: legacy global, global, legacy project, project. Within an event, hooks run in that order, and an entry with the same `id` as an earlier one replaces it, so writing the Beacon hooks above with their fixed ids to the autopilot file never runs them twice. In code these paths come from `globalSettingsPath()`, `projectSettingsPath(cwd)`, `legacyGlobalSettingsPath()`, `legacyProjectSettingsPath(cwd)` and `hookSettingsLocations(cwd)` in `src/hooks/settings.ts`.

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

`PostToolUse`'s `tool_response` keeps Autopilot's `ok`, `content` and `errorCode`, and adds:

- `success` and `is_error`: whether the call did what it was asked. A `bash` command that exits non-zero or is killed counts as a failure here, although its `ok` stays `true`.
- For `bash`: `stdout`, `stderr` (separately, each capped at 4 KB), `exit_code` (`null` when killed) and `interrupted` (timed out or aborted).
- For a successful `write` or `edit`: `filePath`.

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
