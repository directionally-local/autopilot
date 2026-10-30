import { HotcellClient, type CreateOptions, type Sandbox } from "@hotcell/sdk";

export const HOTCELL_CONVERSATION_LABEL = "autopilot.conversation_id";

export type HotcellDriver = "applevz" | "firecracker" | "container";
const HOTCELL_DRIVERS: readonly HotcellDriver[] = ["applevz", "firecracker", "container"];

export interface HotcellProviderConfig {
  endpoint: string;
  apiKey: string;
  driver: HotcellDriver;
  /** Give the cell general outbound internet (npm, git, pip) in addition to the LLM gateway. */
  networked?: boolean;
  /** Let the cell's gateway token call any model, so a conversation can switch models mid-chat. */
  anyModel?: boolean;
  /** Idle ms before Hotcell pauses the cell to release CPU/memory (files persist). 0 = never. */
  sleepAfterMs?: number;
  /** Cell image, e.g. one with the Autopilot runtime preinstalled; omit for the daemon default. */
  image?: string;
  /** Memory for plain chat cells (no repository); defaults to memoryMb. */
  chatMemoryMb?: number;
  memoryMb: number;
  cpus: number;
  pidsLimit: number;
  spendCapUsd: number;
  tokenTtlMs: number;
}

export interface HotcellClientPort {
  getSandbox(id?: string, options?: CreateOptions): Promise<Sandbox>;
  list(): ReturnType<HotcellClient["list"]>;
  info(): ReturnType<HotcellClient["info"]>;
}

export type HotcellClientFactory = (options: { endpoint: string; apiKey: string }) => HotcellClientPort;

export class HotcellProviderError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = "HotcellProviderError";
  }
}

/** Thin, injectable adapter over Hotcell's supported SDK. */
export class HotcellProvider {
  private readonly client: HotcellClientPort;

  constructor(
    private readonly config: HotcellProviderConfig,
    clientFactory: HotcellClientFactory = (options) => new HotcellClient(options),
  ) {
    validateConfig(config);
    this.client = clientFactory({ endpoint: config.endpoint, apiKey: config.apiKey });
  }

  static fromEnvironment(env: NodeJS.ProcessEnv = process.env): HotcellProvider {
    const endpoint = env.AUTOPILOT_HOTCELL_ENDPOINT;
    const apiKey = env.AUTOPILOT_HOTCELL_API_KEY;
    const driver = env.AUTOPILOT_HOTCELL_DRIVER;
    if (!endpoint || !apiKey || !HOTCELL_DRIVERS.includes(driver as HotcellDriver)) {
      throw new HotcellProviderError(
        "Aster Hotcell requires AUTOPILOT_HOTCELL_ENDPOINT, AUTOPILOT_HOTCELL_API_KEY, and an explicit AUTOPILOT_HOTCELL_DRIVER (applevz, firecracker, or container)",
        "hotcell_not_configured",
      );
    }
    return new HotcellProvider({
      endpoint,
      apiKey,
      driver: driver as HotcellDriver,
      networked: env.AUTOPILOT_HOTCELL_NETWORKED === "true",
      anyModel: env.AUTOPILOT_HOTCELL_ANY_MODEL === "true",
      sleepAfterMs: integerEnv(env.AUTOPILOT_HOTCELL_SLEEP_AFTER_MS, 0, 0, 7 * 24 * 60 * 60 * 1000),
      ...(env.AUTOPILOT_HOTCELL_IMAGE ? { image: env.AUTOPILOT_HOTCELL_IMAGE } : {}),
      ...(env.AUTOPILOT_HOTCELL_CHAT_MEMORY_MB ? { chatMemoryMb: integerEnv(env.AUTOPILOT_HOTCELL_CHAT_MEMORY_MB, 1024, 512, 65_536) } : {}),
      memoryMb: integerEnv(env.AUTOPILOT_HOTCELL_MEMORY_MB, 4096, 512, 65_536),
      cpus: numberEnv(env.AUTOPILOT_HOTCELL_CPUS, 2, 0.5, 64),
      pidsLimit: integerEnv(env.AUTOPILOT_HOTCELL_PIDS, 256, 32, 8192),
      spendCapUsd: numberEnv(env.AUTOPILOT_HOTCELL_SPEND_CAP_USD, 10, 0.01, 10_000),
      tokenTtlMs: integerEnv(env.AUTOPILOT_HOTCELL_TOKEN_TTL_MS, 24 * 60 * 60 * 1000, 60_000, 30 * 24 * 60 * 60 * 1000),
    });
  }

  /** Find an existing cell by stable label before creating, making retries adopt rather than duplicate it. */
  async findConversationCell(conversationId: string): Promise<Sandbox | undefined> {
    const matches = (await this.client.list()).filter((item) => item.labels?.[HOTCELL_CONVERSATION_LABEL] === conversationId);
    if (matches.length > 1) {
      throw new HotcellProviderError("Multiple Hotcells carry the same Aster conversation label; refusing ambiguous attachment", "duplicate_hotcells");
    }
    return matches[0] ? this.client.getSandbox(matches[0].id) : undefined;
  }

  async createConversationCell(input: {
    conversationId: string;
    workspaceId: string;
    model: string;
    /** Hotcell egress route (named after Autopilot's provider preset id); default "openrouter". */
    provider?: string;
    /** "code" cells also get GitHub (API and git) through the credential gateway. */
    kind?: "chat" | "code";
    /** Code cells using Aster's repository-scoped GitHub proxy skip Hotcell's GitHub gateway. */
    githubViaProxy?: boolean;
    env?: Record<string, string>;
  }): Promise<Sandbox> {
    const provider = input.provider ?? "openrouter";
    if (!isUuid(input.conversationId) || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.workspaceId) || !input.model.trim() || !/^[a-z][a-z0-9-]{0,63}$/.test(provider)) {
      throw new HotcellProviderError("Invalid Hotcell conversation provisioning input", "invalid_provisioning_input");
    }

    const existing = await this.findConversationCell(input.conversationId);
    if (existing) return existing;

    const info = await this.client.info();
    if (!info.auth) throw new HotcellProviderError("Hotcell API authentication is disabled; refusing to provision an Aster cell", "hotcell_auth_required");
    if (!info.drivers.includes(this.config.driver)) {
      throw new HotcellProviderError("Configured Hotcell driver is unavailable", "hotcell_driver_unavailable");
    }
    if (!info.egressProviders.includes(provider)) {
      throw new HotcellProviderError(`Hotcell credential gateway has no "${provider}" egress route`, "hotcell_egress_unavailable");
    }
    if (input.kind === "code" && !input.githubViaProxy && !info.egressProviders.includes("github")) {
      throw new HotcellProviderError("Hotcell GitHub credential gateway is unavailable", "hotcell_github_unavailable");
    }

    const options: CreateOptions = {
      driver: this.config.driver,
      ...(this.config.image ? { image: this.config.image } : {}),
      ...(input.env ? { env: input.env } : {}),
      networked: this.config.networked === true,
      persist: true,
      sleepAfter: this.config.sleepAfterMs ?? 0,
      memoryMb: input.kind === "chat" ? (this.config.chatMemoryMb ?? this.config.memoryMb) : this.config.memoryMb,
      cpus: this.config.cpus,
      pidsLimit: this.config.pidsLimit,
      egressSpendCapUsd: this.config.spendCapUsd,
      egress: {
        providers: input.kind === "code" && !input.githubViaProxy ? [provider, "github", "github-git"] : [provider],
        ...(this.config.anyModel ? {} : { models: [input.model] }),
        spendCapUsd: this.config.spendCapUsd,
        ttlMs: this.config.tokenTtlMs,
      },
      labels: {
        [HOTCELL_CONVERSATION_LABEL]: input.conversationId,
        "autopilot.workspace_id": input.workspaceId,
      },
    };

    try {
      return await this.client.getSandbox(undefined, options);
    } catch {
      // A timed-out create may have completed at the daemon. Adopt by label; never blindly POST again.
      const recovered = await this.findConversationCell(input.conversationId).catch(() => undefined);
      if (recovered) return recovered;
      throw new HotcellProviderError("Hotcell creation did not return a cell; provisioning remains uncertain and will not be retried blindly", "hotcell_create_uncertain");
    }
  }

  async getCell(cellId: string): Promise<Sandbox> {
    if (!cellId.trim()) throw new HotcellProviderError("Missing Hotcell id", "hotcell_id_missing");
    return this.client.getSandbox(cellId);
  }

  async destroyConversationCell(cellId: string): Promise<void> {
    if (!cellId.trim()) return;
    const all = await this.client.list();
    if (!all.some((item) => item.id === cellId)) return;

    const cell = await this.client.getSandbox(cellId);
    const { tokens } = await cell.listEgressTokens();
    for (const token of tokens) await cell.revokeEgressToken(token.token);
    await cell.destroy();
  }

  /** Aster conversation cells with their lifecycle status and last API activity. */
  async listConversationCells(): Promise<Array<{ id: string; conversationId: string; status: string; lastActivityAt: string }>> {
    return (await this.client.list())
      .filter((item) => item.labels?.[HOTCELL_CONVERSATION_LABEL])
      .map((item) => ({
        id: item.id,
        conversationId: item.labels[HOTCELL_CONVERSATION_LABEL]!,
        status: item.status,
        lastActivityAt: item.lastActivityAt,
      }));
  }

  /** True suspend: on microVM drivers the daemon snapshots memory, so the Autopilot session resumes alive. */
  async pauseConversationCell(cellId: string): Promise<void> {
    if (!cellId.trim()) throw new HotcellProviderError("Missing Hotcell id", "hotcell_id_missing");
    await (await this.client.getSandbox(cellId)).pause();
  }

  async resumeConversationCell(cellId: string): Promise<void> {
    if (!cellId.trim()) throw new HotcellProviderError("Missing Hotcell id", "hotcell_id_missing");
    await (await this.client.getSandbox(cellId)).start();
  }
}

function validateConfig(config: HotcellProviderConfig): void {
  const endpoint = new URL(config.endpoint);
  const localHttp = endpoint.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]", "::1"].includes(endpoint.hostname);
  if (endpoint.protocol !== "https:" && !localHttp) {
    throw new HotcellProviderError("Hotcell must use HTTPS unless the control endpoint is loopback", "insecure_hotcell_endpoint");
  }
  if (!config.apiKey.trim()) throw new HotcellProviderError("Hotcell API key is required", "hotcell_auth_required");
  if (!HOTCELL_DRIVERS.includes(config.driver)) {
    throw new HotcellProviderError("Aster requires an explicit Hotcell driver", "unsafe_hotcell_driver");
  }
  if (!Number.isInteger(config.memoryMb) || config.memoryMb < 512 || !Number.isFinite(config.cpus) || config.cpus < 0.5 || !Number.isInteger(config.pidsLimit) || config.pidsLimit < 32) {
    throw new HotcellProviderError("Hotcell resource limits are invalid", "invalid_hotcell_limits");
  }
  if (!Number.isFinite(config.spendCapUsd) || config.spendCapUsd <= 0 || !Number.isInteger(config.tokenTtlMs) || config.tokenTtlMs <= 0) {
    throw new HotcellProviderError("Hotcell scoped egress limits are invalid", "invalid_hotcell_egress_limits");
  }
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function integerEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new HotcellProviderError("Invalid Hotcell resource configuration", "invalid_hotcell_config");
  return parsed;
}

function numberEnv(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) throw new HotcellProviderError("Invalid Hotcell resource configuration", "invalid_hotcell_config");
  return parsed;
}
