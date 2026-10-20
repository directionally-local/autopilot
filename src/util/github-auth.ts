import { loadConfig, saveConfig, DEFAULT_MODEL } from "../config.js";

const GITHUB_DEVICE_AUTH_URL = "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";
const CLIENT_ID = process.env.KIMIFLARE_GITHUB_CLIENT_ID ?? "Ov23liM7lJX1xE2V1sVK";

export interface AuthStep {
  message: string;
  url?: string;
  code?: string;
  done?: boolean;
  error?: boolean;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function* authGitHubForTui(): AsyncGenerator<AuthStep, void, void> {
  yield { message: "Starting GitHub OAuth device flow..." };

  const deviceRes = await fetch(GITHUB_DEVICE_AUTH_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ client_id: CLIENT_ID, scope: "repo" }),
  });

  if (!deviceRes.ok) {
    yield { message: `Failed to request device code: ${deviceRes.status}`, error: true };
    throw new Error("Device code request failed");
  }

  const deviceData = await deviceRes.json() as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    expires_in: number;
    interval: number;
  };

  yield {
    message: `Open ${deviceData.verification_uri} and enter code: ${deviceData.user_code}`,
    url: deviceData.verification_uri,
    code: deviceData.user_code,
  };

  const startTime = Date.now();
  const expiresIn = deviceData.expires_in * 1000;
  const interval = deviceData.interval * 1000;

  while (Date.now() - startTime < expiresIn) {
    await sleep(interval);

    const tokenRes = await fetch(GITHUB_ACCESS_TOKEN_URL, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        device_code: deviceData.device_code,
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
      }),
    });

    if (!tokenRes.ok) continue;

    const tokenData = await tokenRes.json() as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
    };

    if (tokenData.error === "authorization_pending") {
      continue;
    }
    if (tokenData.error === "slow_down") {
      await sleep(interval * 2);
      continue;
    }
    if (tokenData.error) {
      yield { message: `OAuth error: ${tokenData.error}`, error: true };
      throw new Error(tokenData.error);
    }

    if (tokenData.access_token) {
      const cfg = (await loadConfig()) ?? {
        accountId: "",
        apiToken: "",
        model: DEFAULT_MODEL,
      };

      await saveConfig({
        ...cfg,
        githubOAuthToken: tokenData.access_token,
        githubRefreshToken: tokenData.refresh_token,
        githubTokenExpiry: tokenData.expires_in ? Date.now() + tokenData.expires_in * 1000 : undefined,
      });

      yield { message: "GitHub authentication successful!", done: true };
      return;
    }
  }

  yield { message: "Device flow expired. Please try again.", error: true };
  throw new Error("Device flow expired");
}
