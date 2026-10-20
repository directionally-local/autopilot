/**
 * First-run setup: choose a provider, connect it (OpenRouter sign-in, an API
 * key, or a local runtime), pick a model, done.
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

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { CustomTextInput } from "./text-input.js";
import { ModelPicker } from "./model-picker.js";
import { OpenRouterSignIn } from "./openrouter-signin.js";
import { useTheme } from "./theme-context.js";
import { openBrowser } from "./app-helpers.js";
import { hasLegacyCloudflareConfig, loadConfig, type KimiConfig } from "../config.js";
import { checkOpenRouterKey, OPENROUTER_KEYS_URL, type OpenRouterKeyInfo } from "../models/openrouter.js";
import type { ModelEntry } from "../models/registry.js";
import { getPreset, type ProviderId } from "../providers/presets.js";
import { detectEnvProviders, resolveProviderKey } from "../providers/resolve.js";
import { checkProviderKey, saveProviderKey, switchProvider } from "../providers/keys.js";
import { llmAuthFromConfig } from "../agent/llm-auth.js";
import { ensureCatalogForProvider } from "../models/catalog.js";

interface Props {
  onDone: (cfg: KimiConfig) => void;
  onCancel?: () => void;
}

type Step = "provider" | "method" | "signin" | "baseUrl" | "key" | "checking" | "model" | "saving";

/** Providers offered on the first screen, in order. */
const CHOICES: ReadonlyArray<{ id: ProviderId; hint: string }> = [
  { id: "openrouter", hint: "recommended — hundreds of models with one account" },
  { id: "anthropic", hint: "Claude models with an Anthropic API key" },
  { id: "openai", hint: "GPT models with an OpenAI API key" },
  { id: "deepseek", hint: "DeepSeek API key" },
  { id: "moonshot", hint: "Kimi models with a Moonshot API key" },
  { id: "kimi-code", hint: "Kimi Code subscription" },
  { id: "zai", hint: "GLM models with a Z.ai API key" },
  { id: "zai-coding", hint: "GLM Coding Plan subscription" },
  { id: "ollama", hint: "local models, no key" },
  { id: "lmstudio", hint: "local models, no key" },
  { id: "requesty", hint: "Requesty gateway key" },
  { id: "custom", hint: "any OpenAI-compatible endpoint (LiteLLM, vLLM, a company gateway)" },
];

const OPENROUTER_METHODS = [
  { label: "Sign in with OpenRouter", hint: "recommended — approve in your browser, no key to copy" },
  { label: "Paste an API key", hint: "create one at https://openrouter.ai/keys" },
] as const;

export function Onboarding({ onDone, onCancel }: Props) {
  const theme = useTheme();
  const envProviders = useMemo(() => detectEnvProviders(), []);
  // Providers with a key already in the environment come first.
  const choices = useMemo(
    () => [...CHOICES].sort((a, b) => Number(envProviders.includes(b.id)) - Number(envProviders.includes(a.id))),
    [envProviders],
  );
  const [step, setStep] = useState<Step>("provider");
  const [choiceIdx, setChoiceIdx] = useState(0);
  const [provider, setProvider] = useState<ProviderId>("openrouter");
  const [methodIdx, setMethodIdx] = useState(0);
  /** Where "back" from the key check goes. */
  const [keySource, setKeySource] = useState<"key" | "signin" | "env" | "none">("key");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [orKeyInfo, setOrKeyInfo] = useState<OpenRouterKeyInfo | null>(null);
  const [detail, setDetail] = useState<string | undefined>(undefined);
  const [upgrading, setUpgrading] = useState(false);
  const preset = getPreset(provider);

  useEffect(() => {
    void hasLegacyCloudflareConfig().then(setUpgrading);
  }, []);

  /** After choosing a provider: go straight to checking when nothing needs typing. */
  const chooseProvider = (id: ProviderId) => {
    setProvider(id);
    setError(null);
    setKey("");
    const p = getPreset(id);
    if (id === "openrouter") return setStep("method");
    if (id === "custom") return setStep("baseUrl");
    const envKey = resolveProviderKey(id, null);
    if (envKey) return void accept(id, envKey, "env");
    if (!p.keyRequired) return void accept(id, undefined, "none");
    setStep("key");
  };

  /** Validate the key (or reach the local runtime), load the provider's models, then pick one. */
  const accept = async (id: ProviderId, candidate: string | undefined, source: typeof keySource, url?: string) => {
    setKeySource(source);
    setError(null);
    setStep("checking");
    const p = getPreset(id);
    const effectiveUrl = url ?? p.baseUrl;
    if (id === "openrouter" && candidate) {
      const res = await checkOpenRouterKey(candidate);
      if (res.ok) setOrKeyInfo(res.info);
      else return fail(res.reason === "invalid" ? "OpenRouter rejected this key. Check it was copied in full, or create a new one." : `Couldn't reach OpenRouter (${res.message}).`, id, source);
    } else {
      const res = await checkProviderKey(id, candidate, effectiveUrl);
      if (!res.ok) return fail(res.message, id, source);
      setDetail(res.detail);
    }
    setKey(candidate ?? "");
    const auth = llmAuthFromConfig({
      provider: id,
      ...(id === "openrouter" ? { openrouterApiKey: candidate } : {}),
      ...(id === "requesty" ? { requestyApiKey: candidate } : {}),
      ...(id === "custom" ? { baseUrl: effectiveUrl, apiKey: candidate } : {}),
      providers: { [id]: { ...(candidate ? { apiKey: candidate } : {}), ...(url ? { baseUrl: url } : {}) } },
    }, id);
    await ensureCatalogForProvider(auth);
    setStep("model");
  };

  const fail = (message: string, id: ProviderId, source: typeof keySource) => {
    setKey("");
    setError(message);
    setStep(id === "openrouter" ? "method" : source === "key" ? "key" : id === "custom" ? "baseUrl" : "provider");
  };

  const finish = async (model: ModelEntry | null, typedModel?: string) => {
    const modelId = model?.id ?? typedModel?.trim();
    if (!modelId) return;
    setStep("saving");
    try {
      // Env keys stay in the env; only typed or signed-in keys are saved.
      const toSave = keySource === "key" || keySource === "signin" ? key : undefined;
      if (toSave || (provider === "custom" && baseUrl)) await saveProviderKey(provider, toSave, provider === "custom" ? baseUrl : undefined);
      await switchProvider(null, provider, modelId);
      const cfg = await loadConfig();
      if (!cfg) throw new Error("config did not load after saving");
      onDone(cfg);
    } catch (e) {
      setError((e as Error).message);
      setStep("model");
    }
  };

  useInput(
    (_input, k) => {
      if (k.escape) onCancel?.();
      else if (k.upArrow) setChoiceIdx((i) => (i + choices.length - 1) % choices.length);
      else if (k.downArrow) setChoiceIdx((i) => (i + 1) % choices.length);
      else if (k.return) chooseProvider(choices[choiceIdx]!.id);
    },
    { isActive: step === "provider" },
  );

  useInput(
    (_input, k) => {
      if (k.escape) setStep("provider");
      else if (k.upArrow || k.downArrow) setMethodIdx((i) => (i + 1) % OPENROUTER_METHODS.length);
      else if (k.return) {
        setError(null);
        setStep(methodIdx === 0 ? "signin" : "key");
      }
    },
    { isActive: step === "method" },
  );

  useInput(
    (input, k) => {
      if (k.escape) setStep(provider === "openrouter" ? "method" : provider === "custom" ? "baseUrl" : "provider");
      if (k.ctrl && input === "o" && preset.keysUrl) openBrowser(provider === "openrouter" ? OPENROUTER_KEYS_URL : preset.keysUrl);
    },
    { isActive: step === "key" },
  );

  useInput(
    (_input, k) => {
      if (k.escape) setStep("provider");
    },
    { isActive: step === "baseUrl" },
  );

  const stepNo = step === "provider" ? 1 : step === "model" || step === "saving" ? 3 : 2;
  const muted = { color: theme.info.color, dimColor: true } as const;

  return (
    // No header here: the startup banner (ui/logo.ts) names the app just above.
    <Box flexDirection="column" paddingY={1}>
      {upgrading && (
        <Box flexDirection="column" marginBottom={1}>
          <Text color={theme.accent}>autopilot (formerly kimiflare) no longer runs on Cloudflare.</Text>
          <Text {...muted}>
            Cloudflare Workers AI and AI Gateway are no longer used. Connect a provider once and your other
            settings carry over — Kimi models, memory and sessions all keep working.
          </Text>
        </Box>
      )}

      <Text color={theme.info.color}>Step {stepNo} of 3</Text>

      {step === "provider" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Choose where your models run</Text>
          <Text {...muted}>Model calls are billed to your own account with that provider. ↑/↓ to choose, Enter to continue.</Text>
          <Box marginTop={1} flexDirection="column">
            {choices.map((c, i) => (
              <Text key={c.id} color={i === choiceIdx ? theme.palette.primary : undefined}>
                {i === choiceIdx ? "› " : "  "}
                {getPreset(c.id).name}
                <Text {...muted}>{`  ${envProviders.includes(c.id) ? "key found in your environment" : c.hint}`}</Text>
              </Text>
            ))}
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color={theme.error}>{error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text {...muted}>Esc to quit · tip: set a provider's API key (e.g. OPENROUTER_API_KEY) to skip this screen</Text>
          </Box>
        </Box>
      )}

      {step === "method" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Connect your OpenRouter account</Text>
          <Text {...muted}>↑/↓ to choose, Enter to continue, Esc to pick another provider.</Text>
          <Box marginTop={1} flexDirection="column">
            {OPENROUTER_METHODS.map((m, i) => (
              <Text key={m.label} color={i === methodIdx ? theme.palette.primary : undefined}>
                {i === methodIdx ? "› " : "  "}
                {m.label}
                <Text {...muted}>{`  ${m.hint}`}</Text>
              </Text>
            ))}
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color={theme.error}>{error}</Text>
            </Box>
          )}
        </Box>
      )}

      {step === "signin" && (
        <OpenRouterSignIn
          onBack={() => setStep("method")}
          onKey={(minted) => {
            setKey(minted);
            void accept("openrouter", minted, "signin");
          }}
        />
      )}

      {step === "baseUrl" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Base URL of your OpenAI-compatible endpoint</Text>
          <Text {...muted}>e.g. http://localhost:4000/v1 for LiteLLM, http://localhost:8000/v1 for vLLM. Esc to go back.</Text>
          <Box marginTop={1}>
            <Text color={theme.palette.primary}>› </Text>
            <CustomTextInput
              value={baseUrl}
              onChange={setBaseUrl}
              onSubmit={(v) => {
                const url = v.trim();
                if (!/^https?:\/\//.test(url)) return setError("Enter a URL starting with http:// or https://");
                setBaseUrl(url);
                setError(null);
                setStep("key");
              }}
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color={theme.error}>{error}</Text>
            </Box>
          )}
        </Box>
      )}

      {step === "key" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Paste your {preset.name} API key{provider === "custom" ? " (Enter with nothing to skip)" : ""}</Text>
          {preset.keysUrl && (
            <Text {...muted}>
              Create one at {provider === "openrouter" ? OPENROUTER_KEYS_URL : preset.keysUrl} (Ctrl+O opens it). It is stored only in your config file.
            </Text>
          )}
          <Box marginTop={1}>
            <Text color={theme.palette.primary}>› </Text>
            <CustomTextInput
              value={key}
              onChange={setKey}
              mask="•"
              onSubmit={(v) => {
                const k = v.trim();
                if (!k && provider !== "custom") return;
                void accept(provider, k || undefined, "key", provider === "custom" ? baseUrl : undefined);
              }}
            />
          </Box>
          {error && (
            <Box marginTop={1}>
              <Text color={theme.error}>{error}</Text>
            </Box>
          )}
          <Box marginTop={1}>
            <Text {...muted}>
              Enter to continue · Esc back{preset.apiKeyEnv[0] ? ` · tip: set ${preset.apiKeyEnv[0]} to skip this screen` : ""}
            </Text>
          </Box>
        </Box>
      )}

      {step === "checking" && (
        <Box marginTop={1}>
          <Text color={theme.info.color}>
            {keySource === "signin" ? "✓ signed in — " : ""}
            {preset.keyRequired || provider === "openrouter" ? `checking the key with ${preset.name}…` : `connecting to ${preset.name}…`}
          </Text>
        </Box>
      )}

      {(step === "model" || step === "saving") && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.info.color}>
            ✓ {preset.name} connected
            {keySource === "env" ? " (key from your environment)" : ""}
            {orKeyInfo?.label ? ` (${orKeyInfo.label})` : ""}
            {provider === "openrouter" ? describeCredit(orKeyInfo) : detail ? ` ${detail}` : ""}
          </Text>
          {step === "model" && (
            <Box marginTop={1} flexDirection="column">
              <ModelPicker
                current=""
                title="Pick a model — switch any time with /model  ·  prices are USD per million tokens"
                onPick={(m) => {
                  if (m) void finish(m);
                  else setStep("provider");
                }}
              />
            </Box>
          )}
          {orKeyInfo?.isFreeTier && (
            <Box marginTop={1}>
              <Text color={theme.warn}>
                This key has no credits yet: only free models work (type "free" to find them), with a daily
                request cap. Add credits at https://openrouter.ai/settings/credits to use the others.
              </Text>
            </Box>
          )}
          {step === "saving" && (
            <Box marginTop={1}>
              <Text color={theme.info.color}>saving…</Text>
            </Box>
          )}
          {error && (
            <Box marginTop={1}>
              <Text color={theme.error}>Couldn't save config: {error}</Text>
            </Box>
          )}
        </Box>
      )}
    </Box>
  );
}

function describeCredit(info: OpenRouterKeyInfo | null): string {
  if (!info) return "";
  if (typeof info.limitRemaining === "number") return ` · $${info.limitRemaining.toFixed(2)} credit left on this key`;
  return "";
}
