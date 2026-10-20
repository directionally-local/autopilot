import type { SlashItem } from "./types.js";

/**
 * Built-in slash commands shown in the `/`-trigger picker. Handlers may
 * still exist for commands not listed here (users can type them manually).
 */
export const BUILTIN_COMMANDS: SlashItem[] = [
  { name: "help", description: "Show keybindings and command list", source: "builtin" },
  { name: "model", argHint: "[list|<id>]", description: "Pick model (no args opens picker)", source: "builtin" },
  { name: "jev", argHint: "[yes|choose|score]", description: "Ask Jev for a one-shot decision with scoped chat/project context", source: "builtin" },
  { name: "subagents", argHint: "[list|cancel <n>|all|stats|off|suggest|auto]", description: "List or stop running subagents; set the delegation policy", source: "builtin" },
  { name: "now", description: "Run your latest queued message now instead of after the current turn", source: "builtin" },
  { name: "mode", argHint: "[edit|plan|auto]", description: "Switch agent mode", source: "builtin" },
  { name: "theme", argHint: "[<name>]", description: "Switch color theme", source: "builtin" },
  // Ink is the only UI engine; handler remains for manual use.
  { name: "memory", argHint: "[on|off|clear|search ...]", description: "Manage memory", source: "builtin" },
  { name: "cost", argHint: "[verify|on|off]", description: "Show cost report or toggle attribution", source: "builtin" },
  { name: "settings", argHint: "[modes on|off]", description: "Show or change feature settings (e.g. plan/edit/auto modes)", source: "builtin" },
  { name: "key", argHint: "[set <key>|clear]", description: "Show or replace the active provider's API key", source: "builtin" },
  { name: "provider", argHint: "[<id>]", description: "Connect or switch LLM provider — sign in or add a key (OpenRouter, Anthropic, OpenAI, Gemini, Ollama, …)", source: "builtin" },
  { name: "mcp", argHint: "[list|reload]", description: "Manage MCP servers", source: "builtin" },
  { name: "lsp", argHint: "[config|list|reload|scope]", description: "Manage language servers", source: "builtin" },
  { name: "hooks", argHint: "[list|recommended|enable <id>|disable <id>|path|reload]", description: "Manage lifecycle hooks", source: "builtin" },
  { name: "skills", argHint: "[list|add|edit|delete|enable|disable]", description: "Manage skills", source: "builtin" },
  { name: "command", argHint: "[create|edit|delete|list]", description: "Manage custom slash commands", source: "builtin" },
  { name: "resume", description: "Pick a past conversation to resume", source: "builtin" },
  { name: "checkpoint", argHint: "[label]", description: "Save current point in session", source: "builtin" },
  { name: "checkpoints", description: "List checkpoints in current session", source: "builtin" },
  { name: "compact", description: "Summarize old turns to free context", source: "builtin" },
  { name: "good", description: "Rate the last turn as good (recorded in the local session trace)", source: "builtin" },
  { name: "bad", argHint: "[reason]", description: "Rate the last turn as bad (recorded in the local session trace)", source: "builtin" },
  { name: "clear", description: "Clear current conversation", source: "builtin" },
  { name: "fresh", description: "Start a fresh session with a summarized plan or continuation context", source: "builtin" },
  { name: "init", description: "Scan repo and write AGENTS.md", source: "builtin" },
  { name: "update", description: "Check for updates", source: "builtin" },
  { name: "hello", description: "Send a voice note to the creator", source: "builtin" },
  { name: "shell", argHint: "[auto|bash|cmd|powershell|<path>]", description: "Show or set shell for bash tool", source: "builtin" },
  { name: "changelog-image", argHint: "[owner/repo] [days]", description: "Generate a changelog image from merged PRs", source: "builtin" },
  { name: "logout", description: "Clear stored credentials", source: "builtin" },
  { name: "exit", description: "Exit autopilot (formerly kimiflare)", source: "builtin" },
];

export const BUILTIN_COMMAND_NAMES = new Set(
  BUILTIN_COMMANDS.map((c) => c.name.toLowerCase()),
);
