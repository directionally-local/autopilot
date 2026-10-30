import assert from "node:assert/strict";
import { test } from "node:test";
import type { CreateOptions, Sandbox } from "@hotcell/sdk";
import {
  HOTCELL_CONVERSATION_LABEL,
  HotcellProvider,
  HotcellProviderError,
  type HotcellClientPort,
  type HotcellProviderConfig,
} from "./hotcell-provider.js";

const CONVERSATION_ID = "99f01cad-4f61-4b56-8c06-c31486e6fadc";
const config: HotcellProviderConfig = {
  endpoint: "http://127.0.0.1:4750",
  apiKey: "control-plane-test-key",
  driver: "applevz",
  memoryMb: 4096,
  cpus: 2,
  pidsLimit: 256,
  spendCapUsd: 10,
  tokenTtlMs: 86_400_000,
};

test("provisions a bounded private microVM with per-model gateway egress", async () => {
  const fake = new FakeHotcellClient();
  const provider = new HotcellProvider(config, () => fake);
  const cell = await provider.createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "openai/gpt-4.1" });

  assert.equal(cell.id, "cell-1");
  assert.equal(fake.creates, 1);
  assert.equal(fake.options?.driver, "applevz");
  assert.equal(fake.options?.networked, false);
  assert.equal(fake.options?.persist, true);
  assert.equal(fake.options?.sleepAfter, 0);
  assert.equal(fake.options?.memoryMb, 4096);
  assert.equal(fake.options?.cpus, 2);
  assert.equal(fake.options?.pidsLimit, 256);
  assert.deepEqual(fake.options?.egress, {
    providers: ["openrouter"],
    models: ["openai/gpt-4.1"],
    spendCapUsd: 10,
    ttlMs: 86_400_000,
  });
  assert.equal(fake.options?.labels?.[HOTCELL_CONVERSATION_LABEL], CONVERSATION_ID);
  assert.equal("mounts" in (fake.options ?? {}), false);
  assert.equal("ports" in (fake.options ?? {}), false);
});

test("the egress route follows the configured provider, and a route the daemon lacks fails closed", async () => {
  const fake = new FakeHotcellClient();
  fake.egressProviders = ["openrouter", "deepseek", "ollama", "github", "github-git"];
  const provider = new HotcellProvider(config, () => fake);
  await provider.createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "deepseek-v4-pro", provider: "deepseek", kind: "code" });
  assert.deepEqual(fake.options?.egress, { providers: ["deepseek", "github", "github-git"], models: ["deepseek-v4-pro"], spendCapUsd: 10, ttlMs: 86_400_000 });

  const keyless = new FakeHotcellClient();
  keyless.egressProviders = ["ollama"];
  await new HotcellProvider(config, () => keyless).createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "qwen3:32b", provider: "ollama", kind: "chat" });
  assert.deepEqual(keyless.options?.egress, { providers: ["ollama"], models: ["qwen3:32b"], spendCapUsd: 10, ttlMs: 86_400_000 });

  const missing = new FakeHotcellClient();
  await assert.rejects(
    () => new HotcellProvider(config, () => missing).createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "deepseek-v4-pro", provider: "deepseek" }),
    (error: unknown) => error instanceof HotcellProviderError && error.code === "hotcell_egress_unavailable" && /"deepseek"/.test(error.message),
  );
  assert.equal(missing.creates, 0);
  await assert.rejects(
    () => new HotcellProvider(config, () => missing).createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "m", provider: "Deep Seek" }),
    (error: unknown) => error instanceof HotcellProviderError && error.code === "invalid_provisioning_input",
  );
});

test("retry adopts the existing labeled cell instead of creating a second one", async () => {
  const fake = new FakeHotcellClient();
  const provider = new HotcellProvider(config, () => fake);
  const first = await provider.createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "openai/gpt-4.1" });
  const second = await provider.createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "openai/gpt-4.1" });

  assert.equal(first.id, second.id);
  assert.equal(fake.creates, 1);
  assert.equal(fake.attachments, 1);
});

test("fails closed when Hotcell API auth or the microVM driver is unavailable", async () => {
  const unauthenticated = new FakeHotcellClient();
  unauthenticated.auth = false;
  await assert.rejects(
    () => new HotcellProvider(config, () => unauthenticated).createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "openai/gpt-4.1" }),
    (error: unknown) => error instanceof HotcellProviderError && error.code === "hotcell_auth_required",
  );
  assert.equal(unauthenticated.creates, 0);

  const noDriver = new FakeHotcellClient();
  noDriver.drivers = ["container"];
  await assert.rejects(
    () => new HotcellProvider(config, () => noDriver).createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "openai/gpt-4.1" }),
    (error: unknown) => error instanceof HotcellProviderError && error.code === "hotcell_driver_unavailable",
  );
  assert.equal(noDriver.creates, 0);
});

test("refuses public plain-HTTP controls and unknown drivers", () => {
  assert.throws(
    () => new HotcellProvider({ ...config, endpoint: "http://hotcell.example:4750" }, () => new FakeHotcellClient()),
    (error: unknown) => error instanceof HotcellProviderError && error.code === "insecure_hotcell_endpoint",
  );
  assert.throws(
    () => new HotcellProvider({ ...config, driver: "docker" as "applevz" }, () => new FakeHotcellClient()),
    (error: unknown) => error instanceof HotcellProviderError && error.code === "unsafe_hotcell_driver",
  );
});

test("container cells can opt into networking, any-model egress, and idle sleep", async () => {
  const fake = new FakeHotcellClient();
  fake.drivers = ["container"];
  const provider = new HotcellProvider(
    { ...config, driver: "container", networked: true, anyModel: true, sleepAfterMs: 900_000 },
    () => fake,
  );
  await provider.createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "openai/gpt-4.1" });

  assert.equal(fake.options?.driver, "container");
  assert.equal(fake.options?.networked, true);
  assert.equal(fake.options?.sleepAfter, 900_000);
  assert.deepEqual(fake.options?.egress, { providers: ["openrouter"], spendCapUsd: 10, ttlMs: 86_400_000 });
});

test("fromEnvironment reads the container, networking, model, and sleep settings", () => {
  const provider = HotcellProvider.fromEnvironment({
    AUTOPILOT_HOTCELL_ENDPOINT: "http://127.0.0.1:4750",
    AUTOPILOT_HOTCELL_API_KEY: "k",
    AUTOPILOT_HOTCELL_DRIVER: "container",
    AUTOPILOT_HOTCELL_NETWORKED: "true",
    AUTOPILOT_HOTCELL_ANY_MODEL: "true",
    AUTOPILOT_HOTCELL_SLEEP_AFTER_MS: "900000",
  });
  const resolved = (provider as unknown as { config: HotcellProviderConfig }).config;
  assert.equal(resolved.driver, "container");
  assert.equal(resolved.networked, true);
  assert.equal(resolved.anyModel, true);
  assert.equal(resolved.sleepAfterMs, 900_000);
});

test("destroy revokes every scoped token before deleting the volume and is idempotent", async () => {
  const fake = new FakeHotcellClient();
  const provider = new HotcellProvider(config, () => fake);
  await provider.createConversationCell({ conversationId: CONVERSATION_ID, workspaceId: "work", model: "openai/gpt-4.1" });
  await provider.destroyConversationCell("cell-1");
  await provider.destroyConversationCell("cell-1");

  assert.deepEqual(fake.revoked, ["token-one", "token-two"]);
  assert.equal(fake.destroyed, 1);
  assert.equal(fake.cells.size, 0);
});

class FakeHotcellClient implements HotcellClientPort {
  auth = true;
  drivers = ["applevz", "firecracker"];
  egressProviders = ["openrouter"];
  creates = 0;
  attachments = 0;
  destroyed = 0;
  options: CreateOptions | undefined;
  revoked: string[] = [];
  readonly cells = new Map<string, FakeSandbox>();

  async getSandbox(id?: string, options?: CreateOptions): Promise<Sandbox> {
    if (id) {
      const cell = this.cells.get(id);
      if (!cell) throw new Error("not found");
      this.attachments++;
      return cell as unknown as Sandbox;
    }
    this.creates++;
    this.options = options;
    const cell = new FakeSandbox("cell-1", options?.labels ?? {}, this);
    this.cells.set(cell.id, cell);
    return cell as unknown as Sandbox;
  }

  async list(): Promise<Awaited<ReturnType<HotcellClientPort["list"]>>> {
    return [...this.cells.values()].map((cell) => ({ id: cell.id, labels: cell.labels }) as Awaited<ReturnType<HotcellClientPort["list"]>>[number]);
  }

  async info() {
    return {
      auth: this.auth,
      drivers: this.drivers,
      egressProviders: this.egressProviders,
    } as Awaited<ReturnType<HotcellClientPort["info"]>>;
  }
}

class FakeSandbox {
  readonly labels: Record<string, string>;

  constructor(readonly id: string, labels: Record<string, string>, private readonly client: FakeHotcellClient) {
    this.labels = labels;
  }

  getInfo() {
    return { id: this.id, labels: this.labels };
  }

  async listEgressTokens() {
    return { tokens: [{ token: "token-one" }, { token: "token-two" }], providers: [] };
  }

  async revokeEgressToken(token: string) {
    this.client.revoked.push(token);
  }

  async destroy() {
    this.client.destroyed++;
    this.client.cells.delete(this.id);
  }
}
