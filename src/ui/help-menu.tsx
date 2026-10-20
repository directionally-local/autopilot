import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";

interface CustomCommandSummary {
  name: string;
  description?: string;
}

interface Props {
  customCommands?: CustomCommandSummary[];
  costAttributionEnabled?: boolean;
  onDone: () => void;
  onCommand: (command: string) => void;
}

export type Page =
  | "main"
  | "mode"
  | "session"
  | "memory"
  | "skills"
  | "cost"
  | "mcp"
  | "lsp"
  | "info"
  | "config"
  | "commands"
  | "custom";

export interface CommandItem {
  command: string;
  description: string;
  selectable?: boolean;
}

export interface Category {
  key: Page;
  label: string;
  commands: CommandItem[];
}

export const CATEGORIES: Category[] = [
  {
    key: "mode",
    label: "Mode",
    commands: [
      { command: "/settings modes on", description: "turn plan/edit/auto modes on (off by default: always auto)" },
      { command: "/settings modes off", description: "turn modes off (always auto)" },
      { command: "/mode edit", description: "switch to edit mode" },
      { command: "/mode plan", description: "switch to plan mode" },
      { command: "/mode auto", description: "switch to auto mode" },
      { command: "/subagents", description: "list or cancel running subagents; set delegation policy" },
      { command: "/now", description: "run your latest queued message now (also Ctrl+G)" },
      { command: "/subagents auto", description: "let the coordinator assess substantial tasks (default)" },
      { command: "/subagents suggest", description: "use conservative delegation suggestions" },
      { command: "/subagents off", description: "disable automatic delegation suggestions" },
    ],
  },
  {
    key: "session",
    label: "Session",
    commands: [
      { command: "/resume", description: "pick a past conversation" },
      { command: "/compact", description: "summarize old turns to free context" },
      { command: "/clear", description: "clear current conversation" },
      { command: "/fresh", description: "reset session and start fresh with the last plan" },
      { command: "/good", description: "rate the last turn good (local session trace)" },
      { command: "/bad [reason]", description: "rate the last turn bad (local session trace)", selectable: false },
    ],
  },
  {
    key: "memory",
    label: "Memory",
    commands: [
      { command: "/memory", description: "show memory stats" },
      { command: "/memory on", description: "enable memory" },
      { command: "/memory off", description: "disable memory" },
      { command: "/memory clear", description: "wipe memories for this repo" },
      { command: "/memory search <query>", description: "search stored memories", selectable: false },
    ],
  },
  {
    key: "skills",
    label: "Skills",
    commands: [
      { command: "/skills list", description: "list all skills" },
      { command: "/skills add <name>", description: "create a new skill", selectable: false },
      { command: "/skills edit <name>", description: "show path to a skill file", selectable: false },
      { command: "/skills delete <name>", description: "delete a skill", selectable: false },
      { command: "/skills enable <name>", description: "enable a skill", selectable: false },
      { command: "/skills disable <name>", description: "disable a skill", selectable: false },
    ],
  },
  {
    key: "cost",
    label: "Cost",
    commands: [
      { command: "/cost", description: "show cost report" },
      { command: "/cost on", description: "enable cost attribution by task type" },
      { command: "/cost off", description: "disable cost attribution by task type" },
    ],
  },
  {
    key: "mcp",
    label: "MCP",
    commands: [
      { command: "/mcp list", description: "list connected MCP servers and tools" },
      { command: "/mcp reload", description: "reconnect all configured MCP servers" },
    ],
  },
  {
    key: "lsp",
    label: "LSP",
    commands: [
      { command: "/lsp config", description: "add, edit, or remove language servers" },
      { command: "/lsp list", description: "list active LSP servers" },
      { command: "/lsp reload", description: "restart all configured LSP servers" },
      { command: "/lsp scope", description: "show whether LSP config is project or global" },
    ],
  },
  {
    key: "info",
    label: "Info",
    commands: [
      { command: "/cost", description: "show cost report" },
      { command: "/model", description: "show current model" },
      { command: "/update", description: "check for updates" },
      { command: "/hello", description: "send a voice note to the creator" },
    ],
  },
  {
    key: "commands",
    label: "Commands",
    commands: [
      { command: "/command create", description: "create a new custom slash command" },
      { command: "/command edit", description: "edit an existing custom command" },
      { command: "/command delete", description: "delete a custom command" },
      { command: "/command list", description: "list all custom commands" },
    ],
  },
  {
    key: "config",
    label: "Config",
    commands: [
      { command: "/init", description: "scan this repo and write an AGENTS.md" },
      { command: "/settings", description: "show feature settings" },
      { command: "/provider", description: "list LLM providers and which has a key" },
      { command: "/provider <id> [key]", description: "switch provider (openrouter, openai, deepseek, ollama, …)", selectable: false },
      { command: "/key", description: "show the active provider's key status (and credit, on OpenRouter)" },
      { command: "/key set <key>", description: "replace the active provider's key", selectable: false },
      { command: "/logout", description: "clear credentials" },
      { command: "/shell", description: "show current shell" },
      { command: "/shell auto", description: "auto-detect shell (default)" },
      { command: "/shell bash", description: "force bash" },
      { command: "/shell cmd", description: "force cmd.exe (Windows)" },
      { command: "/shell powershell", description: "force PowerShell" },
      { command: "filePicker", description: "enabled by default; disable with KIMIFLARE_FILE_PICKER=0 or filePicker: false in config", selectable: false },
    ],
  },
];

export const SINGLE_COMMANDS: CommandItem[] = [
  { command: "/reasoning", description: "toggle show/hide model reasoning" },
  { command: "/help", description: "show this menu" },
  { command: "/exit", description: "exit autopilot (formerly kimiflare)" },
];

export function HelpMenu({ customCommands, costAttributionEnabled, onDone, onCommand }: Props) {
  const theme = useTheme();
  const [page, setPage] = useState<Page>("main");
  const customs = customCommands ?? [];

  useInput((_input, key) => {
    if (key.escape) {
      if (page !== "main") {
        setPage("main");
      } else {
        onDone();
      }
    }
  });

  const handleSelect = (command: string) => {
    onCommand(command);
    onDone();
  };

  const categories = CATEGORIES;

  if (page === "main") {
    const items: { label: string; value: string; key: string }[] = categories.map((cat) => ({
      label: cat.label,
      value: cat.key,
      key: cat.key,
    }));
    if (customs.length > 0) {
      items.push({ label: "Run custom commands", value: "custom", key: "custom" });
    }
    items.push({ label: "(close)", value: "__close__", key: "__close__" });

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Help
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          Arrow keys to navigate, Enter to select, Esc to close.
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__close__") {
                onDone();
              } else {
                setPage(item.value as Page);
              }
            }}
          />
        </Box>
        <Box marginTop={1} flexDirection="column">
          {SINGLE_COMMANDS.map((cmd) => (
            <Text key={cmd.command} color={theme.info.color} dimColor={false}>
              {`  ${cmd.command.padEnd(20)} ${cmd.description}`}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color={theme.info.color} dimColor={false}>
            keys: ctrl-c interrupt/exit · ctrl-r toggle reasoning · ctrl-o verbose · ctrl-g run queued message now · shift+tab cycle mode · ↑/↓ history
          </Text>
        </Box>
      </Box>
    );
  }

  if (page === "custom") {
    const items = customs.map((c) => ({
      label: `${`/${c.name}`.padEnd(28)} ${c.description ?? ""}`.trimEnd(),
      value: `/${c.name}`,
      key: c.name,
    }));
    items.push({ label: "← Back", value: "__back__", key: "__back__" });

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
        <Text color={theme.accent} bold>
          Custom commands
        </Text>
        <Text color={theme.info.color} dimColor={false}>
          {customs.length === 0
            ? "no custom commands found in .kimiflare/commands/"
            : "Arrow keys to navigate, Enter to run, Esc to go back."}
        </Text>
        <Box marginTop={1}>
          <SelectInput
            items={items}
            onSelect={(item) => {
              if (item.value === "__back__") {
                setPage("main");
              } else {
                handleSelect(item.value as string);
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  const category = categories.find((c) => c.key === page)!;
  const selectable = category.commands.filter((cmd) => cmd.selectable !== false);
  const staticCmds = category.commands.filter((cmd) => cmd.selectable === false);

  const items = selectable.map((cmd) => ({
    label: `${cmd.command.padEnd(28)} ${cmd.description}`,
    value: cmd.command,
    key: cmd.command,
  }));
  items.push({ label: "← Back", value: "__back__", key: "__back__" });

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {category.label}
      </Text>
      <Text color={theme.info.color} dimColor={false}>
        Arrow keys to navigate, Enter to execute, Esc to go back.
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__back__") {
              setPage("main");
            } else {
              handleSelect(item.value as string);
            }
          }}
        />
      </Box>
      {staticCmds.length > 0 && (
        <Box marginTop={1} flexDirection="column">
          {staticCmds.map((cmd) => (
            <Text key={cmd.command} color={theme.info.color}>
              {`  ${cmd.command.padEnd(28)} ${cmd.description}`}
            </Text>
          ))}
        </Box>
      )}
    </Box>
  );
}
