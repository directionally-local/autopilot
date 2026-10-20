# Use Autopilot with Agent Beacon

[Agent Beacon](https://github.com/Asymptote-Labs/agent-beacon) records coding-agent sessions as structured events. It can serve reviewed memory back to agents over MCP, and forward events to SIEMs. Everything stays local unless you configure forwarding.

Autopilot exposes the two signals Beacon reads:

- **Hooks.** Every hook payload carries Claude Code's field names: `hook_event_name`, `session_id`, `cwd`, `tool_name`, `tool_input`, `tool_response`, `tool_call_id` and `transcript_path`. Autopilot also fires `SessionStart` and `SessionEnd`.
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

With Beacon's endpoint installed, sessions appear as `session.started` / `session.ended` events, with `tool.invoked`, `file.read` (with the path) and `command.executed` in between, all keyed by Autopilot's session id. In this mode they're labelled `harness.name: claude_code`.

Run `/hooks reload` in a running session to pick up the change.

## OpenTelemetry

Point Autopilot at Beacon's local OTLP/HTTP collector:

```sh
export KIMIFLARE_OTEL_ENDPOINT=http://127.0.0.1:4318   # /v1/logs is appended
```

## Shared memory over MCP

Add Beacon's local MCP server (no network) to Autopilot's `mcpServers` config:

```json
{ "mcpServers": { "beacon": { "type": "local", "command": ["beacon", "mcp", "serve"] } } }
```

## Setup

In `beacon` setup, choose **Local**. That keeps events on this machine (Beacon Cloud is otherwise preselected).
