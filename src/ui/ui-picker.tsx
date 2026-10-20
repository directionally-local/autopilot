import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import { useTheme } from "./theme-context.js";

export type UiEngineChoice = "ink";

interface Props {
  current: UiEngineChoice;
  onPick: (choice: UiEngineChoice | null) => void;
}

interface Item {
  label: string;
  value: UiEngineChoice | "__back__";
  description: string;
}

export function UiPicker({ current, onPick }: Props) {
  const theme = useTheme();
  const items: Item[] = [
    {
      label: "React Ink",
      value: "ink",
      description: "stable — current default",
    },
    { label: "< Back", value: "__back__", description: "" },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        Pick UI engine (takes effect on next launch)
      </Text>
      <Box marginTop={1}>
        <SelectInput<Item["value"]>
          items={items}
          initialIndex={items.findIndex((i) => i.value === current)}
          onSelect={(item) => {
            if (item.value === "__back__") {
              onPick(null);
              return;
            }
            onPick(item.value as UiEngineChoice);
          }}
          itemComponent={({ label, isSelected }: { label: string; isSelected?: boolean }) => {
            const item = items.find((i) => i.label === label);
            const desc = item?.description ?? "";
            return (
              <Box>
                <Text bold={isSelected} dimColor={!isSelected}>
                  {label}
                </Text>
                {desc ? (
                  <Text dimColor>{` — ${desc}`}</Text>
                ) : null}
              </Box>
            );
          }}
        />
      </Box>
    </Box>
  );
}
