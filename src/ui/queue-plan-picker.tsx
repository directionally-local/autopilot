import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import { useTheme } from "./theme-context.js";
import type { QueuedPrompt } from "../agent/queue-batch.js";

export type QueuePlanChoice = "group" | "separate" | null;

interface Props {
  prompts: QueuedPrompt[];
  onPick: (choice: QueuePlanChoice) => void;
}

export function QueuePlanPicker({ prompts, onPick }: Props) {
  const theme = useTheme();
  useInput((input, key) => {
    if (input === "q" || key.escape) onPick(null);
  });

  const previewPrompts = queuePlanPreview(prompts);
  const items = [
    { label: `▸ Group ${previewPrompts.length} follow-ups into one coordinated turn`, value: "group" as const },
    { label: "▸ Keep separate and continue the FIFO queue", value: "separate" as const },
    { label: "▸ Cancel and leave the queue unchanged", value: "cancel" as const },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        Coordinate queued follow-ups?
      </Text>
      <Text color={theme.info.color}>
        Grouping asks the coordinator to identify dependencies, handle the items together, and delegate independent research only when useful.
      </Text>
      <Box flexDirection="column" marginTop={1} marginBottom={1}>
        {previewPrompts.map((prompt, index) => (
          <Text key={prompt.key}>
            <Text color={theme.accent}>{index + 1}.</Text> {preview(prompt.text)}
          </Text>
        ))}
      </Box>
      <Text color={theme.info.color}>
        Worker calls still require permission. Grouping does not authorize parallel edits.
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => onPick(item.value === "cancel" ? null : item.value)}
          onHighlight={() => {}}
        />
      </Box>
      <Text color={theme.info.color}>Arrow keys + Enter · q / Esc: cancel</Text>
    </Box>
  );
}

/** The individual follow-ups a `/queue plan` covers (a grouped batch counts
 *  as its parts). Shared with the Camouflage view. */
export function queuePlanPreview(prompts: QueuedPrompt[]): { key: string; text: string }[] {
  return prompts.flatMap((prompt) =>
    prompt.batchPrompts
      ? prompt.batchPrompts.map((text, index) => ({ key: `${prompt.key}-${index}`, text }))
      : [{ key: prompt.key, text: prompt.display }],
  );
}

function preview(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > 110 ? `${singleLine.slice(0, 107)}…` : singleLine;
}
