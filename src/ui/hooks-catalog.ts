// Help text for the hook setup wizard: what each event means and example
// commands and matchers.

import type { HookEvent } from "../hooks/types.js";

export const EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  PreToolUse: "before every tool call — can VETO (block) it",
  PostToolUse: "after every tool call — informational only",
  PostToolUseFailure: "after a tool call fails — informational only",
  PermissionRequest: "before you're asked to approve a call — can allow or deny it",
  UserPromptSubmit: "when you hit Enter — can VETO the prompt",
  Stop: "when the agent finishes a turn — informational only",
  PreCompact: "before auto-compaction shrinks the conversation",
  SessionStart: "when a session starts or is resumed — informational only",
  SessionEnd: "when autopilot exits or the session is cleared — informational only",
};

/** Concrete, copy-pasteable command examples per event. Shown in the
 *  wizard's `command` step so users see exactly what a hook looks like
 *  instead of having to invent one from first principles. */
export const EVENT_COMMAND_EXAMPLES: Record<HookEvent, string[]> = {
  PreToolUse: [
    `# Block edits to secrets / .env files:`,
    `case "$AUTOPILOT_HOOK_PATH" in *.env|*.pem|*.key) echo blocked >&2; exit 2 ;; esac`,
    ``,
    `# Block writes anywhere outside src/:`,
    `case "$AUTOPILOT_HOOK_PATH" in src/*) exit 0 ;; *) echo "writes restricted to src/" >&2; exit 2 ;; esac`,
  ],
  PostToolUse: [
    `# Auto-format JS/TS files with prettier after every edit:`,
    `npx --no-install prettier --write "$AUTOPILOT_HOOK_PATH" 2>/dev/null || true`,
    ``,
    `# Log every tool call to an audit file:`,
    `echo "$(date -u +%FT%TZ) $AUTOPILOT_HOOK_TOOL $AUTOPILOT_HOOK_RESULT_OK" >> ~/.local/state/autopilot/tool-audit.log`,
  ],
  PostToolUseFailure: [
    `# Log failed tool calls with their error:`,
    `jq -c '{tool: .tool_name, error: .error}' >> ~/.local/state/autopilot/tool-failures.log`,
  ],
  PermissionRequest: [
    `# Never let the agent touch .env files, without asking you:`,
    `case "$AUTOPILOT_HOOK_PATH" in *.env) echo "no .env edits" >&2; exit 2 ;; esac`,
    ``,
    `# Auto-approve writes under src/ (other calls still prompt):`,
    `case "$AUTOPILOT_HOOK_PATH" in src/*) echo '{"hookSpecificOutput":{"permissionDecision":"allow"}}' ;; esac`,
  ],
  UserPromptSubmit: [
    `# Block prompts that contain "password":`,
    `jq -r .prompt | grep -qiv password || { echo "no passwords in prompts" >&2; exit 2; }`,
    ``,
    `# Log every prompt with its tier:`,
    `echo "[$AUTOPILOT_HOOK_TIER] $(jq -r .prompt)" >> ~/.local/state/autopilot/prompts.log`,
  ],
  Stop: [
    `# Terminal bell when the agent finishes:`,
    `printf '\\a'`,
    ``,
    `# macOS desktop notification:`,
    `osascript -e 'display notification "Turn complete" with title "autopilot (formerly kimiflare)"'`,
  ],
  PreCompact: [
    `# Snapshot the session file before compaction shrinks it:`,
    `mkdir -p ~/snapshots && cp ~/.local/share/autopilot/sessions/$AUTOPILOT_HOOK_SESSION_ID.json ~/snapshots/`,
  ],
  SessionStart: [
    `# Record session starts:`,
    `echo "$(date -u +%FT%TZ) start $AUTOPILOT_HOOK_SESSION_ID" >> ~/.local/state/autopilot/sessions.log`,
  ],
  SessionEnd: [
    `# Record session ends:`,
    `echo "$(date -u +%FT%TZ) end $AUTOPILOT_HOOK_SESSION_ID" >> ~/.local/state/autopilot/sessions.log`,
  ],
};

/** Suggested matcher regexes per event. Shown in the matcher step so
 *  users see the common patterns instead of inventing them. */
export const MATCHER_EXAMPLES = [
  `"^(edit|write)$"  — only file edits / writes (the common case)`,
  `"^bash$"          — only bash commands`,
  `"Bash|Edit|Write"  — Claude Code names work too (case-sensitive)`,
  `"^mcp_"           — every MCP-server tool`,
  `"^lsp_"           — every LSP tool`,
  `""                — match every tool (or just leave blank)`,
];
