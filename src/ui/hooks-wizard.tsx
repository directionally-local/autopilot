import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { CustomTextInput } from "./text-input.js";
import { useTheme } from "./theme-context.js";
import type { HookEvent, HookConfig } from "../hooks/types.js";
import { appendHook } from "../hooks/settings.js";

/**
 * Multi-step wizard for creating a new user hook. Reached from the
 * `<HooksDashboard>` "+ Create a custom hook" entry.
 *
 * Steps:
 *   1. event   — which lifecycle moment does this fire on?
 *   2. matcher — (only for tool events) regex on tool name; optional
 *   3. command — the shell command to run; required
 *   4. id      — stable handle; optional (auto-derived)
 *   5. description — optional one-liner shown in /hooks list
 *   6. scope   — project (.kimiflare/) vs global (~/.config/kimiflare/)
 *   7. review  — confirm + write
 *
 * Esc backs out to the previous step; from step 1, Esc cancels the
 * whole wizard.
 */

type Step =
  | "event"
  | "matcher"
  | "command"
  | "id"
  | "description"
  | "scope"
  | "review";

const TOOL_EVENTS = new Set<HookEvent>(["PreToolUse", "PostToolUse"]);

export const EVENT_DESCRIPTIONS: Record<HookEvent, string> = {
  PreToolUse: "before every tool call — can VETO (block) it",
  PostToolUse: "after every tool call — informational only",
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
    `echo "$(date -u +%FT%TZ) $AUTOPILOT_HOOK_TOOL $AUTOPILOT_HOOK_RESULT_OK" >> ~/.local/state/kimiflare/tool-audit.log`,
  ],
  UserPromptSubmit: [
    `# Block prompts that contain "password":`,
    `jq -r .prompt | grep -qiv password || { echo "no passwords in prompts" >&2; exit 2; }`,
    ``,
    `# Log every prompt with its tier:`,
    `echo "[$AUTOPILOT_HOOK_TIER] $(jq -r .prompt)" >> ~/.local/state/kimiflare/prompts.log`,
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
    `mkdir -p ~/snapshots && cp ~/.config/kimiflare/sessions/$AUTOPILOT_HOOK_SESSION_ID.json ~/snapshots/`,
  ],
  SessionStart: [
    `# Record session starts:`,
    `echo "$(date -u +%FT%TZ) start $AUTOPILOT_HOOK_SESSION_ID" >> ~/.local/state/kimiflare/sessions.log`,
  ],
  SessionEnd: [
    `# Record session ends:`,
    `echo "$(date -u +%FT%TZ) end $AUTOPILOT_HOOK_SESSION_ID" >> ~/.local/state/kimiflare/sessions.log`,
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

export interface HooksWizardProps {
  cwd: string;
  /** Called after the new hook is written so the manager re-loads. */
  onSaved: (info: { event: HookEvent; id: string; path: string }) => void;
  /** Called when the user cancels the whole wizard. */
  onCancel: () => void;
}

export function HooksWizard(props: HooksWizardProps): React.ReactElement {
  const theme = useTheme();
  const [step, setStep] = useState<Step>("event");
  const [event, setEvent] = useState<HookEvent | null>(null);
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const [id, setId] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<"project" | "global">("project");
  const [error, setError] = useState<string | null>(null);

  // Esc handler — back up a step, cancel from step 1.
  useInput((_input, key) => {
    if (!key.escape) return;
    setError(null);
    if (step === "event") {
      props.onCancel();
      return;
    }
    if (step === "matcher") {
      setStep("event");
      return;
    }
    if (step === "command") {
      setStep(event && TOOL_EVENTS.has(event) ? "matcher" : "event");
      return;
    }
    if (step === "id") {
      setStep("command");
      return;
    }
    if (step === "description") {
      setStep("id");
      return;
    }
    if (step === "scope") {
      setStep("description");
      return;
    }
    if (step === "review") {
      setStep("scope");
      return;
    }
  });

  // ── Step renderers ────────────────────────────────────────────────────

  if (step === "event") {
    const items = (Object.keys(EVENT_DESCRIPTIONS) as HookEvent[]).map((ev) => ({
      label: `${ev.padEnd(20)} — ${EVENT_DESCRIPTIONS[ev]}`,
      value: ev,
      key: ev,
    }));
    return (
      <WizardFrame
        title="Create hook · step 1 of 6: pick the event"
        hint="The lifecycle moment that fires your command."
        error={error}
      >
        <SelectInput
          items={items}
          onSelect={(it) => {
            setEvent(it.value);
            setStep(TOOL_EVENTS.has(it.value) ? "matcher" : "command");
          }}
        />
      </WizardFrame>
    );
  }

  if (step === "matcher") {
    return (
      <WizardFrame
        title={`Create hook · step 2 of 6: matcher (optional)`}
        hint={
          `Regex tested against the tool name. Blank = match every tool.\n\n` +
          `Common patterns:\n` +
          MATCHER_EXAMPLES.map((s) => `  ${s}`).join("\n")
        }
        error={error}
      >
        <Box marginBottom={1}>
          <Text color={theme.info.color} dimColor>Your matcher: </Text>
        </Box>
        <CustomTextInput
          value={matcher}
          onChange={setMatcher}
          onSubmit={(v) => {
            const trimmed = v.trim();
            if (trimmed) {
              try {
                new RegExp(trimmed);
              } catch (e) {
                setError(`invalid regex: ${(e as Error).message}`);
                return;
              }
            }
            setMatcher(trimmed);
            setError(null);
            setStep("command");
          }}
          focus
        />
        <Text color={theme.info.color} dimColor>
          Enter (even if blank) to continue · Esc to go back
        </Text>
      </WizardFrame>
    );
  }

  if (step === "command") {
    const stepNum = TOOL_EVENTS.has(event!) ? 3 : 2;
    const examples = EVENT_COMMAND_EXAMPLES[event!];
    return (
      <WizardFrame
        title={`Create hook · step ${stepNum} of 6: shell command`}
        hint={
          `A POSIX shell command (zsh / bash compatible). Required.\n` +
          `Runs every time the ${event} event fires${matcher ? ` and the tool name matches /${matcher}/` : ""}.\n\n` +
          `Available env vars in your command (also as KIMIFLARE_HOOK_*):\n` +
          `  $AUTOPILOT_HOOK_EVENT     — the event name (${event})\n` +
          (TOOL_EVENTS.has(event!) ? `  $AUTOPILOT_HOOK_TOOL      — the tool being called\n` : "") +
          (TOOL_EVENTS.has(event!) ? `  $AUTOPILOT_HOOK_PATH      — the path arg, when the tool takes one\n` : "") +
          `  $AUTOPILOT_HOOK_TIER      — light | medium | heavy (when classified)\n` +
          `  $AUTOPILOT_HOOK_SESSION_ID — id of the current session\n` +
          `  stdin                     — the full JSON event payload (also $AUTOPILOT_HOOK_PAYLOAD when under 32 KB)` +
          (event === "PreToolUse" || event === "UserPromptSubmit"
            ? `\n\nNote: this is a VETO event — \`exit 2\` cancels the ${event === "PreToolUse" ? "tool call" : "prompt"}; stderr becomes the\nreason shown to the model.` +
              (event === "PreToolUse"
                ? ` Or exit 0 and print {"hookSpecificOutput":{"permissionDecision":"deny"|"ask"|"allow",\n"permissionDecisionReason":"..."}}.`
                : ` Or exit 0 and print {"decision":"block","reason":"..."}.`) +
              `\nAny other non-zero exit, a timeout or a missing command only logs a warning\nand lets it through (fail-open).`
            : "")
        }
        error={error}
      >
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.info.color} dimColor>
            ── Examples (copy / adapt) ─────────────────────────────
          </Text>
          {examples.map((line, i) => (
            <Text key={i} color={line.startsWith("#") ? theme.info.color : undefined} dimColor={line.startsWith("#")}>
              {line || " "}
            </Text>
          ))}
          <Text color={theme.info.color} dimColor>
            ────────────────────────────────────────────────────────
          </Text>
        </Box>
        <Box>
          <Text color={theme.info.color} dimColor>Your command: </Text>
        </Box>
        <CustomTextInput
          value={command}
          onChange={setCommand}
          onSubmit={(v) => {
            const trimmed = v.trim();
            if (!trimmed) {
              setError("command is required — paste / adapt one of the examples above");
              return;
            }
            setCommand(trimmed);
            setError(null);
            setStep("id");
          }}
          focus
        />
        <Text color={theme.info.color} dimColor>
          Enter to continue · Esc to go back
        </Text>
      </WizardFrame>
    );
  }

  if (step === "id") {
    const stepNum = TOOL_EVENTS.has(event!) ? 4 : 3;
    return (
      <WizardFrame
        title={`Create hook · step ${stepNum} of 6: id (optional)`}
        hint={
          `Stable handle for /hooks enable|disable. Leave blank to auto-\n` +
          `derive from event+command (8 hex chars).`
        }
        error={error}
      >
        <CustomTextInput
          value={id}
          onChange={setId}
          onSubmit={(v) => {
            setId(v.trim());
            setError(null);
            setStep("description");
          }}
          focus
        />
        <Text color={theme.info.color} dimColor>
          Enter to continue · Esc to go back
        </Text>
      </WizardFrame>
    );
  }

  if (step === "description") {
    const stepNum = TOOL_EVENTS.has(event!) ? 5 : 4;
    return (
      <WizardFrame
        title={`Create hook · step ${stepNum} of 6: description (optional)`}
        hint="One-line summary shown by /hooks list."
        error={error}
      >
        <CustomTextInput
          value={description}
          onChange={setDescription}
          onSubmit={(v) => {
            setDescription(v.trim());
            setError(null);
            setStep("scope");
          }}
          focus
        />
        <Text color={theme.info.color} dimColor>
          Enter to continue · Esc to go back
        </Text>
      </WizardFrame>
    );
  }

  if (step === "scope") {
    const stepNum = TOOL_EVENTS.has(event!) ? 6 : 5;
    return (
      <WizardFrame
        title={`Create hook · step ${stepNum} of 6: scope`}
        hint={
          `project — lives in this repo's .autopilot/settings.json (commit it\n` +
          `          to share with teammates)\n` +
          `global  — lives in ~/.config/autopilot/settings.json (applies to\n` +
          `          every project)`
        }
        error={error}
      >
        <SelectInput
          items={[
            { label: "project (.autopilot/settings.json)", value: "project" as const, key: "project" },
            { label: "global  (~/.config/autopilot/settings.json)", value: "global" as const, key: "global" },
          ]}
          onSelect={(it) => {
            setScope(it.value);
            setStep("review");
          }}
        />
      </WizardFrame>
    );
  }

  // review + save
  const draft: HookConfig = {
    command,
    ...(matcher ? { matcher } : {}),
    ...(id ? { id } : {}),
    ...(description ? { description } : {}),
    enabled: true,
  };

  return (
    <WizardFrame
      title="Create hook · step 6 of 6: review + save"
      hint="Enter on 'Save' to write to settings.json. Esc to go back."
      error={error}
    >
      <Box marginTop={1} flexDirection="column">
        <Text><Text color={theme.info.color} dimColor>event:       </Text>{event}</Text>
        {matcher && <Text><Text color={theme.info.color} dimColor>matcher:     </Text>{matcher}</Text>}
        <Text><Text color={theme.info.color} dimColor>command:     </Text>{command}</Text>
        {id && <Text><Text color={theme.info.color} dimColor>id:          </Text>{id}</Text>}
        {description && <Text><Text color={theme.info.color} dimColor>description: </Text>{description}</Text>}
        <Text><Text color={theme.info.color} dimColor>scope:       </Text>{scope}</Text>
      </Box>
      <Box marginTop={1}>
        <SelectInput
          items={[
            { label: "✓ Save", value: "save", key: "save" },
            { label: "✗ Cancel", value: "cancel", key: "cancel" },
          ]}
          onSelect={(it) => {
            if (it.value === "cancel") {
              props.onCancel();
              return;
            }
            try {
              const path = appendHook(scope, props.cwd, event!, draft);
              props.onSaved({ event: event!, id: id || draft.command.slice(0, 8), path });
            } catch (e) {
              setError(`save failed: ${(e as Error).message}`);
            }
          }}
        />
      </Box>
    </WizardFrame>
  );
}

// ── Tiny frame component used by every step ──────────────────────────────

function WizardFrame(props: {
  title: string;
  hint?: string;
  error?: string | null;
  children: React.ReactNode;
}): React.ReactElement {
  const theme = useTheme();
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {props.title}
      </Text>
      {props.hint && (
        <Box marginTop={1} flexDirection="column">
          {props.hint.split("\n").map((line, i) => (
            <Text key={i} color={theme.info.color} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1} flexDirection="column">
        {props.children}
      </Box>
      {props.error && (
        <Box marginTop={1}>
          <Text color={theme.palette.error}>{props.error}</Text>
        </Box>
      )}
    </Box>
  );
}
