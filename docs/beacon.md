# Use Autopilot with Agent Beacon

[Agent Beacon](https://github.com/Asymptote-Labs/agent-beacon) records coding-agent sessions as structured events. It can serve reviewed memory back to agents over MCP, and forward events to SIEMs. Everything stays local unless you configure forwarding.

Autopilot exposes the two signals Beacon reads:

- **Hooks.** Every hook payload carries Claude Code's field names: `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, `tool_call_id` and `transcript_path`, with Claude Code's tool names and shapes (see [Tool names and result shapes](#tool-names-and-result-shapes)). `Stop` carries `last_assistant_message`, and every payload carries `"beacon.harness.name": "autopilot"`. Autopilot also fires `SessionStart` and `SessionEnd`.
- **OpenTelemetry events.** With `KIMIFLARE_OTEL_ENDPOINT` set, Autopilot emits OTLP log events named `autopilot.session.start`, `autopilot.api_request`, `autopilot.tool_result` and `autopilot.session.end`. They carry the OpenTelemetry GenAI attributes (`gen_ai.provider.name`, `gen_ai.request.model`, `gen_ai.usage.input_tokens`, `gen_ai.usage.output_tokens`, `gen_ai.usage.cached_input_tokens`), plus `cost.usd`. These cover token usage and cost, which hooks can't carry.

Neither ever contains API keys or provider tokens. OTel events carry sizes, names, ids, usage and outcomes, never prompt or tool content.

## Hooks

Until Beacon ships an `autopilot` platform, use its Claude Code mode. Add this to `~/.config/kimiflare/settings.json`, or to `.kimiflare/settings.json` for a single project:

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

### Tool names and result shapes

`tool_name` and `tool_input` use Claude Code's names. Autopilot's own name stays in `tool` and `autopilot_tool_name`, its own arguments in `args`, and hook `matcher`s still match Autopilot's names.

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

The event stays `PostToolUse` for failures (Claude Code fires `PostToolUseFailure`); check `error` or `tool_response.is_error`.

## OpenTelemetry

Point Autopilot at Beacon's local OTLP/HTTP collector:

```sh
export KIMIFLARE_OTEL_ENDPOINT=http://127.0.0.1:4318   # /v1/logs is appended
```

The resource carries `service.name: autopilot` and `beacon.harness.name: autopilot`, and the instrumentation scope is `autopilot`.

## Shared memory over MCP

Add Beacon's local MCP server (no network) to Autopilot's `mcpServers` config:

```json
{ "mcpServers": { "beacon": { "type": "local", "command": ["beacon", "mcp", "serve"] } } }
```

## Setup

In `beacon` setup, choose **Local**. That keeps events on this machine (Beacon Cloud is otherwise preselected).
