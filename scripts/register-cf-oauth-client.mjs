#!/usr/bin/env node
/**
 * One-time maintainer helper: register the `kimiflare` OAuth client with
 * Cloudflare via the API (see docs/login-with-cloudflare.md).
 *
 *   CLOUDFLARE_API_TOKEN=<token with "OAuth Clients Write"> \
 *   CLOUDFLARE_ACCOUNT_ID=<account id> \
 *   node scripts/register-cf-oauth-client.mjs [--name kimiflare] [--port 8978] [--dry-run]
 *
 * Prints the resulting client id. Then set CF_OAUTH_CLIENT_ID in
 * src/cloud/cloudflare-oauth.ts (or export KIMIFLARE_CF_OAUTH_CLIENT_ID).
 */
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    name: { type: "string", default: "kimiflare" },
    port: { type: "string", default: "8978" },
    "client-url": { type: "string", default: "https://kimiflare.com" },
    "logo-url": { type: "string", default: "https://kimiflare.com/logo.png" },
    "dry-run": { type: "boolean", default: false },
  },
});

const token = process.env.CLOUDFLARE_API_TOKEN;
const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
if (!token || !accountId) {
  console.error("Set CLOUDFLARE_API_TOKEN (OAuth Clients Write) and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(2);
}

// Keep in sync with CF_OAUTH_SCOPES / CF_OAUTH_REDIRECT_URI in src/cloud/cloudflare-oauth.ts.
const scopes = [
  "user-details.read",
  "account-settings.read",
  "ai.read",
  "ai.write",
  "aig.read",
  "aig.write",
  "aig.run",
  "secrets-store.read",
  "secrets-store.write",
];

const body = {
  client_name: values.name,
  client_uri: values["client-url"],
  logo_uri: values["logo-url"],
  policy_uri: "https://github.com/directionally-local/autopilot#readme",
  tos_uri: "https://github.com/directionally-local/autopilot/blob/main/LICENSE",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  redirect_uris: [`http://localhost:${values.port}/oauth/callback`],
  scopes,
};

console.log("Registering OAuth client with:\n" + JSON.stringify(body, null, 2));
if (values["dry-run"]) process.exit(0);

const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${accountId}/oauth_clients`, {
  method: "POST",
  headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const json = await res.json().catch(() => ({}));
if (!res.ok || !json.success) {
  console.error(`Failed (HTTP ${res.status}):`, JSON.stringify(json.errors ?? json, null, 2));
  process.exit(1);
}
console.log("\n✓ Created. Client ID:", json.result?.client_id ?? json.result?.id);
console.log("Visibility:", json.result?.visibility ?? "private");
if (json.result?.client_uri_verification) {
  console.log("Domain verification:", JSON.stringify(json.result.client_uri_verification));
  console.log("→ add that TXT record on the client URL's domain, then promote the client to public in the dashboard.");
}
console.log("Next: set CF_OAUTH_CLIENT_ID in src/cloud/cloudflare-oauth.ts (or export KIMIFLARE_CF_OAUTH_CLIENT_ID).");
