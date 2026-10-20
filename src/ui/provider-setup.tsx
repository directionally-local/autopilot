/**
 * Connect (or switch) a provider, step by step: pick one from a searchable
 * list, connect it (OpenRouter sign-in, an API key, a device login, an
 * endpoint, or nothing for local runtimes), pick a model, done.
 *
 * Used for first-run onboarding and for `/provider`. The logic lives in
 * providers/connect.ts so the Camouflage view offers the same steps.
 * Keys are typed masked, validated before anything is saved, and never
 * shown in the transcript.
 */

import React, { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { CustomTextInput } from "./text-input.js";
import { ModelPicker } from "./model-picker.js";
import { OpenRouterSignIn } from "./openrouter-signin.js";
import { useTheme } from "./theme-context.js";
import { openBrowser } from "./app-helpers.js";
import type { KimiConfig } from "../config.js";
import { OPENROUTER_KEYS_URL } from "../models/openrouter.js";
import { getPreset, type ProviderId } from "../providers/presets.js";
import { resolveProviderKey } from "../providers/resolve.js";
import {
  chatgptSignIn,
  commitProvider,
  copilotSignIn,
  credentialLabel,
  describeConnection,
  filterProviderRows,
  isVertexProjectId,
  maskKey,
  normalizeEndpoint,
  planConnect,
  providerRows,
  saveVertexProject,
  verifyProvider,
  type Connection,
  type KeySource,
  type ProviderRow,
} from "../providers/connect.js";

// ── Provider picker ──────────────────────────────────────────────────────

const PAGE = 12;

interface PickerProps {
  rows: ProviderRow[];
  onPick: (id: ProviderId | null) => void;
  title: string;
  subtitle: string;
  error?: string | null;
  footerTip?: string;
}

/** Searchable provider list, styled like the model picker. */
export function ProviderPicker({ rows, onPick, title, subtitle, error, footerTip }: PickerProps) {
  const theme = useTheme();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const filtered = useMemo(() => filterProviderRows(rows, query), [rows, query]);
  const safe = Math.min(selected, Math.max(0, filtered.length - 1));
  const start = Math.max(0, Math.min(safe - Math.floor(PAGE / 2), filtered.length - PAGE));
  const visible = filtered.slice(start, start + PAGE);
  const nameWidth = Math.max(...rows.map((r) => r.name.length), 10);
  const statusWidth = Math.max(...rows.map((r) => credentialLabel(r).length), 8);

  useInput((input, key) => {
    if (key.escape) return onPick(null);
    if (key.upArrow) return setSelected((i) => (filtered.length ? (Math.min(i, filtered.length - 1) + filtered.length - 1) % filtered.length : 0));
    if (key.downArrow) return setSelected((i) => (filtered.length ? (Math.min(i, filtered.length - 1) + 1) % filtered.length : 0));
    if (key.return) {
      const row = filtered[safe];
      if (row) onPick(row.id);
      return;
    }
    if (key.backspace || key.delete) {
      setQuery((q) => q.slice(0, -1));
      setSelected(0);
      return;
    }
    const printable = input.replace(/[\x00-\x1f\x7f]/g, "");
    if (printable && !key.ctrl && !key.meta) {
      setQuery((q) => q + printable);
      setSelected(0);
    }
  });

  const muted = theme.muted?.color ?? theme.info.color;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={theme.accent} paddingX={1}>
      <Text color={theme.accent} bold>
        {title}
      </Text>
      <Text color={theme.info.color} dimColor>
        {subtitle}
      </Text>
      <Box borderStyle="round" borderColor={query ? theme.accent : theme.info.color} paddingX={1} marginTop={1}>
        <Text color={theme.accent}>⌕ </Text>
        {query ? (
          <Text>
            {query}
            <Text color={theme.accent}>▌</Text>
          </Text>
        ) : (
          <Text color={theme.info.color} dimColor>
            <Text color={theme.accent}>▌</Text>
            {`Search ${rows.length} providers — e.g. claude, gpt, local, gemini`}
          </Text>
        )}
      </Box>
      {query ? <Text color={theme.info.color}>{`${filtered.length} match${filtered.length === 1 ? "" : "es"}`}</Text> : null}
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text color={muted} dimColor>
            No provider matches “{query}”.
          </Text>
        ) : (
          visible.map((r, i) => {
            const isSelected = start + i === safe;
            const ready = r.active || r.credentials === "env" || r.credentials === "config";
            return (
              <Box key={r.id}>
                <Text color={isSelected ? theme.accent : undefined} bold={isSelected}>
                  {isSelected ? "› " : "  "}
                  {r.active ? "● " : "  "}
                  {r.name.padEnd(nameWidth)}
                  {"  "}
                </Text>
                <Text color={ready ? theme.palette.success : muted} dimColor={!ready}>
                  {credentialLabel(r).padEnd(statusWidth)}
                </Text>
                <Text color={muted} dimColor>{`  ${r.hint}`}</Text>
              </Box>
            );
          })
        )}
      </Box>
      {error ? (
        <Box marginTop={1}>
          <Text color={theme.error}>{error}</Text>
        </Box>
      ) : null}
      <Box marginTop={1}>
        <Text color={muted} dimColor>
          {filtered.length > PAGE ? `${safe + 1}/${filtered.length}  ·  ` : ""}● current  ·  type to search  ·  ↑/↓  ·  Enter choose  ·  Esc {footerTip ?? "cancel"}
        </Text>
      </Box>
    </Box>
  );
}

// ── Setup flow ───────────────────────────────────────────────────────────

type Step = "provider" | "reuse" | "method" | "signin" | "device" | "baseUrl" | "project" | "key" | "checking" | "model" | "saving";

const OPENROUTER_METHODS = [
  { id: "signin", label: "Sign in with OpenRouter", hint: "recommended — approve in your browser, no key to copy" },
  { id: "key", label: "Paste an API key", hint: `create one at ${OPENROUTER_KEYS_URL}` },
] as const;

export interface ProviderSetupProps {
  /** "first-run": nothing is configured yet. "switch": `/provider` from a running session. */
  purpose: "first-run" | "switch";
  /** The current config (switch) or the raw config file (first run), for statuses and saved keys. */
  cfg: Partial<KimiConfig> | null;
  /** Start at this provider (e.g. `/provider anthropic`). */
  initialProvider?: ProviderId;
  /** Workers AI first, for a Cloudflare-era kimiflare config. */
  upgrading?: boolean;
  /** Whether a turn is running (the model picker says when the switch applies). */
  turnInProgress?: boolean;
  onDone: (cfg: KimiConfig, connection: Connection) => void;
  onCancel: () => void;
}

export function ProviderSetup({ purpose, cfg, initialProvider, upgrading, turnInProgress, onDone, onCancel }: ProviderSetupProps) {
  const theme = useTheme();
  const rows = useMemo(() => providerRows(cfg, { upgrading, markActive: purpose === "switch" }), [cfg, upgrading, purpose]);
  const [step, setStep] = useState<Step>("provider");
  const [provider, setProvider] = useState<ProviderId>(initialProvider ?? "openrouter");
  const [optionIdx, setOptionIdx] = useState(0);
  const [saved, setSaved] = useState<{ key?: string; source: "env" | "config" | "none" } | null>(null);
  const [keySource, setKeySource] = useState<KeySource>("key");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [project, setProject] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [device, setDevice] = useState<{ uri: string; code: string } | null>(null);
  const [connection, setConnection] = useState<Connection | null>(null);
  const preset = getPreset(provider);
  const switching = purpose === "switch";

  /** Where Esc and failures go back to from the credential steps. */
  const backToStart = () => {
    setError(null);
    setKey("");
    setStep(provider === "openrouter" ? "method" : "provider");
  };

  const choose = (id: ProviderId) => {
    setProvider(id);
    setError(null);
    setKey("");
    setOptionIdx(0);
    const plan = planConnect(id, cfg);
    switch (plan.kind) {
      case "openrouter": {
        // Offer the existing key first when there is one.
        const source = rows.find((r) => r.id === "openrouter")?.credentials;
        const existing = resolveProviderKey("openrouter", cfg as KimiConfig | null);
        setSaved(existing && (source === "env" || source === "config") ? { key: existing, source } : null);
        return setStep("method");
      }
      case "copilot":
        if (switching && rows.find((r) => r.id === "copilot")?.credentials === "config") return offerReuse(id, { source: "config" });
        return void signInCopilot();
      case "chatgpt":
        if (switching && rows.find((r) => r.id === "chatgpt")?.credentials === "config") return offerReuse(id, { source: "config" });
        return void signInChatGPT();
      case "baseUrl":
        return setStep("baseUrl");
      case "project":
        return setStep("project");
      case "key":
        return setStep("key");
      case "ready":
        // Local runtimes and env keys on first run: nothing to type.
        if (plan.source === "none" || !switching) return void accept(id, plan.key, plan.source);
        return offerReuse(id, { key: plan.key, source: plan.source });
    }
  };

  /** Switching to a provider that already has credentials: use them, or enter new ones. */
  const offerReuse = (_id: ProviderId, s: { key?: string; source: "env" | "config" | "none" }) => {
    setSaved(s);
    setOptionIdx(0);
    setStep("reuse");
  };

  const signInCopilot = async () => {
    setDevice(null);
    setStep("device");
    try {
      const { key: token, baseUrl: apiBase } = await copilotSignIn((code) => {
        setDevice(code);
        openBrowser(code.uri);
      });
      setBaseUrl(apiBase);
      await accept("copilot", token, "signin", apiBase);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("provider");
    }
  };

  const signInChatGPT = async () => {
    setDevice(null);
    setStep("device");
    try {
      const { key: token } = await chatgptSignIn((url) => {
        setDevice({ uri: url, code: "" });
        openBrowser(url);
      });
      await accept("chatgpt", token, "signin");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("provider");
    }
  };

  const accept = async (id: ProviderId, candidate: string | undefined, source: KeySource, url?: string) => {
    setKeySource(source);
    setError(null);
    setStep("checking");
    const res = await verifyProvider(id, candidate, source, url);
    if (!res.ok) {
      setKey("");
      setError(res.message);
      setStep(id === "openrouter" ? "method" : source === "key" ? "key" : id === "custom" ? "baseUrl" : "provider");
      return;
    }
    setConnection(res.connection);
    setStep("model");
  };

  const finish = async (modelId: string) => {
    if (!connection) return;
    setStep("saving");
    try {
      onDone(await commitProvider(connection, modelId), connection);
    } catch (e) {
      setError((e as Error).message);
      setStep("model");
    }
  };

  // `/provider anthropic`: jump straight to that provider's first step.
  useEffect(() => {
    if (initialProvider) choose(initialProvider);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const methods = useMemo(
    () => [
      ...(saved?.key ? [{ id: "saved" as const, label: `Use the ${saved.source === "env" ? "key from your environment" : "saved key"} (${maskKey(saved.key)})`, hint: "" }] : []),
      ...OPENROUTER_METHODS,
    ],
    [saved],
  );

  useInput(
    (_input, k) => {
      if (k.escape) return setStep("provider");
      if (k.upArrow) return setOptionIdx((i) => (i + methods.length - 1) % methods.length);
      if (k.downArrow) return setOptionIdx((i) => (i + 1) % methods.length);
      if (k.return) {
        setError(null);
        const m = methods[optionIdx]!;
        if (m.id === "saved") return void accept("openrouter", saved?.key, saved?.source === "env" ? "env" : "config");
        setStep(m.id === "signin" ? "signin" : "key");
      }
    },
    { isActive: step === "method" },
  );

  const reuseOptions = useMemo(() => {
    const signIn = provider === "copilot" || provider === "chatgpt";
    return [
      {
        id: "use",
        label: signIn
          ? `Use your existing ${provider === "copilot" ? "GitHub" : "ChatGPT"} sign-in`
          : saved?.source === "env"
            ? `Use the key from your environment${saved.key ? ` (${maskKey(saved.key)})` : ""}`
            : `Use the saved key${saved?.key ? ` (${maskKey(saved.key)})` : ""}`,
      },
      { id: "new", label: signIn ? "Sign in again" : "Enter a different key" },
    ];
  }, [provider, saved]);

  useInput(
    (_input, k) => {
      if (k.escape) return setStep("provider");
      if (k.upArrow || k.downArrow) return setOptionIdx((i) => (i + 1) % reuseOptions.length);
      if (k.return) {
        if (reuseOptions[optionIdx]!.id === "use") {
          const credential = saved?.key ?? resolveProviderKey(provider, cfg as KimiConfig | null);
          return void accept(provider, credential, saved?.source === "env" ? "env" : "config", cfg?.providers?.[provider]?.baseUrl);
        }
        if (provider === "copilot") return void signInCopilot();
        if (provider === "chatgpt") return void signInChatGPT();
        setStep("key");
      }
    },
    { isActive: step === "reuse" },
  );

  useInput(
    (input, k) => {
      if (k.escape) return provider === "custom" || provider === "azure" ? setStep("baseUrl") : backToStart();
      if (k.ctrl && input === "o" && preset.keysUrl) openBrowser(provider === "openrouter" ? OPENROUTER_KEYS_URL : preset.keysUrl);
    },
    { isActive: step === "key" },
  );

  useInput(
    (_input, k) => {
      if (k.escape) setStep("provider");
    },
    { isActive: step === "baseUrl" || step === "project" || step === "device" },
  );

  const stepNo = step === "provider" ? 1 : step === "model" || step === "saving" ? 3 : 2;
  const muted = { color: theme.info.color, dimColor: true } as const;
  const errorLine = error ? (
    <Box marginTop={1}>
      <Text color={theme.error}>{error}</Text>
    </Box>
  ) : null;

  return (
    <Box flexDirection="column" paddingY={switching ? 0 : 1}>
      <Text color={theme.info.color}>
        {switching ? "Switch provider · " : ""}Step {stepNo} of 3
      </Text>

      {step === "provider" && (
        <Box marginTop={1} flexDirection="column">
          <ProviderPicker
            rows={rows}
            onPick={(id) => (id ? choose(id) : onCancel())}
            title={switching ? "Switch provider" : "Choose where your models run"}
            subtitle={
              switching
                ? "Conversation history is kept. Memory and skills re-index for the new provider's embedding model."
                : "Model calls are billed to your own account with that provider."
            }
            error={error}
            footerTip={switching ? "cancel" : "quit"}
          />
          {!switching && (
            <Box marginTop={1}>
              <Text {...muted}>tip: set a provider's API key (e.g. OPENROUTER_API_KEY) to skip this screen</Text>
            </Box>
          )}
        </Box>
      )}

      {step === "method" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Connect your OpenRouter account</Text>
          <Text {...muted}>↑/↓ to choose, Enter to continue, Esc to pick another provider.</Text>
          <Box marginTop={1} flexDirection="column">
            {methods.map((m, i) => (
              <Text key={m.id} color={i === optionIdx ? theme.palette.primary : undefined}>
                {i === optionIdx ? "› " : "  "}
                {m.label}
                {m.hint ? <Text {...muted}>{`  ${m.hint}`}</Text> : null}
              </Text>
            ))}
          </Box>
          {errorLine}
        </Box>
      )}

      {step === "reuse" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Connect {preset.name}</Text>
          <Text {...muted}>↑/↓ to choose, Enter to continue, Esc to pick another provider.</Text>
          <Box marginTop={1} flexDirection="column">
            {reuseOptions.map((o, i) => (
              <Text key={o.id} color={i === optionIdx ? theme.palette.primary : undefined}>
                {i === optionIdx ? "› " : "  "}
                {o.label}
              </Text>
            ))}
          </Box>
          {errorLine}
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

      {step === "device" && (
        <Box marginTop={1} flexDirection="column">
          <Text>{provider === "chatgpt" ? "Sign in with ChatGPT" : "Sign in to GitHub Copilot"}</Text>
          {device && provider === "chatgpt" ? (
            <>
              <Text>Approve Autopilot in your browser and allow token sharing.</Text>
              <Text {...muted}>If the browser didn't open: {device.uri}</Text>
              <Text {...muted}>Usage counts against your ChatGPT plan.</Text>
            </>
          ) : device ? (
            <>
              <Text>
                Open <Text color={theme.accent}>{device.uri}</Text> and enter the code{" "}
                <Text bold color={theme.palette.primary}>
                  {device.code}
                </Text>
              </Text>
              <Text {...muted}>Waiting for you to approve in the browser… Copilot usage counts against your plan.</Text>
            </>
          ) : (
            <Text {...muted}>{provider === "chatgpt" ? "Starting sign-in…" : "Contacting GitHub…"}</Text>
          )}
        </Box>
      )}

      {step === "baseUrl" && (
        <Box marginTop={1} flexDirection="column">
          <Text>{provider === "azure" ? "Your Azure OpenAI resource name (or its endpoint URL)" : "Base URL of your OpenAI-compatible endpoint"}</Text>
          <Text {...muted}>
            {provider === "azure"
              ? "The <name> in https://<name>.openai.azure.com. Esc to go back."
              : "e.g. http://localhost:4000/v1 for LiteLLM, http://localhost:8000/v1 for vLLM. Esc to go back."}
          </Text>
          <Box marginTop={1}>
            <Text color={theme.palette.primary}>› </Text>
            <CustomTextInput
              value={baseUrl}
              onChange={setBaseUrl}
              onSubmit={(v) => {
                const res = normalizeEndpoint(provider === "azure" ? "azure" : "custom", v);
                if ("error" in res) return setError(res.error);
                setBaseUrl(res.url);
                setError(null);
                setStep("key");
              }}
            />
          </Box>
          {errorLine}
        </Box>
      )}

      {step === "project" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Your Google Cloud project id</Text>
          <Text {...muted}>Credentials come from gcloud (gcloud auth application-default login). Esc to go back.</Text>
          <Box marginTop={1}>
            <Text color={theme.palette.primary}>› </Text>
            <CustomTextInput
              value={project}
              onChange={setProject}
              onSubmit={(v) => {
                if (!isVertexProjectId(v)) return setError("Enter a Google Cloud project id");
                setError(null);
                void saveVertexProject(v).then(() => accept("vertex", undefined, "none"));
              }}
            />
          </Box>
          {errorLine}
        </Box>
      )}

      {step === "key" && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Paste your {preset.name} API key{provider === "custom" ? " (Enter with nothing to skip)" : ""}
          </Text>
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
                void accept(provider, k || undefined, "key", provider === "custom" || (provider === "azure" && baseUrl) ? baseUrl : undefined);
              }}
            />
          </Box>
          {errorLine}
          <Box marginTop={1}>
            <Text {...muted}>Enter to continue · Esc back{preset.apiKeyEnv[0] ? ` · tip: set ${preset.apiKeyEnv[0]} to skip this screen` : ""}</Text>
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

      {(step === "model" || step === "saving") && connection && (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.info.color}>✓ {describeConnection(connection)}</Text>
          {step === "model" && (
            <Box marginTop={1} flexDirection="column">
              <ModelPicker
                current=""
                turnInProgress={turnInProgress}
                title={`Pick a ${preset.name} model — switch any time with /model  ·  prices are USD per million tokens`}
                onPick={(m) => {
                  if (m) void finish(m.id);
                  else setStep("provider");
                }}
              />
            </Box>
          )}
          {connection.openRouter?.isFreeTier && (
            <Box marginTop={1}>
              <Text color={theme.warn}>
                This key has no credits yet: only free models work (type "free" to find them), with a daily request cap. Add credits at
                https://openrouter.ai/settings/credits to use the others.
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
