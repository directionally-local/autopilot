/**
 * First-run setup: choose a provider, connect it (OpenRouter sign-in, an API
 * key, or a local runtime), pick a model, done. The steps are ProviderSetup's,
 * which `/provider` reuses.
 *
 * Skipped entirely when the active provider is already usable (a key in the
 * environment or the config file, a custom endpoint, a local runtime) —
 * `loadConfig()` then returns a config and the app never mounts this screen,
 * which is what makes headless installs possible.
 *
 * Keys are validated against the provider before anything is saved, so a
 * typo surfaces here instead of on the first prompt. Saving merges into the
 * existing config file, so an upgrading user's settings (theme, MCP servers,
 * …) survive. Keys that came from the environment are never written to disk.
 */

import React, { useEffect, useState } from "react";
import { Box, Text } from "ink";
import { useTheme } from "./theme-context.js";
import { ProviderSetup } from "./provider-setup.js";
import { hasLegacyCloudflareConfig, readPersistedConfig, type KimiConfig } from "../config.js";

interface Props {
  onDone: (cfg: KimiConfig) => void;
  onCancel?: () => void;
}

export function Onboarding({ onDone, onCancel }: Props) {
  const theme = useTheme();
  const [upgrading, setUpgrading] = useState(false);
  /** Raw config file (Cloudflare-era configs keep accountId/apiToken that Workers AI can reuse). */
  const [persisted, setPersisted] = useState<Partial<KimiConfig> | null | undefined>(undefined);
  useEffect(() => {
    void hasLegacyCloudflareConfig().then(setUpgrading);
    void readPersistedConfig().then((p) => setPersisted(p ?? null));
  }, []);
  if (persisted === undefined) return null;

  return (
    // No header here: the startup banner (ui/logo.ts) names the app just above.
    <Box flexDirection="column">
      {upgrading && (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.accent}>autopilot (formerly kimiflare) no longer runs on Cloudflare.</Text>
          <Text color={theme.info.color} dimColor>
            Cloudflare Workers AI and AI Gateway are no longer used. Connect a provider once and your other settings carry over — Kimi models,
            memory and sessions all keep working.
          </Text>
        </Box>
      )}
      <ProviderSetup purpose="first-run" cfg={persisted} upgrading={upgrading} onDone={(cfg) => onDone(cfg)} onCancel={() => onCancel?.()} />
    </Box>
  );
}
