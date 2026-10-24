import { Command, Option } from "commander";
import { logger } from "./util/logger.js";
import { loadConfig, type KimiConfig } from "./config.js";
import { PROVIDER_PRESETS } from "./providers/presets.js";
import { resolveLspConfig } from "./util/lsp-config.js";
import { checkForUpdate } from "./util/update-check.js";
import type { UpdateCheckResult } from "./util/update-check.js";
import { getAppVersion } from "./util/version.js";
import { runPrintMode } from "./print-mode.js";
import { registerEvalCommand } from "./eval/cli.js";
import type { PrintFormat } from "./print-mode.js";
import type { InteractiveResumeRequest } from "./interactive-resume.js";

/** `autopilot resume [id]`: reopen a conversation in the interactive UI. */
let resumeCommand: InteractiveResumeRequest | null = null;

const program = new Command();
program
  .name("autopilot")
  .description("Terminal coding agent. Bring your own provider: OpenRouter, OpenAI, DeepSeek, Kimi, Z.ai, Ollama, any OpenAI-compatible endpoint.")
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
  .option("--mode <mode>", "run mode: interactive (default), print, rpc")
  .option("-c, --continue", "continue the most recent session in the current working directory")
  .option("-S, --session <id>", "resume a specific session by id")
  .option("-f, --file <path>", "attach file(s) to the prompt; repeatable, supports globs (print mode only)", (v, prev: string[] | undefined) => (prev ?? []).concat(v))
  .option("--format <mode>", "output format for print mode: text (default), json, stream-json")
  .option("--dir <path>", "run in the specified directory instead of the current one (print mode only)")
  .option("--title <title>", "override the auto-generated session title (print mode only)")
  .option("--attach <url>", "attach to a running autopilot serve instance (print mode only)")
  .option("--on <server>", "run the task on a paired server (autopilot remote add) instead of this machine")
  .option("--local", "run on this machine (the default)")
  .option("--repo <owner/name>", "with --on: GitHub repository (default: this checkout's origin)")
  .option("--detach", "with --on: start the task and return without streaming its output")
  .argument("[task...]", "with --on: the task to run on the server");

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

/** Runs a remote-server command: Ctrl-C aborts it, and errors print as one line. */
async function runRemoteCommand(fn: (signal: AbortSignal) => Promise<number | void>): Promise<void> {
  const controller = new AbortController();
  const onInterrupt = () => controller.abort();
  process.once("SIGINT", onInterrupt);
  try {
    const code = await fn(controller.signal);
    if (typeof code === "number") process.exitCode = code;
  } catch (error) {
    if (controller.signal.aborted) return;
    const { describeError } = await import("./remote/cli.js");
    console.error(`autopilot: ${describeError(error)}`);
    process.exitCode = 1;
  } finally {
    process.off("SIGINT", onInterrupt);
  }
}

const remoteCommand = program.command("remote").description("Pair this machine with Autopilot servers that run tasks for you");
remoteCommand
  .command("add")
  .description("Pair with a server: approve the code it shows in your browser (no keys copied)")
  .argument("<url>", "server URL, e.g. https://acme.example.com")
  .option("-n, --name <name>", "short name for --on (default: the host's first label)")
  .option("--no-open", "print the approval link instead of opening a browser")
  .action((url: string, cmdOpts: { name?: string; open: boolean }) => runRemoteCommand(async (signal) => {
    const { remoteAdd } = await import("./remote/cli.js");
    await remoteAdd({ url, open: cmdOpts.open, signal, ...(cmdOpts.name ? { name: cmdOpts.name } : {}) });
  }));
remoteCommand
  .command("list")
  .description("List paired servers")
  .action(() => runRemoteCommand(async () => {
    const { remoteList } = await import("./remote/cli.js");
    await remoteList();
  }));
remoteCommand
  .command("remove")
  .description("Forget a paired server")
  .argument("<name>")
  .action((name: string) => runRemoteCommand(async () => {
    const { remoteRemove } = await import("./remote/cli.js");
    return (await remoteRemove(name)) ? 0 : 1;
  }));

const runsCommand = program
  .command("runs")
  .description("List tasks running or finished on your servers")
  .option("--on <server>", "only this server")
  .option("--json", "machine-readable output")
  .action((cmdOpts: { on?: string; json?: boolean }) => runRemoteCommand(async () => {
    const { listRuns } = await import("./remote/cli.js");
    await listRuns({ ...(cmdOpts.on ? { remote: cmdOpts.on } : {}), json: !!cmdOpts.json });
  }));
runsCommand
  .command("watch")
  .description("Show a run's output and follow it until it ends (Ctrl-C detaches)")
  .argument("<run>", "run ID or prefix")
  .option("--on <server>", "server the run is on")
  .action((id: string, cmdOpts: { on?: string }) => runRemoteCommand(async (signal) => {
    const { watchRun } = await import("./remote/cli.js");
    return watchRun({ id, signal, ...(cmdOpts.on ? { remote: cmdOpts.on } : {}) });
  }));
runsCommand
  .command("cancel")
  .description("Stop a running task")
  .argument("<run>", "run ID or prefix")
  .option("--on <server>", "server the run is on")
  .action((id: string, cmdOpts: { on?: string }) => runRemoteCommand(async () => {
    const { cancelRun } = await import("./remote/cli.js");
    await cancelRun({ id, ...(cmdOpts.on ? { remote: cmdOpts.on } : {}) });
  }));

program
  .command("pull")
  .description("Check out a run's branch in this repository")
  .argument("<run>", "run ID or prefix")
  .option("--on <server>", "server the run is on")
  .action((id: string, cmdOpts: { on?: string }) => runRemoteCommand(async () => {
    const { pullRun } = await import("./remote/cli.js");
    await pullRun({ id, cwd: process.cwd(), ...(cmdOpts.on ? { remote: cmdOpts.on } : {}) });
  }));
registerEvalCommand(program);

const asterCommand = program.command("aster").description("Manage the Aster mobile API");
asterCommand
  .command("setup")
  .description("Configure Aster for one or more local Git workspaces")
  .requiredOption("-w, --workspace <path>", "Local Git repository root (repeatable)", (value, previous: string[] = []) => [...previous, value])
  .option("--json", "Print the selected workspace IDs as JSON")
  .action(async (options: { workspace: string[]; json?: boolean }) => {
    const { setupLocalAsterConfig } = await import("./server/aster-setup.js");
    try {
      const setup = await setupLocalAsterConfig({ workspacePaths: options.workspace });
      const result = {
        configPath: setup.path,
        workspaces: setup.selectedWorkspaces.map(({ id, displayName, rootPath }) => ({ id, displayName, rootPath })),
      };
      if (options.json) {
        console.log(JSON.stringify(result));
      } else {
        console.log(`Aster config: ${setup.path}`);
        for (const workspace of result.workspaces) console.log(`Workspace: ${workspace.id} · ${workspace.displayName}`);
      }
    } catch (error) {
      console.error(`autopilot aster setup: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 2;
    }
  });

const asterTokenCommand = asterCommand.command("token").description("Manage scoped Aster API credentials");
asterTokenCommand
  .command("create")
  .description("Create a 30-day credential scoped to selected workspace IDs")
  .requiredOption("-n, --name <name>", "Credential label")
  .requiredOption("-w, --workspace <id>", "Allowed workspace ID (repeatable)", (value, previous: string[] = []) => [...previous, value])
  .option("--expires-in-days <days>", "Expiry in days (1-365)", (value) => Number.parseInt(value, 10), 30)
  .option("--json", "Print the newly created credential as JSON (includes the one-time token)")
  .action(async (options: { name: string; workspace: string[]; expiresInDays: number; json?: boolean }) => {
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
        if (options.json) {
          console.log(JSON.stringify({
            credentialId: created.id,
            workspaceIds: created.workspaceIds,
            scopes: created.scopes,
            createdAt: created.createdAt,
            expiresAt: created.expiresAt,
            token: created.token,
          }));
        } else {
          console.log(`Credential ID: ${created.id}`);
          console.log(`Workspace scope: ${created.workspaceIds.join(", ")}`);
          console.log(`Expires: ${new Date(created.expiresAt).toISOString()}`);
          console.log("Copy this token into the Aster app's Keychain now; it will not be shown again:");
          console.log(created.token);
        }
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

const asterPairCommand = asterCommand.command("pair").description("Approve devices pairing with this server (run on the server)");
asterPairCommand
  .command("list")
  .description("List pairing codes waiting for approval")
  .action(async () => {
    const { AsterStore } = await import("./server/aster-store.js");
    const store = new AsterStore();
    try {
      const pending = store.listPendingDeviceAuthorizations();
      if (pending.length === 0) console.log("No pairings waiting.");
      for (const entry of pending) console.log(`${entry.userCode}  ${entry.clientName}  expires ${new Date(entry.expiresAt).toISOString()}`);
    } finally {
      store.close();
    }
  });
for (const decision of ["approve", "deny"] as const) {
  asterPairCommand
    .command(decision)
    .description(decision === "approve" ? "Approve the code a device shows; it receives a 90-day credential for every workspace" : "Deny the code a device shows")
    .argument("<code>")
    .action(async (code: string) => {
      const { AsterStore } = await import("./server/aster-store.js");
      const { CLIENT_CREDENTIAL_TTL_MS, configuredWorkspaceIds } = await import("./server/aster-pairing.js");
      const workspaceIds = await configuredWorkspaceIds();
      if (!workspaceIds) {
        console.error("Aster workspaces are not configured on this server (see autopilot aster setup).");
        process.exitCode = 2;
        return;
      }
      const store = new AsterStore();
      try {
        const outcome = store.resolveDeviceAuthorization(code, decision, { workspaceIds, credentialTtlMs: CLIENT_CREDENTIAL_TTL_MS });
        const messages = {
          approved: "Approved. The device finishes signing in on its own.",
          denied: "Denied.",
          not_found: "No pairing with that code.",
          expired: "That code expired; start pairing again on the device.",
          already_resolved: "That code was already approved or denied.",
        } as const;
        if (outcome === "approved" || outcome === "denied") console.log(messages[outcome]);
        else {
          console.error(messages[outcome]);
          process.exitCode = 1;
        }
      } finally {
        store.close();
      }
    });
}

asterCommand
  .command("owner")
  .description("Owner access for approving devices in a browser")
  .command("link")
  .description("Print a one-time link (valid 24 hours) that makes the browser opening it this server's owner")
  .option("--url <base>", "Public base URL of this server (default: AUTOPILOT_PUBLIC_URL)")
  .action(async (options: { url?: string }) => {
    const base = (options.url ?? process.env.AUTOPILOT_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    if (!/^https?:\/\/[^\s/]+$/.test(base)) {
      console.error("Pass --url https://your-server (or set AUTOPILOT_PUBLIC_URL).");
      process.exitCode = 2;
      return;
    }
    const { AsterStore } = await import("./server/aster-store.js");
    const { OWNER_CLAIM_TTL_MS } = await import("./server/aster-pairing.js");
    const store = new AsterStore();
    try {
      const claim = store.createOwnerClaim(OWNER_CLAIM_TTL_MS);
      console.log(`${base}/api/v1/auth/claim?token=${claim.token}`);
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
  .command("trust")
  .description("Review and trust this project's hooks and LSP servers (they do not run until trusted)")
  .argument("[dir]", "project directory (default: the current directory)")
  .option("-y, --yes", "trust without asking (after reviewing the listed commands yourself)")
  .action(async (dir: string | undefined, opts: { yes?: boolean }) => {
    const { resolve } = await import("node:path");
    const { formatPendingReview, pendingProjectConfig, trustPendingProjectConfig } = await import("./util/project-config-review.js");
    const cwd = resolve(dir ?? process.cwd());
    const pending = pendingProjectConfig(cwd);
    if (pending.length === 0) {
      console.log("Nothing to trust: this project has no untrusted hooks or LSP servers.");
      return;
    }
    console.log("These project files run commands on this machine and are not trusted:");
    console.log(formatPendingReview(pending));
    if (!opts.yes) {
      if (!process.stdin.isTTY) {
        console.error("Not a terminal: re-run with --yes to trust the files above.");
        process.exitCode = 1;
        return;
      }
      const { createInterface } = await import("node:readline/promises");
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      const answer = (await rl.question("Trust exactly this content? [y/N] ")).trim().toLowerCase();
      rl.close();
      if (answer !== "y" && answer !== "yes") {
        console.log("Not trusted.");
        return;
      }
    }
    const trusted = trustPendingProjectConfig(cwd);
    console.log(`Trusted ${trusted.map((p) => p.path).join(", ")}. Any later change to these files needs review again.`);
  });

program
  .command("resume")
  .description("Reopen a saved conversation: by id, or pick one from this directory")
  .argument("[id]", "session id (printed when you exit autopilot)")
  .action(async (id: string | undefined) => {
    resumeCommand = id ? { sessionId: id } : {};
    await main();
    const { runShutdownTasks } = await import("./util/exit.js");
    await runShutdownTasks();
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
      .description("Make a provider the active one: openrouter, requesty, anthropic, openai, chatgpt, gemini, vertex, bedrock, minimax, copilot, xai, mistral, groq, cerebras, together, fireworks, deepinfra, vercel, cloudflare, azure, deepseek, moonshot, kimi-code, zai, zai-coding, ollama, lmstudio, custom")
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

for (const id of ["anthropic", "openai", "gemini", "minimax", "xai", "mistral", "groq", "cerebras", "together", "fireworks", "deepinfra", "vercel", "cloudflare", "azure", "deepseek", "moonshot", "kimi-code", "zai", "zai-coding", "ollama", "lmstudio"] as const) {
  authCommand.addCommand(
    new Command(id)
      .description(
        PROVIDER_PRESETS[id].keyRequired
          ? `Connect ${PROVIDER_PRESETS[id].name} with an API key (validated, saved to config.json) and make it the active provider`
          : `Use a local ${PROVIDER_PRESETS[id].name} (checks it is reachable) as the active provider`,
      )
      .argument("[key]", "the key to save instead of pasting one")
      .option("--base-url <url>", "use a different endpoint (e.g. Ollama on another host)")
      .option("--account-id <id>", "Cloudflare account id (Workers AI)")
      .option("--resource <name>", "Azure OpenAI resource name (https://<name>.openai.azure.com)")
      .action(async (keyArg: string | undefined, cmdOpts: { baseUrl?: string; accountId?: string; resource?: string }) => {
        if (id === "azure" && cmdOpts.resource && !cmdOpts.baseUrl) cmdOpts.baseUrl = `https://${cmdOpts.resource}.openai.azure.com/openai/v1`;
        if (id === "azure" && !cmdOpts.baseUrl && !process.env.AZURE_RESOURCE_NAME) {
          console.error("Azure OpenAI needs your resource: pass --resource <name> (or --base-url), or set AZURE_RESOURCE_NAME.");
          process.exit(1);
        }
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
        if (id === "cloudflare") {
          const accountId = cmdOpts.accountId ?? process.env.CLOUDFLARE_ACCOUNT_ID ?? (await loadConfig().catch(() => null))?.accountId;
          if (!accountId) {
            console.error("Workers AI needs your Cloudflare account id: pass --account-id <id> or set CLOUDFLARE_ACCOUNT_ID.");
            process.exit(1);
          }
          const { patchPersistedConfig } = await import("./config.js");
          await patchPersistedConfig({ accountId });
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
  new Command("bedrock")
    .description("Use Amazon Bedrock with your AWS credentials or a Bedrock API key, and make it the active provider")
    .option("--region <region>", "AWS region (default: AWS_REGION / AWS_DEFAULT_REGION / us-east-1)")
    .action(async (cmdOpts: { region?: string }) => {
      const { bedrockAuth } = await import("./providers/bedrock.js");
      const { patchProviderSettings, switchProvider } = await import("./providers/keys.js");
      if (!bedrockAuth()) {
        console.error("No AWS credentials found. Set AWS_BEARER_TOKEN_BEDROCK (a Bedrock API key), or AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY, or configure ~/.aws/credentials (AWS_PROFILE). For SSO: eval \"$(aws configure export-credentials --format env)\".");
        process.exit(1);
      }
      if (cmdOpts.region) await patchProviderSettings("bedrock", { region: cmdOpts.region });
      await switchProvider(await loadConfig().catch(() => null), "bedrock");
      console.log(`✓ Amazon Bedrock${cmdOpts.region ? ` (${cmdOpts.region})` : ""} is now the active provider.`);
    }),
);

authCommand.addCommand(
  new Command("vertex")
    .description("Use Google Vertex AI with your Google credentials (ADC) and make it the active provider")
    .option("--project <id>", "Google Cloud project (default: GOOGLE_VERTEX_PROJECT / GOOGLE_CLOUD_PROJECT / gcloud config)")
    .option("--location <location>", "Vertex location (default: global)")
    .action(async (cmdOpts: { project?: string; location?: string }) => {
      const { vertexAccessToken, vertexProject, adcProject } = await import("./providers/vertex.js");
      const { switchProvider } = await import("./providers/keys.js");
      const { patchPersistedConfig } = await import("./config.js");
      const cfg = await loadConfig().catch(() => null);
      const project = cmdOpts.project ?? vertexProject(cfg?.providers?.vertex) ?? (await adcProject());
      if (!project) {
        console.error("No Google Cloud project: pass --project <id> or set GOOGLE_VERTEX_PROJECT.");
        process.exit(1);
      }
      try {
        await vertexAccessToken();
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
      const settings = { ...cfg?.providers?.vertex, project, ...(cmdOpts.location ? { location: cmdOpts.location } : {}) };
      await patchPersistedConfig({ providers: { ...cfg?.providers, vertex: settings } });
      await switchProvider(await loadConfig().catch(() => null), "vertex");
      console.log(`✓ Google Vertex AI (project ${project}, ${cmdOpts.location ?? settings.location ?? "global"}) is now the active provider.`);
    }),
);

authCommand.addCommand(
  new Command("chatgpt")
    .description("Sign in with ChatGPT (token sharing) to use your ChatGPT plan's models, and make it the active provider")
    .action(async () => {
      const { hostId, startChatGPTSignIn, saveChatGPTSettings } = await import("./providers/chatgpt.js");
      const { switchProvider } = await import("./providers/keys.js");
      const { openBrowser } = await import("./ui/app-helpers.js");
      try {
        const cfg = await loadConfig().catch(() => null);
        const signIn = await startChatGPTSignIn({ savedClientId: cfg?.providers?.chatgpt?.clientId, hostId: await hostId() });
        console.log("Opening your browser to sign in with ChatGPT — allow token sharing for Autopilot.");
        console.log(`If it doesn't open: ${signIn.url}`);
        openBrowser(signIn.url);
        await saveChatGPTSettings(await signIn.done);
        await switchProvider(await loadConfig().catch(() => null), "chatgpt");
        console.log("✓ Signed in with ChatGPT — now the active provider. Usage counts against your ChatGPT plan.");
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    }),
);

authCommand.addCommand(
  new Command("copilot")
    .description("Sign in to GitHub Copilot with GitHub's device login and make Copilot the active provider")
    .option("--enterprise <domain>", "GitHub Enterprise domain (e.g. company.ghe.com)")
    .action(async (cmdOpts: { enterprise?: string }) => {
      const { startDeviceFlow, pollDeviceFlow, checkCopilotAccess } = await import("./providers/copilot.js");
      const { saveProviderKey, switchProvider } = await import("./providers/keys.js");
      try {
        const code = await startDeviceFlow(cmdOpts.enterprise);
        console.log(`Open ${code.verificationUri} and enter the code: ${code.userCode}`);
        console.log("Waiting for you to approve…");
        const token = await pollDeviceFlow(code, cmdOpts.enterprise);
        const access = await checkCopilotAccess(token, cmdOpts.enterprise);
        const savedTo = await saveProviderKey("copilot", token, access.apiBase);
        await switchProvider(await loadConfig().catch(() => null), "copilot");
        console.log(`✓ Connected to GitHub Copilot${access.plan ? ` (${access.plan} plan)` : ""} — now the active provider.`);
        console.log(`Saved to ${savedTo}. Run \`autopilot\` and pick a model with /model.`);
      } catch (e) {
        console.error(e instanceof Error ? e.message : String(e));
        process.exit(1);
      }
    }),
);

authCommand.addCommand(
    new Command("github")
      .description("Authenticate with GitHub via OAuth device flow")
      .action(async () => {
        const { authGitHubForTui } = await import("./util/github-auth.js");
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
    const { resolveServeConfig } = await import("./server/serve-config.js");
    const resolved = resolveServeConfig(await loadConfig());
    if (!resolved) {
      console.error(`autopilot serve: ${await noCredentialsMessage()}`);
      process.exit(2);
    }
    if (resolved.asterOnly) {
      console.error("autopilot serve: no provider key on this host; serving the Aster API, whose cells reach the model through Hotcell's gateway.");
    }
    const cfg = resolved.config;
    await initOtel();
    await ensureModelCatalog(cfg);
    const { startServer } = await import("./server/index.js");
    try {
      await startServer({
        port: cmdOpts.port,
        hostname: cmdOpts.hostname,
        config: cfg,
      });
    } catch (err) {
      // Expected startup failures (no password off-loopback, port in use): a message, not a stack trace.
      console.error(`autopilot serve: ${(err as Error).message}`);
      process.exit(1);
    }
  });

/** Positional words after the options: a task for --on. */
let positionalTask: string[] = [];

program.action(async (task: string[] = []) => {
  positionalTask = task;
  await main();
  // Every mode that returns normally (TUI, print, emit, RPC): end open
  // sessions and flush OTel before the event loop drains (#877).
  const { runShutdownTasks } = await import("./util/exit.js");
  await runShutdownTasks();
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
  on?: string;
  local?: boolean;
  repo?: string;
  detach?: boolean;
}>();

/** Start the OTLP exporter when KIMIFLARE_OTEL_ENDPOINT is set, flushed at exit. */
async function initOtel(): Promise<void> {
  const { initOtelSink, installOtelExitHook, shutdownOtelSink } = await import("./util/otel-sink.js");
  const { onShutdown, SHUTDOWN_PHASE } = await import("./util/exit.js");
  if (initOtelSink()) {
    installOtelExitHook();
    onShutdown("otel-flush", shutdownOtelSink, SHUTDOWN_PHASE.flush);
  }
}

/** `autopilot --on <server> "task"`: the task runs in a sandbox on a paired server. */
async function runRemoteTask(): Promise<void> {
  if (opts.on === undefined) {
    console.error(`autopilot: unknown command "${positionalTask[0]}". To run a task here use -p "…"; on a server, --on <server> "…".`);
    process.exit(2);
  }
  if (opts.local) {
    console.error("autopilot: --on and --local can't be combined.");
    process.exit(2);
  }
  const task = (positionalTask.join(" ") || opts.print || "").trim();
  if (!task) {
    console.error(`autopilot: --on needs a task, e.g. autopilot --on ${opts.on} "fix the flaky checkout test"`);
    process.exit(2);
  }
  const cfg = await loadConfig().catch(() => null);
  await runRemoteCommand(async (signal) => {
    const { runOnRemote } = await import("./remote/cli.js");
    return runOnRemote({
      remote: opts.on,
      task,
      cwd: opts.dir ?? process.cwd(),
      signal,
      detach: !!opts.detach,
      ...(opts.model ? { model: opts.model } : {}),
      ...(cfg?.model ? { preferredModel: cfg.model } : {}),
      ...(opts.repo ? { repository: opts.repo } : {}),
    });
  });
}

async function main() {
  // Initialize the OTLP/HTTP log exporter if `KIMIFLARE_OTEL_ENDPOINT`
  // is set. No-op otherwise — the env-var gate keeps this zero-cost for
  // users who don't care. Done before loadConfig so any early errors
  // ship too.
  await initOtel();
  // SessionEnd hooks and the OTel flush on SIGTERM/SIGHUP and crashes too
  // (#877). SIGINT stays with each mode: it cancels the turn first.
  const { installExitHandlers } = await import("./util/exit.js");
  installExitHandlers({ crashes: true });
  const { brotliRuntimeAdvisory } = await import("./util/runtime-advisory.js");
  const runtimeAdvisory = brotliRuntimeAdvisory();
  if (runtimeAdvisory) process.stderr.write(`warning: ${runtimeAdvisory} web_fetch is disabled until then.\n`);

  if (opts.on !== undefined || positionalTask.length > 0) {
    await runRemoteTask();
    return;
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
    console.error("autopilot: --cloud ignored — KimiFlare Cloud was retired; autopilot runs on your own provider key.");
  }

  if (opts.mode === "rpc") {
    const { startRpcServer } = await import("./sdk/rpc.js");
    await startRpcServer();
    return;
  }

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

  // Camouflage is the only interface. First-run setup (no credentials yet)
  // runs inside it before the session starts. A machine where the renderer
  // can't start gets an explanation and exit code 2.
  // `autopilot resume [id]`, `-c` or `-S <id>`: which saved session to open (#906).
  const startup = await interactiveStartup(cfg);
  // Null on first run until Camouflage's onboarding saves a provider and model.
  let sessionCfg: KimiConfig | null = cfg ? { ...cfg, model: requireModel(opts.model || cfg.model) } : null;
  const { runCamouflageView } = await import("./camouflage-view.js");
  const { CamouflageUnavailable, runWithCrashRestarts, crashGiveUpMessage } = await import("./camouflage-launch.js");
  const { renderAppWithBridge } = await import("./app.js");
  const { gracefulExit } = await import("./util/exit.js");
  try {
    // Assigned inside the restart callback, so TypeScript must not narrow it to "done".
    let result = "done" as Awaited<ReturnType<typeof runCamouflageView>>;
    // The renderer dying mid-session (#862) doesn't end the user's work: the
    // session is saved after every turn, so mount a fresh renderer on it, a
    // bounded number of times. A crash during first-run setup (no session
    // yet) restarts setup.
    const outcome = await runWithCrashRestarts(
      async (resumeSessionId) => {
        result = await runCamouflageView({
          cfg: sessionCfg,
          version: getAppVersion(),
          runApp: async (bridge, appCfg) => {
            if (appCfg !== sessionCfg) {
              // Just onboarded: pick up the project's LSP settings like a normal start.
              const resolved = await resolveLspConfig(appCfg, process.cwd());
              appCfg = { ...appCfg, lspEnabled: resolved.lspEnabled, lspServers: resolved.lspServers };
              lspScope = resolved.scope;
              lspProjectPath = resolved.projectPath;
              sessionCfg = appCfg;
            }
            // After a crash, reopen the session the crashed renderer was saving;
            // otherwise honour `autopilot resume` / `-c` / `-S`.
            return renderAppWithBridge(
              appCfg,
              bridge,
              updateResult,
              lspScope,
              lspProjectPath,
              resumeSessionId ? { resumeSessionId, resumeReason: "crash" } : startup,
            );
          },
        });
      },
      {
        onRestart: ({ sessionId, restart, error }) => {
          logger.warn("camouflage.crash_restart", { error: error.message, sessionId, restart });
          process.stderr.write(sessionId ? "Reopening this conversation…\n" : "Restarting the renderer…\n");
        },
      },
    );
    if (outcome.gaveUp) {
      logger.error("camouflage.crash_gave_up", { error: outcome.lastError.message, sessionId: outcome.sessionId, crashes: outcome.crashes });
      process.stderr.write(crashGiveUpMessage(outcome));
      await gracefulExit(1);
    }
    await gracefulExit(result === "setup-failed" ? 1 : 0);
  } catch (err) {
    if (!(err instanceof CamouflageUnavailable)) throw err;
    logger.warn("camouflage.unavailable", { error: err.reason });
    process.stderr.write(err.message);
    process.exit(2);
  }
}

/** `autopilot resume [id]`, or `-c` / `-S <id>` without `-p`: which
 *  conversation the interactive UI reopens on start. Exits on a bad id. */
async function interactiveStartup(cfg: KimiConfig | null): Promise<import("./app.js").RenderAppOpts> {
  const request: InteractiveResumeRequest | null =
    resumeCommand ?? (opts.session ? { sessionId: opts.session } : opts.continue ? { latest: true } : null);
  if (!request) return {};
  const { resolveInteractiveResume } = await import("./interactive-resume.js");
  const target = await resolveInteractiveResume(request);
  if (target.kind === "error") {
    console.error(`autopilot: ${target.message}`);
    process.exit(1);
  }
  if (!cfg) return {};
  return target.kind === "picker" ? { openResumePicker: true } : { resumeSessionId: target.sessionId, resumeReason: "user" };
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
