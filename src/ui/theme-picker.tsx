import React from "react";
import { Box, Text } from "ink";
import SelectInput from "ink-select-input";
import type { Theme } from "./theme.js";
import { useTheme } from "./theme-context.js";

interface Props {
  themes: Theme[];
  onPick: (theme: Theme | null) => void;
}

function PaletteSwatches({ palette }: { palette: Theme["palette"] }) {
  const colors = [
    palette.primary,
    palette.secondary,
    palette.success,
    palette.error,
  ];
  return (
    <Box>
      {colors.map((c, i) => (
        <Text key={i} color={c}>
          █
        </Text>
      ))}
    </Box>
  );
}

export function ThemePicker({ themes, onPick }: Props) {
  const current = useTheme();
  const items = [
    ...themes.map((t) => ({ label: t.label, value: t.name })),
    { label: "< Back", value: "__back__" },
  ];

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={current.accent} paddingX={1}>
      <Text color={current.accent} bold>
        Pick a theme (restart to apply)
      </Text>
      <Box marginTop={1}>
        <SelectInput
          items={items}
          onSelect={(item) => {
            if (item.value === "__back__") {
              onPick(null);
              return;
            }
            const t = themes.find((x) => x.name === item.value);
            onPick(t ?? null);
          }}
          itemComponent={({ label, isSelected }: { label: string; isSelected?: boolean }) => {
            const t = themes.find((x) => x.label === label);
            const color = t?.accent ?? current.accent;
            return (
              <Box>
                <Text color={color} bold={isSelected} dimColor={!isSelected}>
                  {label}
                </Text>
                {t && (
                  <Box marginLeft={1}>
                    <PaletteSwatches palette={t.palette} />
                  </Box>
                )}
              </Box>
            );
          }}
        />
      </Box>
    </Box>
  );
}
