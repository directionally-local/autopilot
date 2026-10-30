#!/usr/bin/env tsx
/**
 * Audit and clean up leftover multi-agent Cloudflare primitives.
 * Reads credentials from ~/.config/autopilot/config.json
 */
import { readFile } from "node:fs/promises";
import { configPath } from "../src/util/app-dirs.js";

const CF_API = "https://api.cloudflare.com/client/v4";

interface Config {
  accountId?: string;
  apiToken?: string;
}

async function loadConfig(): Promise<Config | null> {
  const path = configPath("config.json");
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Config;
  } catch {
    return null;
  }
}

async function cfFetch<T>(accountId: string, token: string, path: string, init?: RequestInit): Promise<{ success: boolean; result?: T; errors?: Array<{ message?: string }> }> {
  const url = `${CF_API}/accounts/${encodeURIComponent(accountId)}${path}`;
  const res = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...init?.headers,
    },
  });
  return (await res.json()) as { success: boolean; result?: T; errors?: Array<{ message?: string }> };
}

async function listWorkers(accountId: string, token: string): Promise<Array<{ id: string; tag: string }>> {
  const json = await cfFetch<Array<{ id: string; tag: string }>>(accountId, token, "/workers/scripts");
  return json.result ?? [];
}

async function deleteWorker(accountId: string, token: string, name: string): Promise<void> {
  const json = await cfFetch<unknown>(accountId, token, `/workers/scripts/${encodeURIComponent(name)}`, { method: "DELETE" });
  if (!json.success) throw new Error(json.errors?.map((e) => e.message).join(", ") ?? "delete failed");
}

async function listDoNamespaces(accountId: string, token: string): Promise<Array<{ id: string; name: string; script: string; class: string }>> {
  const json = await cfFetch<Array<{ id: string; name: string; script: string; class: string }>>(accountId, token, "/workers/durable_objects/namespaces");
  return json.result ?? [];
}

async function deleteDoNamespace(accountId: string, token: string, id: string): Promise<void> {
  const json = await cfFetch<unknown>(accountId, token, `/workers/durable_objects/namespaces/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!json.success) throw new Error(json.errors?.map((e) => e.message).join(", ") ?? "delete failed");
}

async function listKvNamespaces(accountId: string, token: string): Promise<Array<{ id: string; title: string }>> {
  const json = await cfFetch<Array<{ id: string; title: string }>>(accountId, token, "/storage/kv/namespaces");
  return json.result ?? [];
}

async function deleteKvNamespace(accountId: string, token: string, id: string): Promise<void> {
  const json = await cfFetch<unknown>(accountId, token, `/storage/kv/namespaces/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!json.success) throw new Error(json.errors?.map((e) => e.message).join(", ") ?? "delete failed");
}

async function listContainerApps(accountId: string, token: string): Promise<Array<{ id: string; name: string }>> {
  const json = await cfFetch<Array<{ id: string; name: string }>>(accountId, token, "/containers/applications");
  return json.result ?? [];
}

async function deleteContainerApp(accountId: string, token: string, id: string): Promise<void> {
  const json = await cfFetch<unknown>(accountId, token, `/containers/applications/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!json.success) throw new Error(json.errors?.map((e) => e.message).join(", ") ?? "delete failed");
}

function isMultiAgent(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes("kimiflare-multi-agent") || lower.includes("kimiflare-commute");
}

async function main() {
  const cfg = await loadConfig();
  if (!cfg?.accountId || !cfg?.apiToken) {
    console.error("Cloudflare credentials not found in ~/.config/kimiflare/config.json");
    console.error("Run /init in kimiflare first.");
    process.exit(1);
  }

  const { accountId, apiToken } = cfg;

  console.log("🔍 Scanning your Cloudflare account for multi-agent leftovers…\n");

  const workers = (await listWorkers(accountId, apiToken)).filter((w) => isMultiAgent(w.id));
  const doNs = (await listDoNamespaces(accountId, apiToken)).filter((ns) => isMultiAgent(ns.name) || isMultiAgent(ns.script));
  const kvNs = (await listKvNamespaces(accountId, apiToken)).filter((kv) => isMultiAgent(kv.title));
  const containers = (await listContainerApps(accountId, apiToken)).filter((app) => isMultiAgent(app.name));

  console.log(`Workers:              ${workers.length}`);
  for (const w of workers) console.log(`  • ${w.id}`);

  console.log(`\nDurable Object NS:    ${doNs.length}`);
  for (const ns of doNs) console.log(`  • ${ns.name} (script: ${ns.script}, class: ${ns.class})`);

  console.log(`\nKV namespaces:        ${kvNs.length}`);
  for (const kv of kvNs) console.log(`  • ${kv.title} (${kv.id})`);

  console.log(`\nContainer apps:       ${containers.length}`);
  for (const c of containers) console.log(`  • ${c.name} (${c.id})`);

  const total = workers.length + doNs.length + kvNs.length + containers.length;
  if (total === 0) {
    console.log("\n✅ Nothing found — your account is clean.");
    return;
  }

  console.log(`\n⚠️  Found ${total} leftover primitive(s).`);

  // Auto-delete without prompting since user explicitly asked
  console.log("\n🗑️  Deleting everything…\n");

  for (const w of workers) {
    try {
      await deleteWorker(accountId, apiToken, w.id);
      console.log(`  ✓ Worker deleted: ${w.id}`);
    } catch (err) {
      console.log(`  ✗ Worker delete failed: ${w.id} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const c of containers) {
    try {
      await deleteContainerApp(accountId, apiToken, c.id);
      console.log(`  ✓ Container app deleted: ${c.name}`);
    } catch (err) {
      console.log(`  ✗ Container app delete failed: ${c.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const ns of doNs) {
    try {
      await deleteDoNamespace(accountId, apiToken, ns.id);
      console.log(`  ✓ DO namespace deleted: ${ns.name}`);
    } catch (err) {
      console.log(`  ✗ DO namespace delete failed: ${ns.name} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const kv of kvNs) {
    try {
      await deleteKvNamespace(accountId, apiToken, kv.id);
      console.log(`  ✓ KV namespace deleted: ${kv.title}`);
    } catch (err) {
      console.log(`  ✗ KV namespace delete failed: ${kv.title} — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  console.log("\n✅ Cleanup complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
