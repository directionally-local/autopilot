import React from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme-context.js";

interface Props {
  httpStatus?: number;
  code?: number;
  message: string;
  /** The active provider's status page (presets.ts `statusUrl`). */
  statusUrl?: string;
}

export function ApiErrorMessage({ httpStatus, code, message, statusUrl }: Props) {
  const theme = useTheme();

  const parts: string[] = [];
  if (httpStatus !== undefined) parts.push(`HTTP ${httpStatus}`);
  if (code !== undefined) parts.push(`code: ${code}`);
  const meta = parts.join(" · ");

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.error} paddingX={1} marginY={1}>
      <Text bold color={theme.error}>
        ⚠ {message}
      </Text>
      {meta && (
        <Text color={theme.muted?.color ?? theme.info.color} dimColor={theme.muted?.dim ?? true}>
          {meta}
        </Text>
      )}
      <Text color={theme.muted?.color ?? theme.info.color} dimColor={theme.muted?.dim ?? true}>
        {statusUrl ? `Provider status: ${statusUrl} · ` : ""}switch models with /model
      </Text>
    </Box>
  );
}
