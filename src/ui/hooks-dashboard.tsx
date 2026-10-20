import React, { useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useTheme } from "./theme-context.js";
import type { HookEvent, HookConfig } from "../hooks/types.js";
import { RECOMMENDED_HOOKS } from "../hooks/recommended.js";
import {
  setHookEnabled,
  appendHook,
  deriveHookId,
} from "../hooks/settings.js";
import { HooksWizard } from "./hooks-wizard.js";

/**
 * Interactive `/hooks` dashboard. Three sections in one screen:
 *
 *   1. Event glossary — explains what the five hook events mean,
 *      so the "Stop" / "PreToolUse" / etc. labels below are legible
 *      without the user reading the README.
 *   2. Configured + recommended list — arrow keys navigate, Enter
 *      toggles. A details panel below the list updates as the cursor
 *      moves, showing the hook's description + shell command preview.
 *   3. "Create custom hook" entry — for now opens a help screen that
 *      explains the schema and points at settings.json (a proper
 *      wizard is M6.1.x follow-up).
 *
 * Typing path still works — `/hooks enable <id>`, `/hooks recommended`,
 * etc. are honored by the slash-command dispatcher.
 */

const EVENT_EXPLANATIONS: Record<HookEvent, string> = {
  PreToolUse: "before every tool call — can veto (block) it",
  PostToolUse: "after every tool call — informational only",
  PostToolUseFailure: "after a tool call fails — informational only",
  PermissionRequest: "before you're asked to approve a call — can allow or deny it",
  UserPromptSubmit: "when you hit Enter — can veto the prompt",
  Stop: "when the agent finishes a turn — informational only",
  PreCompact: "before auto-compaction shrinks the conversation",
  SessionStart: "when a session starts or is resumed — informational only",
  SessionEnd: "when autopilot exits or the session is cleared — informational only",
};

interface ConfiguredEntry {
  event: HookEvent;
  hook: HookConfig;
}

export interface HooksDashboardProps {
  /**
   * Called every render to fetch the current list of configured hooks.
   * Passed as a callback (rather than a static `configured` array)
   * so the dashboard sees mutations immediately — when we toggle a
   * hook or run the wizard, `onMutate` reloads the HooksManager and
   * the next render calls this getter, picking up the fresh list.
   */
  getConfigured: () => ConfiguredEntry[];
  cwd: string;
  /** Called whenever the dashboard mutates settings.json so the
   *  caller can reload the HooksManager BEFORE the next render. */
  onMutate: () => void;
  /** Called when the user dismisses the dashboard. */
  onDone: () => void;
}

interface RowMeta {
  kind: "configured" | "recommended";
  event: HookEvent;
  id: string;
  description?: string;
  command: string;
  source?: string;
  enabled: boolean;
}

type RowValue =
  | { kind: "row"; meta: RowMeta }
  | { kind: "create" }
  | { kind: "done" };

interface SelectableRow {
  label: string;
  value: RowValue;
  key: string;
}

function tag(event: HookEvent): string {
  // Right-pad so the next column lines up.
  return `[${event}]`.padEnd(20);
}

/** Status badge with explicit symbol + word. Symbols are unambiguous
 *  even in monochrome terminals; the `ColoredRow` component below
 *  parses these strings and tints the badge segment green / red /
 *  dimmed for visual scanning. */
function statusBadge(meta: RowMeta): string {
  if (meta.kind === "configured") {
    return meta.enabled ? "[ ✓ enabled  ]" : "[ ✗ disabled ]";
  }
  return "[ + available ]";
}

/** Custom item renderer for SelectInput. Splits each row's label
 *  into "body + status badge" and colors the badge (green for
 *  enabled, red for disabled, dim for available). The whole row is
 *  highlighted when selected — same convention as the rest of the
 *  app's pickers. */
function ColoredRow({ isSelected, label }: { isSelected?: boolean; label: string }): React.ReactElement {
  // Splits "[Event]   id  [ ✓ enabled  ]" → ["[Event]   id  ", "[ ✓ enabled  ]"]
  const match = label.match(/^(.+?)(\[ [✓✗+] \w+\s*\])\s*$/);
  const baseColor = isSelected ? "cyan" : undefined;
  if (!match) {
    return <Text color={baseColor} bold={isSelected}>{label}</Text>;
  }
  const [, body, badge] = match;
  const badgeColor = badge!.includes("✓") ? "green" : badge!.includes("✗") ? "red" : undefined;
  return (
    <Text color={baseColor} bold={isSelected}>
      {body}
      <Text color={badgeColor} dimColor={badgeColor === undefined}>{badge}</Text>
    </Text>
  );
}

export function HooksDashboard(props: HooksDashboardProps): React.ReactElement {
  const theme = useTheme();
  const [message, setMessage] = useState<string | null>(null);
  const [version, setVersion] = useState(0);
  const [highlighted, setHighlighted] = useState<RowValue | null>(null);
  const [showWizard, setShowWizard] = useState(false);

  useInput((_input, key) => {
    // Wizard handles its own Esc (cancel + back-step navigation).
    if (showWizard) return;
    if (key.escape) props.onDone();
  });

  const configured = props.getConfigured();
  const items = useMemo<SelectableRow[]>(() => {
    const out: SelectableRow[] = [];
    const configuredIds = new Set(
      configured.map((c) => c.hook.id ?? deriveHookId(c.event, c.hook.command)),
    );

    // Configured first
    for (const c of configured) {
      const id = c.hook.id ?? deriveHookId(c.event, c.hook.command);
      const meta: RowMeta = {
        kind: "configured",
        event: c.event,
        id,
        description: c.hook.description,
        command: c.hook.command,
        source: c.hook.source,
        enabled: c.hook.enabled !== false,
      };
      out.push({
        label: `${tag(c.event)}${id.padEnd(28)}${statusBadge(meta)}`,
        value: { kind: "row", meta },
        key: `cfg-${id}`,
      });
    }

    // Recommended (skip already-configured)
    for (const r of RECOMMENDED_HOOKS) {
      if (configuredIds.has(r.id)) continue;
      const meta: RowMeta = {
        kind: "recommended",
        event: r.event,
        id: r.id,
        description: r.hook.description,
        command: r.hook.command,
        source: "recommended",
        enabled: false,
      };
      out.push({
        label: `${tag(r.event)}${r.id.padEnd(28)}${statusBadge(meta)}`,
        value: { kind: "row", meta },
        key: `rec-${r.id}`,
      });
    }

    out.push({
      label: "+ Create a custom hook …",
      value: { kind: "create" },
      key: "__create__",
    });
    out.push({ label: "← Done", value: { kind: "done" }, key: "__done__" });
    return out;
  }, [configured, version]);

  const handleSelect = (item: SelectableRow): void => {
    const v = item.value;
    if (v.kind === "done") {
      props.onDone();
      return;
    }
    if (v.kind === "create") {
      setShowWizard(true);
      return;
    }
    const meta = v.meta;
    if (meta.kind === "configured") {
      const path = setHookEnabled(props.cwd, meta.id, !meta.enabled);
      if (path) {
        props.onMutate();
        setMessage(`${!meta.enabled ? "enabled" : "disabled"} ${meta.id} in ${path}`);
        setVersion((n) => n + 1);
      }
    } else {
      // recommended → append + enable in project scope
      const rec = RECOMMENDED_HOOKS.find((r) => r.id === meta.id);
      if (!rec) return;
      let path: string;
      try {
        path = appendHook("project", props.cwd, rec.event, {
          ...rec.hook,
          enabled: true,
        });
      } catch (e) {
        setMessage(`could not enable ${rec.id}: ${(e as Error).message}`);
        return;
      }
      props.onMutate();
      setMessage(`enabled ${rec.id} (${rec.event}) → ${path}`);
      setVersion((n) => n + 1);
    }
  };

  // Wizard owns the screen while it's open — handles its own Esc /
  // back-step navigation. Returns here on save (with the new hook
  // info to surface) or on cancel (silent close).
  if (showWizard) {
    return (
      <HooksWizard
        cwd={props.cwd}
        onSaved={(info) => {
          props.onMutate();
          setShowWizard(false);
          setVersion((n) => n + 1);
          setMessage(`saved ${info.id} (${info.event}) → ${info.path}`);
        }}
        onCancel={() => setShowWizard(false)}
      />
    );
  }

  // Description shown under the list for the currently-highlighted row.
  const focus = highlighted ?? items[0]?.value ?? null;
  const focusMeta = focus && focus.kind === "row" ? focus.meta : null;

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        Hooks
      </Text>
      <Text color={theme.info.color} dimColor>
        Arrow keys to navigate. Enter to toggle. Esc when done.
      </Text>

      {/* Action toast — placed right under the title so the user sees
          "✓ enabled stop-bell" instantly after pressing Enter without
          having to scroll past the list. */}
      {message && (
        <Box marginTop={1} paddingX={1} borderStyle="single" borderColor="green">
          <Text color="green" bold>✓ {message}</Text>
        </Box>
      )}

      {/* Event glossary — makes the [Stop] / [PreToolUse] tags legible. */}
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.info.color} dimColor>Events:</Text>
        <Text>  <Text bold>PreToolUse</Text>       — {EVENT_EXPLANATIONS.PreToolUse}</Text>
        <Text>  <Text bold>PostToolUse</Text>      — {EVENT_EXPLANATIONS.PostToolUse}</Text>
        <Text>  <Text bold>PostToolUseFailure</Text> — {EVENT_EXPLANATIONS.PostToolUseFailure}</Text>
        <Text>  <Text bold>PermissionRequest</Text> — {EVENT_EXPLANATIONS.PermissionRequest}</Text>
        <Text>  <Text bold>UserPromptSubmit</Text> — {EVENT_EXPLANATIONS.UserPromptSubmit}</Text>
        <Text>  <Text bold>Stop</Text>             — {EVENT_EXPLANATIONS.Stop}</Text>
        <Text>  <Text bold>PreCompact</Text>       — {EVENT_EXPLANATIONS.PreCompact}</Text>
      </Box>

      {configured.length === 0 && (
        <Box marginTop={1}>
          <Text color={theme.info.color} dimColor>
            No hooks configured yet. Pick a recommended one below — or create your own.
          </Text>
        </Box>
      )}

      <Box marginTop={1}>
        <SelectInput
          items={items as never}
          itemComponent={ColoredRow as never}
          onSelect={(it) => handleSelect(it as SelectableRow)}
          onHighlight={(it) => setHighlighted((it as SelectableRow).value)}
        />
      </Box>

      {/* Details for the highlighted row — what it does, what it'll run. */}
      {focusMeta && (
        <Box marginTop={1} flexDirection="column" borderStyle="single" borderColor={theme.info.color} paddingX={1}>
          <Text>
            <Text color={theme.info.color} dimColor>id:    </Text>
            <Text bold>{focusMeta.id}</Text>
            <Text color={theme.info.color} dimColor>   event: </Text>
            <Text>{focusMeta.event}</Text>
            <Text color={theme.info.color} dimColor>   source: </Text>
            <Text>{focusMeta.source ?? "—"}</Text>
          </Text>
          {focusMeta.description && (
            <Text>
              <Text color={theme.info.color} dimColor>what:  </Text>
              {focusMeta.description}
            </Text>
          )}
          <Text>
            <Text color={theme.info.color} dimColor>runs:  </Text>
            <Text>{focusMeta.command.length > 100 ? focusMeta.command.slice(0, 100) + "…" : focusMeta.command}</Text>
          </Text>
          <Text>
            <Text color={theme.info.color} dimColor>action: </Text>
            <Text color={theme.accent}>
              Enter to {focusMeta.kind === "configured"
                ? focusMeta.enabled ? "disable" : "re-enable"
                : "enable (adds to project settings.json)"}
            </Text>
          </Text>
        </Box>
      )}

    </Box>
  );
}
