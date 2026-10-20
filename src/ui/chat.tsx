import React, { useRef } from "react";
import { Box, Static, Text } from "ink";
import Spinner from "./spinner.js";
import { ToolView, type ToolEventState } from "./tool-view.js";
import { MD } from "./markdown.js";
import { useTheme } from "./theme-context.js";
import type { Theme } from "./theme.js";
import { humanizeInfo, humanizeMemory, humanizeMeta, type IntentTier } from "./narrator.js";
import { ApiErrorMessage } from "./api-error-message.js";

export type ChatEvent =
  | { kind: "user"; key: string; text: string; images?: string[]; queued?: boolean }
  | {
      kind: "assistant";
      key: string;
      id: number;
      text: string;
      reasoning: string;
      streaming: boolean;
    }
  | ({ kind: "tool"; key: string } & ToolEventState)
  | { kind: "info"; key: string; text: string; pending?: boolean }
  | { kind: "error"; key: string; text: string }
  | { kind: "jev"; key: string; result: string; probability?: string; tone: "yes" | "no" | "neutral"; receipt: string }
  | { kind: "memory"; key: string; text: string }
  | {
      kind: "meta";
      key: string;
      intentTier?: "light" | "medium" | "heavy";
      skillsActive?: number;
      memoryRecalled?: boolean;
    }
  | {
      kind: "api_error";
      key: string;
      httpStatus?: number;
      code?: number;
      message: string;
      /** The active provider's status page, when it has one. */
      statusUrl?: string;
    }
  | {
      kind: "qrcode";
      key: string;
      lines: string[];
      caption: string;
    };

interface Props {
  events: ChatEvent[];
  showReasoning: boolean;
  verbose?: boolean;
  intentTier?: IntentTier;
}

function toolSignature(name: string, args: string): string {
  return `${name}:${args}`;
}

/** An event is settled once nothing about it will change on screen. */
export function isSettled(e: ChatEvent): boolean {
  if (e.kind === "assistant") return !e.streaming;
  if (e.kind === "tool") return e.status !== "running" && e.status !== "queued";
  if (e.kind === "user") return !e.queued;
  if (e.kind === "info") return !e.pending;
  return true;
}

export function firstUnsettledIndex(events: ChatEvent[]): number {
  const i = events.findIndex((e) => !isSettled(e));
  return i === -1 ? events.length : i;
}

/**
 * <Static> only prints items past the count it has already printed. When the
 * event list is replaced (/clear, /resume, compaction), remount it by bumping
 * its key so the new list prints from the start instead of being skipped.
 */
function useStaticGeneration(events: ChatEvent[]): number {
  const ref = useRef({ generation: 0, length: 0, firstKey: undefined as string | undefined });
  const firstKey = events[0]?.key;
  const r = ref.current;
  if (events.length < r.length || (r.firstKey !== undefined && firstKey !== r.firstKey)) {
    r.generation++;
  }
  r.length = events.length;
  r.firstKey = firstKey;
  return r.generation;
}

export const ChatView = React.memo(function ChatView({ events, showReasoning, verbose, intentTier }: Props) {
  const theme = useTheme();

  // Detect repetitive tool calls in this turn (≥3 identical signatures)
  const toolCounts = new Map<string, number>();
  for (const e of events) {
    if (e.kind === "tool") {
      const sig = toolSignature(e.name, e.args);
      toolCounts.set(sig, (toolCounts.get(sig) ?? 0) + 1);
    }
  }
  const repeatedSigs = new Set<string>();
  for (const [sig, count] of toolCounts) {
    if (count >= 3) repeatedSigs.add(sig);
  }

  // Only the most recent assistant message should show a streaming spinner.
  let lastAssistantIndex = -1;
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]!.kind === "assistant") {
      lastAssistantIndex = i;
      break;
    }
  }

  const renderEvent = (e: ChatEvent, i: number) => {
    const prev = events[i - 1];
    const showSeparator = !!(
      prev &&
      ((e.kind === "user" && prev.kind !== "user") ||
        (e.kind === "assistant" && prev.kind !== "assistant" && prev.kind !== "tool"))
    );
    return (
      <Box key={e.key} flexDirection="column">
        {showSeparator && (
          <Box marginY={1}>
            <Text color={theme.info.color}>
              {"─".repeat(40)}
            </Text>
          </Box>
        )}
        <EventView evt={e} showReasoning={showReasoning} verbose={verbose} repeatedSigs={repeatedSigs} intentTier={intentTier} isLastAssistant={i === lastAssistantIndex} />
      </Box>
    );
  };

  // Everything before the first unsettled event is final: Ink prints it once
  // through <Static> and never lays it out again. Only the tail stays in the
  // live tree, so each re-render costs the same at minute 1 and at hour 27.
  const split = firstUnsettledIndex(events);
  const generation = useStaticGeneration(events);

  return (
    <>
      <Static key={generation} items={events.slice(0, split)}>
        {(e, i) => renderEvent(e, i)}
      </Static>
      <Box flexDirection="column">
        {events.slice(split).map((e, j) => renderEvent(e, split + j))}
      </Box>
    </>
  );
});

const EventView = React.memo(function EventView({
  evt,
  showReasoning,
  verbose,
  repeatedSigs,
  intentTier,
  isLastAssistant,
}: {
  evt: ChatEvent;
  showReasoning: boolean;
  verbose?: boolean;
  repeatedSigs?: Set<string>;
  intentTier?: IntentTier;
  isLastAssistant?: boolean;
}) {
  const theme = useTheme();
  if (evt.kind === "user") {
    if (evt.queued) {
      const mutedColor = theme.muted?.color ?? theme.info.color;
      return (
        <Box flexDirection="column">
          <Box>
            <Text italic color={mutedColor}>
              ···{" "}
            </Text>
            <Text italic color={mutedColor}>
              {evt.text}
            </Text>
            <Text italic color={mutedColor}>
              {" "}(queued)
            </Text>
          </Box>
        </Box>
      );
    }
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color={theme.user}>
            You:{" "}
          </Text>
          <Text bold>{evt.text}</Text>
        </Box>
        {evt.images && evt.images.length > 0 && (
          <Box paddingLeft={2}>
            <Text color={theme.info.color}>
              🖼️ {evt.images.join(", ")}
            </Text>
          </Box>
        )}
      </Box>
    );
  }
  if (evt.kind === "assistant") {
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color={theme.assistant ?? theme.info.color}>
            autopilot:{" "}
          </Text>
          <Box flexDirection="column">
            {showReasoning && evt.reasoning ? (
              <Box flexDirection="column" marginBottom={1}>
                <Text color={theme.reasoning.color}>
                  thinking…{" "}
                  {evt.reasoning.length > 400 ? evt.reasoning.slice(0, 400) + "…" : evt.reasoning}
                </Text>
              </Box>
            ) : null}
            {evt.text ? <MD text={evt.text} /> : null}
            {evt.streaming && isLastAssistant && (
              <Text color={theme.spinner}>
                <Spinner type="dots" />
              </Text>
            )}
          </Box>
        </Box>
      </Box>
    );
  }
  if (evt.kind === "tool") {
    const isRepeated = repeatedSigs?.has(toolSignature(evt.name, evt.args)) ?? false;
    return <ToolView evt={evt} verbose={verbose} isRepeated={isRepeated} intentTier={intentTier} />;
  }
  if (evt.kind === "info") {
    const isSubagentHint = /^(Subagent policy|Subagent suggestion):/.test(evt.text);
    return (
      <Text
        color={isSubagentHint ? (theme.muted?.color ?? theme.info.color) : theme.info.color}
        dimColor={isSubagentHint || undefined}
      >
        · {humanizeInfo(evt.text, intentTier)}
      </Text>
    );
  }
  if (evt.kind === "jev") {
    const resultColor = evt.tone === "yes"
      ? theme.palette.success
      : evt.tone === "no"
        ? theme.warn
        : theme.accent;
    const mutedColor = theme.muted?.color ?? theme.info.color;
    return (
      <Box flexDirection="column">
        <Box>
          <Text bold color={theme.accent}>Jev</Text>
          <Text>  </Text>
          <Text bold color={resultColor}>{evt.result}</Text>
          {evt.probability && <Text color={theme.accent}> {evt.probability}</Text>}
          <Text color={mutedColor} dimColor>  · estimate, not verified</Text>
        </Box>
        <Text color={mutedColor} dimColor>  {evt.receipt}</Text>
      </Box>
    );
  }
  if (evt.kind === "memory") {
    return (
      <Text color={theme.info.color}>
        ◈ {humanizeMemory(evt.text, intentTier)}
      </Text>
    );
  }
  if (evt.kind === "meta") {
    const metaParts: { label: string; value?: string | number }[] = [];
    if (evt.skillsActive !== undefined && evt.skillsActive > 0) {
      metaParts.push({ label: `skill${evt.skillsActive === 1 ? "" : "s"} ready`, value: evt.skillsActive });
    }
    if (evt.memoryRecalled) {
      metaParts.push({ label: "memory recalled" });
    }
    const metaText = humanizeMeta(metaParts, intentTier ?? evt.intentTier);
    if (!metaText) return null;
    return (
      <Text color={theme.info.color} dimColor>
        {metaText}
      </Text>
    );
  }
  if (evt.kind === "api_error") {
    return (
      <ApiErrorMessage
        httpStatus={evt.httpStatus}
        code={evt.code}
        message={evt.message}
        statusUrl={evt.statusUrl}
      />
    );
  }
  if (evt.kind === "qrcode") {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text color={theme.info.color}>{evt.caption}</Text>
        <Box flexDirection="column" marginTop={1}>
          {evt.lines.map((line, i) => (
            <Text key={i}>{line}</Text>
          ))}
        </Box>
      </Box>
    );
  }
  return (
    <Text color={theme.error}>
      ! {evt.text}
    </Text>
  );
});
