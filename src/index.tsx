import { Command, Option } from "commander";
import { logger } from "./util/logger.js";
import { loadConfig, type KimiConfig } from "./config.js";
import { PROVIDER_PRESETS } from "./providers/presets.js";
import { resolveLspConfig } from "./util/lsp-config.js";
import { checkForUpdate } from "./util/update-check.js";
import type { UpdateCheckResult } from "./util/update-check.js";
import { getAppVersion } from "./util/version.js";
import { createRemoteCommand } from "./remote/cli.js";
import { renderLogo } from "./ui/logo.js";
import { runPrintMode } from "./print-mode.js";
import { registerEvalCommand } from "./eval/cli.js";
import type { PrintFormat } from "./print-mode.js";

const program = new Command();
program
  .name("autopilot")
  .description("Terminal coding agent. Runs any OpenRouter model with your own OpenRouter key.")
  .version(getAppVersion())
  .option("-p, --print <prompt>", "one-shot mode: send prompt, stream reply to stdout, exit")
  .option("-m, --model <id>", "model id for the active provider (defaults to its configured model)")
  // KimiFlare Cloud was retired with the move to OpenRouter. Keep the flag
  // parseable so old scripts don't break; it's ignored with a notice.
  .addOption(new Option("--cloud", "(retired) KimiFlare Cloud").hideHelp())
  .option("--dangerously-allow-all", "auto-approve every permission prompt (print mode only)")
  .addOption(new Option("--worker-profile <profile>", "internal worker permission profile").hideHelp())
  .option("--reasoning", "include reasoning in stdout (print mode only)")
  .option("--thinking", "alias for --reasoning")
  .option("--continue-on-limit", "reset tool-call counter and continue when the 200-call limit is hit (print mode only)")
  .option("--max-total-tool-iterations <n>", "hard ceiling on tool iterations per turn across --continue-on-limit resets (default 1000)", (v) => parseInt(v, 10))
  .option("--max-input-tokens <n>", "cumulative prompt token budget; exits 42 when exhausted (print mode only)", (v) => parseInt(v, 10))
  .option("--emit-events", "emit Camouflage NDJSON events to stdout; requires -p (for initial prompt)")
  .option("--multi-turn", "with --emit-events: keep reading stdin for UserInputSubmitted follow-ups after the initial turn")
  // Hidden escape hatch: `--ui ink` (or KIMIFLARE_UI=ink) runs the old UI.
  .addOption(new Option("--ui <name>", "interface: camouflage (default) or ink").hideHelp())
  .option("--mode <mode>", "run mode: interactive (default), print, rpc")
  .option("-c, --continue", "continue the most recent session in the current working directory (print mode only)")
  .option("-S, --session <id>", "resume a specific session by id (print mode only)")
  .option("-f, --file <path>", "attach file(s) to the prompt; repeatable, supports globs (print mode only)", (v, prev: string[] | undefined) => (prev ?? []).concat(v))
  .option("--format <mode>", "output format for print mode: text (default), json, stream-json")
  .option("--dir <path>", "run in the specified directory instead of the current one (print mode only)")
  .option("--title <title>", "override the auto-generated session title (print mode only)")
  .option("--attach <url>", "attach to a running autopilot serve instance (print mode only)");

program
  .command("cost")
  .description("Show cost attribution by task type (requires costAttribution enabled)")
  .option("-w, --week", "last 7 days (default)")
  .option("-m, --month", "last 30 days")
  .option("-d, --day", "today only")
  .option("-s, --session <id>", "single session detail")
  .option("-c, --category <name>", "filter by category")
  .option("--json", "machine-readable output")
  .option("--reclassify", "re-run classification on all sessions")
  .option("--local-only", "skip OpenRouter reconciliation (no network)")
  .option("--verify", "check recorded tokens and cost against OpenRouter's generation records (latest session, or -s <id>)")
  .action(async (cmdOpts) => {
    const cfg = await loadConfig();
    if (cmdOpts.verify) {
      const { activeOpenRouterKey } = await import("./agent/llm-auth.js");
      const orKey = activeOpenRouterKey(cfg);
      if (!orKey) {
        console.error("autopilot cost --verify checks costs against OpenRouter's records, so it needs OpenRouter as the active provider (OPENROUTER_API_KEY or `autopilot auth openrouter`).");
        process.exit(2);
      }
      const { pickSession, verifySession, formatVerifyReport } = await import("./cost-verify.js");
      const session = await pickSession(cmdOpts.session);
      if (!session) {
        console.error(cmdOpts.session ? `Session ${cmdOpts.session} not found.` : "No sessions with OpenRouter generations yet.");
        process.exit(1);
      }
      const result = await verifySession(session, orKey);
      console.log(formatVerifyReport(result));
      const bad = result.rows.some((r) => !r.missing && r.fields.some((f) => !f.ok));
      process.exit(bad ? 1 : 0);
    }
    const enabled = cfg?.costAttribution ?? false;
    if (!enabled) {
      console.error(
        "Cost attribution is disabled. Enable it with:\n" +
          "  KIMI_COST_ATTRIBUTION=1 autopilot cost\n" +
          "Or add costAttribution: true to ~/.config/kimiflare/config.json",
      );
      process.exit(1);
    }

    const { runCostCommand } = await import("./cost-attribution/cli.js");
    await runCostCommand({ ...cmdOpts, config: cfg });
  });

program.addCommand(createRemoteCommand());
registerEvalCommand(program);

const asterCommand = program.command("aster").description("Manage the Aster mobile API");
const asterTokenCommand = asterCommand.command("token").description("Manage scoped Aster API credentials");
asterTokenCommand
  .command("create")
  .description("Create a 30-day credential scoped to selected workspace IDs")
  .requiredOption("-n, --name <name>", "Credential label")
  .requiredOption("-w, --workspace <id>", "Allowed workspace ID (repeatable)", (value, previous: string[] = []) => [...previous, value])
  .option("--expires-in-days <days>", "Expiry in days (1-365)", (value) => Number.parseInt(value, 10), 30)
  .action(async (options: { name: string; workspace: string[]; expiresInDays: number }) => {
    const { loadAsterServerConfig } = await import("./server/aster-workspaces.js");
    const { AsterStore } = await import("./server/aster-store.js");
    try {
      const config = await loadAsterServerConfig();
      const workspaceIds = [...new Set(options.workspace)];
      if (!Number.isInteger(options.expiresInDays) || options.expiresInDays < 1 || options.expiresInDays > 365) {
        throw new Error("--expires-in-days must be an integer from 1 through 365");
      }
      if (workspaceIds.some((id) => !config.workspaces.some((workspace) => workspace.id === id))) {
        throw new Error("credential includes an unknown workspace ID");
      }
      const store = new AsterStore();
      try {
        const created = store.createCredential({
          name: options.name,
          workspaceIds,
          scopes: ["workspaces:read", "models:read", "conversations:read", "conversations:write", "approvals:resolve"],
          expiresAt: Date.now() + options.expiresInDays * 24 * 60 * 60 * 1000,
        });
        console.log(`Credential ID: ${created.id}`);
        console.log(`Workspace scope: ${created.workspaceIds.join(", ")}`);
        console.log(`Expires: ${new Date(created.expiresAt).toISOString()}`);
        console.log("Copy this token into the Aster app's Keychain now; it will not be shown again:");
        console.log(created.token);
      } finally {
        store.close();
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    }
  });
asterTokenCommand
  .command("revoke")
  .description("Revoke an Aster credential immediately")
  .argument("<credential-id>")
  .action(async (credentialId: string) => {
    const { AsterStore } = await import("./server/aster-store.js");
    const store = new AsterStore();
    try {
      if (!store.revokeCredential(credentialId)) {
        console.error("Aster credential not found");
        process.exitCode = 1;
        return;
      }
      console.log(`Revoked credential ${credentialId}`);
    } finally {
      store.close();
    }
  });

const logsCmd = program
  .command("logs")
  .description("Inspect KimiFlare's structured logs (jsonl, one file per day, 7-day retention)");

logsCmd
  .command("path")
  .description("Print today's log file path. Useful for tailing: tail -f $(autopilot logs path) | jq")
  .action(async () => {
    const { logPathFor } = await import("./util/log-sink.js");
    console.log(logPathFor());
  });

logsCmd
  .command("dir")
  .description("Print the log directory")
  .action(async () => {
    const { logDir } = await import("./util/log-sink.js");
    console.log(logDir());
  });

logsCmd
  .command("prune")
  .description("Delete log files older than 7 days")
  .action(async () => {
    const { pruneOldLogs } = await import("./util/log-sink.js");
    const removed = pruneOldLogs();
    console.log(`pruned ${removed} log files`);
  });

program
  .command("resume")
  .description("Resume is temporarily unavailable while Camouflage UI access is disabled.")
  .action(async () => {
    console.error("autopilot resume: temporarily unavailable. Camouflage UI access is disabled.");
    process.exit(2);
  });

const authCommand = program
  .command("auth")
  .description("Connect an LLM provider (or GitHub); `autopilot auth status` lists providers")
  .addCommand(
    new Command("openrouter")
      .description(
        "Connect your OpenRouter account: sign in through the browser (default), paste a key, or pass one. For headless setups, OPENROUTER_API_KEY works too.",
      )
      .argument("[key]", "an existing key (sk-or-…) to save instead of signing in")
      .option("--paste", "paste an existing key (prompted without echo) instead of signing in")
      .option("--code", "sign in on another device and paste the code OpenRouter shows (default over SSH)")
      .action(async (keyArg: string | undefined, cmdOpts: { paste?: boolean; code?: boolean }) => {
        const { checkOpenRouterKey, looksLikeOpenRouterKey, OPENROUTER_KEYS_URL } = await import("./models/openrouter.js");
        const { patchPersistedConfig } = await import("./config.js");
        let key = keyArg?.trim();
        if (!key && cmdOpts.paste) {
          console.log(`Create a key at ${OPENROUTER_KEYS_URL}, then paste it here.`);
          key = (await promptHidden("OpenRouter API key: ")).trim();
        }
        if (!key) {
          try {
            key = await signInFromCli(!!cmdOpts.code);
          } catch (e) {
            console.error(e instanceof Error ? e.message : String(e));
            process.exit(1);
          }
        }
        if (!looksLikeOpenRouterKey(key)) {
          console.error("That doesn't look like an OpenRouter key — they start with sk-or-.");
          process.exit(1);
        }
        const res = await checkOpenRouterKey(key);
        if (!res.ok) {
          console.error(res.reason === "invalid" ? "OpenRouter rejected this key." : `Couldn't verify the key: ${res.message}`);
          process.exit(1);
        }
        const savedTo = await patchPersistedConfig({ openrouterApiKey: key });
        const { switchProvider } = await import("./providers/keys.js");
        await switchProvider(await loadConfig().catch(() => null), "openrouter");
        const credit = typeof res.info.limitRemaining === "number" ? ` · $${res.info.limitRemaining.toFixed(2)} credit left` : "";
        console.log(`✓ Connected${res.info.label ? ` (${res.info.label})` : ""}${credit}`);
        console.log(`Saved to ${savedTo}. Run \`autopilot\` to start.`);
      }),
  )
  .addCommand(
    new Command("requesty")
      .description(
        "Save a Requesty API key and make Requesty the active provider. For headless setups, REQUESTY_API_KEY works too.",
      )
      .argument("[key]", "an existing Requesty key to save instead of pasting one")
      .action(async (keyArg: string | undefined) => {
        const { checkRequestyKey, REQUESTY_KEYS_URL } = await import("./models/requesty.js");
        const { patchPersistedConfig } = await import("./config.js");
        let key = keyArg?.trim();
        if (!key) {
          console.log(`Create a key at ${REQUESTY_KEYS_URL}, then paste it here.`);
          key = (await promptHidden("Requesty API key: ")).trim();
        }
        if (!key) {
          console.error("No key entered.");
          process.exit(1);
        }
        const res = await checkRequestyKey(key);
        if (!res.ok) {
          console.error(res.reason === "invalid" ? "Requesty rejected this key." : `Couldn't verify the key: ${res.message}`);
          process.exit(1);
        }
        const savedTo = await patchPersistedConfig({ requestyApiKey: key });
        const { switchProvider } = await import("./providers/keys.js");
        await switchProvider(await loadConfig().catch(() => null), "requesty");
        console.log("✓ Connected to Requesty");
        console.log(`Saved to ${savedTo}. Run \`autopilot\` to start.`);
      }),
  )
  .addCommand(
    new Command("use")
      .description("Make a provider the active one: openrouter, requesty, openai, deepseek, moonshot, kimi-code, zai, zai-coding, ollama, lmstudio, custom")
      .argument("<provider>", "provider id")
      .action(async (id: string) => {
        const { isProviderId, getPreset } = await import("./providers/presets.js");
        const { switchProvider } = await import("./providers/keys.js");
        const { isProviderUsable, resolveActiveProvider } = await import("./providers/resolve.js");
        if (!isProviderId(id)) {
          console.error(`Unknown provider "${id}". Run \`autopilot auth status\` to list them.`);
          process.exit(2);
        }
        const cfg = await loadConfig();
        await switchProvider(cfg, id);
        const next = resolveActiveProvider({ ...(cfg ?? {}), provider: id });
        console.log(`✓ ${getPreset(id).name} is now the active provider.`);
        if (!isProviderUsable(next)) console.log(`It has no key yet: run \`autopilot auth ${id}\`.`);
      }),
  )
  .addCommand(
    new Command("status")
      .description("List providers, which one is active, and where each key comes from")
      .action(async () => {
        const { providerStatus } = await import("./providers/keys.js");
        const cfg = await loadConfig();
        for (const r of providerStatus(cfg)) {
          const key = r.key === null ? "no key" : r.key === "not needed" ? "no key needed" : `key in ${r.key}`;
          console.log(`${r.active ? "›" : " "} ${r.id.padEnd(11)} ${r.name}${r.active ? " (active)" : ""} · ${key}`);
        }
      }),
  );

for (const id of ["openai", "deepseek", "moonshot", "kimi-code", "zai", "zai-coding", "ollama", "lmstudio"] as const) {
  authCommand.addCommand(
    new Command(id)
      .description(
        PROVIDER_PRESETS[id].keyRequired
          ? `Connect ${PROVIDER_PRESETS[id].name} with an API key (validated, saved to config.json) and make it the active provider`
          : `Use a local ${PROVIDER_PRESETS[id].name} (checks it is reachable) as the active provider`,
      )
      .argument("[key]", "the key to save instead of pasting one")
      .option("--base-url <url>", "use a different endpoint (e.g. Ollama on another host)")
      .action(async (keyArg: string | undefined, cmdOpts: { baseUrl?: string }) => {
        const { getPreset } = await import("./providers/presets.js");
        const { checkProviderKey, saveProviderKey, switchProvider } = await import("./providers/keys.js");
        const preset = getPreset(id);
        let key = keyArg?.trim();
        if (!key && preset.keyRequired) {
          if (preset.keysUrl) console.log(`Create a key at ${preset.keysUrl}, then paste it here.`);
          key = (await promptHidden(`${preset.name} API key: `)).trim();
        }
        if (!key && preset.keyRequired) {
          console.error("No key entered.");
          process.exit(1);
        }
        const res = await checkProviderKey(id, key, cmdOpts.baseUrl);
        if (!res.ok) {
          console.error(res.message);
          process.exit(1);
        }
        const savedTo = await saveProviderKey(id, key, cmdOpts.baseUrl);
        await switchProvider(await loadConfig().catch(() => null), id);
        console.log(`✓ Connected to ${preset.name}${res.detail ? ` ${res.detail}` : ""} — now the active provider.`);
        console.log(`Saved to ${savedTo}. Run \`autopilot\` to start.`);
      }),
  );
}

authCommand.addCommand(
    new Command("github")
      .description("Authenticate with GitHub via OAuth device flow")
      .action(async () => {
        const { authGitHubForTui } = await import("./remote/tui-auth.js");
        for await (const step of authGitHubForTui()) {
          console.log(step.message);
          if (step.url && step.code) {
            console.log(`\nOpen: ${step.url}`);
            console.log(`Code: ${step.code}\n`);
          }
          if (step.done) break;
          if (step.error) process.exit(1);
        }
      }),
  );

program
  .command("serve")
  .description("Start a headless HTTP server for API access and CI integration")
  .option("--port <n>", "port to listen on", (v) => parseInt(v, 10), 4096)
  .option("--hostname <host>", "hostname to listen on", "127.0.0.1")
  .action(async (cmdOpts) => {
    const cfg = await loadConfig();
    if (!cfg) {
      console.error(`autopilot serve: ${await noCredentialsMessage()}`);
      process.exit(2);
    }
    await ensureModelCatalog(cfg);
    const { startServer } = await import("./server/index.js");
    await startServer({
      port: cmdOpts.port,
      hostname: cmdOpts.hostname,
      config: cfg,
    });
  });

program.action(async () => {
  await main();
});
program.parse();

const opts = program.opts<{
  print?: string;
  model?: string;
  cloud?: boolean;
  dangerouslyAllowAll?: boolean;
  workerProfile?: string;
  reasoning?: boolean;
  thinking?: boolean;
  continueOnLimit?: boolean;
  maxTotalToolIterations?: number;
  maxInputTokens?: number;
  emitEvents?: boolean;
  multiTurn?: boolean;
  ui?: string;
  mode?: string;
  continue?: boolean;
  session?: string;
  file?: string[];
  format?: string;
  dir?: string;
  title?: string;
  attach?: string;
}>();

async function main() {
  // Initialize the OTLP/HTTP log exporter if `KIMIFLARE_OTEL_ENDPOINT`
  // is set. No-op otherwise — the env-var gate keeps this zero-cost for
  // users who don't care. Done before loadConfig so any early errors
  // ship too.
  const { initOtelSink, installOtelExitHook } = await import("./util/otel-sink.js");
  if (initOtelSink()) {
    installOtelExitHook();
  }

  const globalCfg = await loadConfig();
  const updateResult = await checkForUpdate();

  let cfg = globalCfg;
  let lspScope: "project" | "global" = "global";
  let lspProjectPath: string | null = null;

  if (globalCfg) {
    const resolved = await resolveLspConfig(globalCfg, process.cwd());
    cfg = {
      ...globalCfg,
      lspEnabled: resolved.lspEnabled,
      lspServers: resolved.lspServers,
    };
    lspScope = resolved.scope;
    lspProjectPath = resolved.projectPath;
  }

  // Load OpenRouter's model catalog (cache-first, 6h TTL; public endpoint, no
  // key needed) so context windows, pricing, capability gates and the model
  // picker reflect every model OpenRouter serves. Never blocks startup on a
  // network failure — the registry falls back to its seed list.
  // Requesty's catalog is loaded instead when Requesty is the gateway.
  await ensureModelCatalog(cfg);

  if (opts.cloud) {
    console.error("autopilot: --cloud ignored — KimiFlare Cloud was retired; autopilot runs on your own OpenRouter key.");
  }

  if (opts.mode === "rpc") {
    const { startRpcServer } = await import("./sdk/rpc.js");
    await startRpcServer();
    return;
  }

  // (`--ui camouflage` is opt-in experimental; the camouflage branch lives at
  // the bottom of `main()` next to the Ink path so both share the TTY guard
  // + cfg checks. Default is `ink` until Camouflage covers every surface and
  // we've burned-in via opt-in dogfooding.)

  if (opts.workerProfile && (opts.workerProfile !== "research" || opts.print === undefined)) {
    console.error(`autopilot: unsupported or misplaced worker profile "${opts.workerProfile}" (requires -p).`);
    process.exit(2);
  }

  if (opts.emitEvents) {
    if (opts.print === undefined) {
      console.error(
        "autopilot: --emit-events requires -p \"<prompt>\" (one-shot mode).\n" +
          "Multi-turn stdin-driven emit mode is not yet implemented.",
      );
      process.exit(2);
    }
    if (!cfg) {
      console.error("autopilot: --emit-events requires credentials.");
      process.exit(2);
    }
    const model = requireModel(opts.model || cfg.model);
    const { runEmitMode } = await import("./emit-mode.js");
    await runEmitMode({
      ...cfg,
      model,
      prompt: opts.print,
      allowAll: !!opts.dangerouslyAllowAll,
      multiTurn: !!opts.multiTurn,
      codeMode: cfg.codeMode,
      continueOnLimit: !!opts.continueOnLimit,
      maxTotalToolIterations: opts.maxTotalToolIterations ?? cfg.maxTotalToolIterations,
      maxInputTokens: opts.maxInputTokens,
    });
    return;
  }

  if (opts.print !== undefined) {
    if (!cfg) {
      console.error(`autopilot: ${await noCredentialsMessage()}`);
      process.exit(2);
    }
    const model = requireModel(opts.model || cfg.model);
    const format = (opts.format ?? "text") as PrintFormat;
    if (format !== "text" && format !== "json" && format !== "stream-json") {
      console.error(`autopilot: invalid --format "${format}". Use: text, json, stream-json`);
      process.exit(2);
    }

    // Attach mode: connect to a running server
    if (opts.attach) {
      const { runAttachMode } = await import("./attach-mode.js");
      await runAttachMode({
        attachUrl: opts.attach,
        prompt: opts.print,
        model,
        files: opts.file,
        format,
        allowAll: !!opts.dangerouslyAllowAll,
        sessionId: opts.session,
      });
      return;
    }

    await runPrintMode({
      ...cfg,
      model,
      prompt: opts.print,
      allowAll: !!opts.dangerouslyAllowAll,
      showReasoning: !!(opts.reasoning || opts.thinking),
      codeMode: cfg.codeMode,
      continueOnLimit: !!opts.continueOnLimit,
      maxTotalToolIterations: opts.maxTotalToolIterations ?? cfg.maxTotalToolIterations,
      maxInputTokens: opts.maxInputTokens,
      updateResult,
      continueSession: !!opts.continue,
      sessionId: opts.session,
      files: opts.file,
      format,
      dir: opts.dir,
      title: opts.title,
      permissions: cfg.permissions,
      workerProfile: opts.workerProfile as "research" | undefined,
      trace: cfg.trace,
      traceConfigSnapshot: cfg,
    });
    return;
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(
      "autopilot: interactive mode requires a TTY. Use `autopilot -p \"...\"` for non-TTY / piped usage.",
    );
    process.exit(2);
  }

  // ANSI logo. For the Ink path we still console.log it as part of the
  // pre-render output. For the Camouflage path we hand it to the
  // renderer as a Splash event so it stays visible until the user's
  // first prompt — console.log here would get swallowed by Camouflage's
  // alt-screen and flash for a fraction of a second.
  const logoText = renderLogo(getAppVersion(), opts.model ?? cfg?.model);

  // UI engine: Camouflage for everyone. A saved `uiEngine` is ignored;
  // only the hidden `--ui ink` / KIMIFLARE_UI=ink picks Ink. First-run setup
  // (no credentials yet) goes through Ink, and so does any machine where the
  // renderer can't start (no prebuilt binary for the platform).
  const uiEngine = (opts.ui ?? process.env.KIMIFLARE_UI ?? "camouflage").toLowerCase();
  if (uiEngine !== "ink" && cfg) {
    const model = requireModel(opts.model || cfg.model);
    const { runCamouflageView, CamouflageUnavailable } = await import("./camouflage-view.js");
    const { renderAppWithBridge } = await import("./app.js");
    try {
      await runCamouflageView({
        cfg: { ...cfg, model },
        version: getAppVersion(),
        runApp: (bridge) => renderAppWithBridge({ ...cfg, model }, bridge, updateResult, lspScope, lspProjectPath),
      });
      process.exit(0);
    } catch (err) {
      if (!(err instanceof CamouflageUnavailable)) throw err;
      logger.warn("camouflage.unavailable", { error: err.message });
    }
  }
  console.log(logoText);
  // React Ink UI.
  const { renderApp } = await import("./app.js");
  if (cfg) {
    const model = requireModel(opts.model || cfg.model);
    await renderApp({ ...cfg, model }, updateResult, lspScope, lspProjectPath);
  } else {
    await renderApp(null, updateResult, lspScope, lspProjectPath);
  }
}





/** Read a line from the terminal without echoing it (for secrets). */
/** The model to run, or exit with a hint (local runtimes and custom endpoints have no default). */
function requireModel(model: string | undefined): string {
  if (model) return model;
  console.error("autopilot: no model selected for this provider — pass -m <model-id>, set KIMI_MODEL, or pick one with /model.");
  process.exit(2);
}

/** What to do when the active provider has no credentials (print mode, serve). */
async function noCredentialsMessage(): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const { configPath } = await import("./config.js");
  const { resolveActiveProvider } = await import("./providers/resolve.js");
  let persisted: Partial<KimiConfig> = {};
  try {
    persisted = JSON.parse(await readFile(configPath(), "utf8")) as Partial<KimiConfig>;
  } catch {
    /* no file */
  }
  const { id, preset } = resolveActiveProvider(persisted);
  const how =
    id === "custom"
      ? "set KIMIFLARE_BASE_URL (and KIMIFLARE_API_KEY if your endpoint needs one)"
      : `set ${preset.apiKeyEnv[0]}${preset.keysUrl ? ` (create a key at ${preset.keysUrl})` : ""}, or run  autopilot auth ${id}`;
  return [
    `no ${preset.name} credentials configured.`,
    `To use ${preset.name}, ${how}.`,
    "Other providers: `autopilot auth status` lists them; e.g. OPENROUTER_API_KEY, OPENAI_API_KEY, DEEPSEEK_API_KEY,",
    "or AUTOPILOT_PROVIDER=ollama for a local Ollama.",
  ].join("\n");
}

/** Load the active provider's model catalog (see src/models/catalog.ts). */
async function ensureModelCatalog(cfg: KimiConfig | null): Promise<void> {
  const { llmAuthFromConfig } = await import("./agent/llm-auth.js");
  const { ensureCatalogForProvider } = await import("./models/catalog.js");
  await ensureCatalogForProvider(llmAuthFromConfig(cfg));
}

async function promptHidden(question: string): Promise<string> {
  const { createInterface } = await import("node:readline");
  const { Writable } = await import("node:stream");
  let muted = false;
  const output = new Writable({
    write(chunk, _enc, cb) {
      if (!muted) process.stdout.write(chunk);
      cb();
    },
  });
  const rl = createInterface({ input: process.stdin, output, terminal: true });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
    muted = true;
  });
}

/**
 * `autopilot auth openrouter` sign-in: browser + local callback by default;
 * with `code` (or over SSH / without a display) print a link to open on any
 * device and read the code OpenRouter shows back from the terminal.
 */
async function signInFromCli(codeMode: boolean): Promise<string> {
  const oauth = await import("./models/openrouter-oauth.js");
  const { openBrowser } = await import("./ui/app-helpers.js");
  const pkce = oauth.createPkce();
  if (codeMode || oauth.isHeadlessEnvironment()) {
    const url = oauth.buildAuthUrl({ challenge: pkce.challenge });
    console.log("Sign in with OpenRouter — open this link on any device and approve autopilot:\n");
    console.log(`  ${url}\n`);
    const { createInterface } = await import("node:readline/promises");
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = (await rl.question("Paste the code OpenRouter shows: ")).trim();
    rl.close();
    return oauth.exchangeCode(code, pkce.verifier);
  }
  const listener = await oauth.startLoopbackListener();
  const url = oauth.buildAuthUrl({ challenge: pkce.challenge, callbackUrl: listener.callbackUrl });
  const opened = openBrowser(url);
  console.log(
    opened
      ? "Opening your browser to sign in with OpenRouter — approve autopilot there."
      : "Open this link to sign in with OpenRouter and approve autopilot:",
  );
  console.log(`\n  ${url}\n`);
  console.log("Waiting… (Ctrl+C to cancel; use --code to sign in from another device)");
  const code = await listener.code;
  return oauth.exchangeCode(code, pkce.verifier);
}
