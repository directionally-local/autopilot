import React, { useState, useCallback } from "react";
import { Box, Text, useInput } from "ink";
import { platform } from "node:os";
import type { ToolSpec } from "../tools/registry.js";
import type { PermissionDecision, PermissionDecisionResult } from "../tools/executor.js";
import { DiffView } from "./diff-view.js";
import { CustomTextInput } from "./text-input.js";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";

interface Props {
  tool: ToolSpec;
  args: Record<string, unknown>;
  onDecide: (decision: PermissionDecision) => void;
  onFeedback?: (text: string) => void;
}

/**
 * Three user-visible choices, each carrying the typed result the
 * executor will see. Built off the M2.2 `PermissionDecisionResult`
 * shape — `decision` and `scope` are now orthogonal so M6.2 can layer
 * pattern allowlists in front of the modal without changing the modal's
 * output type.
 */
const OPTIONS: { value: PermissionDecisionResult; label: string; key: number }[] = [
  { value: { decision: "allow", scope: "once" }, label: "Allow once", key: 1 },
  { value: { decision: "allow", scope: "session" }, label: "Allow for this session", key: 2 },
  { value: { decision: "deny", scope: "once" }, label: "Something else", key: 3 },
];

const DENY: PermissionDecisionResult = { decision: "deny", scope: "once" };

const MOD_KEY = platform() === "darwin" ? "\u2325" : "Alt";

function formatSelection(label: string, shortcut: number): string {
  return `${label}  [${MOD_KEY}+${shortcut}]`;
}

export function PermissionModal({ tool, args, onDecide, onFeedback }: Props) {
  const theme = useTheme();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [showHelp, setShowHelp] = useState(false);
  const [feedbackActive, setFeedbackActive] = useState(false);
  const [feedbackValue, setFeedbackValue] = useState("");

  let render: { title?: string; body?: string; diff?: { path: string; before: string; after: string } } | undefined;
  try {
    render = tool.render?.(args);
  } catch {
    // Malformed args from the model can crash typed render functions.
    // Fall back to raw JSON display below.
  }

  const handleSelect = useCallback(
    (index: number) => {
      const opt = OPTIONS[index];
      if (!opt) return;
      if (opt.value.decision === "deny") {
        if (onFeedback) {
          setFeedbackActive(true);
        } else {
          onDecide(DENY);
        }
      } else {
        onDecide(opt.value);
      }
    },
    [onDecide, onFeedback],
  );

  const handleFeedbackSubmit = useCallback(
    (text: string) => {
      // The feedback rides on the decision (for the session trace) and is
      // also submitted as the next user message.
      onDecide(text.trim() ? { ...DENY, feedback: text.trim() } : DENY);
      if (text.trim()) {
        onFeedback?.(text);
      }
      setFeedbackActive(false);
      setFeedbackValue("");
    },
    [onDecide, onFeedback],
  );

  const handleFeedbackCancel = useCallback(() => {
    onDecide(DENY);
    setFeedbackActive(false);
    setFeedbackValue("");
  }, [onDecide]);

  useInput(
    (inputChar, key) => {
      if (showHelp) {
        setShowHelp(false);
        return;
      }

      // Direct selection via Alt+1-3
      if (key.meta && inputChar === "1") {
        handleSelect(0);
        return;
      }
      if (key.meta && inputChar === "2") {
        handleSelect(1);
        return;
      }
      if (key.meta && inputChar === "3") {
        handleSelect(2);
        return;
      }

      // Navigation
      if (key.upArrow || inputChar === "k") {
        setSelectedIndex((i) => Math.max(0, i - 1));
        return;
      }
      if (key.downArrow || inputChar === "j") {
        setSelectedIndex((i) => Math.min(OPTIONS.length - 1, i + 1));
        return;
      }

      // Confirm
      if (key.return) {
        handleSelect(selectedIndex);
        return;
      }

      // Help
      if (inputChar === "?") {
        setShowHelp(true);
        return;
      }

      // Escape cancels
      if (key.escape) {
        onDecide(DENY);
      }
    },
    { isActive: !feedbackActive },
  );

  if (showHelp) {
    return (
      <Box flexDirection="column" borderStyle="round" borderColor={theme.permission} paddingX={1}>
        <Text color={theme.permission} bold>
          Permission modal — keyboard shortcuts
        </Text>
        <Text color={theme.info.color}>↑ / ↓ or j / k — navigate options</Text>
        <Text color={theme.info.color}>{MOD_KEY}+1 / {MOD_KEY}+2 / {MOD_KEY}+3 — select option directly</Text>
        <Text color={theme.info.color}>Enter — confirm selection</Text>
        <Text color={theme.info.color}>Esc — deny and close</Text>
        <Text color={theme.info.color}>? — toggle this help</Text>
        <Text color={theme.info.color}>When feedback input is open:</Text>
        <Text color={theme.info.color}>  Enter — submit feedback and deny</Text>
        <Text color={theme.info.color}>  Esc — deny without feedback</Text>
        <Box marginTop={1}>
          <Text color={theme.accent}>Press any key to close</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.permission} paddingX={1}>
      <Text color={theme.permission} bold>
        Permission requested
      </Text>
      <Text>
        tool: <Text color={theme.tool}>{tool.name}</Text>
      </Text>
      {render?.title ? <Text>action: {render.title}</Text> : null}
      {render?.diff ? (
        <Box marginTop={1} flexDirection="column">
          <DiffView {...render.diff} />
        </Box>
      ) : (
        <Text color={theme.info.color}>args: {JSON.stringify(args)}</Text>
      )}

      <Box marginTop={1} flexDirection="column">
        {OPTIONS.map((opt, i) => (
          <Text
            key={`${opt.value.decision}_${opt.value.scope}`}
            color={i === selectedIndex ? theme.accent : undefined}
            bold={i === selectedIndex}
          >
            {i === selectedIndex ? "› " : "  "}
            {formatSelection(opt.label, opt.key)}
          </Text>
        ))}
      </Box>

      {feedbackActive && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.palette.error}>
            Tell me what to do instead
          </Text>
          <Text color={theme.info.color} dimColor>
            Press Esc to deny without feedback
          </Text>
          <CustomTextInput
            value={feedbackValue}
            onChange={setFeedbackValue}
            onSubmit={handleFeedbackSubmit}
            onCancel={handleFeedbackCancel}
            focus
          />
        </Box>
      )}
    </Box>
  );
}
