import { SqliteDatabase } from "../util/sqlite.js";
import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { connect, type ClientHttp2Session } from "node:http2";
import { defaultAsterDbPath } from "./aster-store.js";

/**
 * Apple Push notifications for Aster: "your task finished" when a turn completes or fails,
 * so a chat can be started and the app closed.
 *
 * Configured with an APNs auth key (not the App Store Connect API key):
 *   AUTOPILOT_ASTER_APNS_KEY_PATH  path to AuthKey_<KEYID>.p8
 *   AUTOPILOT_ASTER_APNS_KEY_ID    the key's ID
 *   AUTOPILOT_ASTER_APNS_TEAM_ID   Apple developer team ID
 *   AUTOPILOT_ASTER_APNS_TOPIC     the app's bundle ID
 * Devices register with their environment: TestFlight and App Store builds use production
 * APNs, Xcode debug builds use the sandbox.
 */

export interface AsterPushMessage {
  title: string;
  body: string;
  conversationId: string;
  category?: string;
  approvalId?: string;
}

interface DeviceRow {
  token: string;
  environment: string;
}

export interface AsterPushOptions {
  keyPath?: string;
  keyId?: string;
  teamId?: string;
  topic?: string;
  /** Injected for tests: deliver one notification; returns the APNs HTTP status. */
  deliver?: (input: { host: string; token: string; headers: Record<string, string>; payload: string }) => Promise<number>;
}

const DEVICE_TOKEN_RE = /^[0-9a-f]{64,200}$/i;

export class AsterPush {
  private readonly db: SqliteDatabase;
  private readonly options: Required<Pick<AsterPushOptions, "keyId" | "teamId" | "topic">> & AsterPushOptions;
  private privateKey: string | undefined;
  private jwt: { value: string; issuedAt: number } | undefined;
  private readonly sessions = new Map<string, ClientHttp2Session>();

  constructor(dbPath = defaultAsterDbPath(), options: AsterPushOptions = {}, env: NodeJS.ProcessEnv = process.env) {
    this.options = {
      ...options,
      keyPath: options.keyPath ?? env.AUTOPILOT_ASTER_APNS_KEY_PATH,
      keyId: options.keyId ?? env.AUTOPILOT_ASTER_APNS_KEY_ID ?? "",
      teamId: options.teamId ?? env.AUTOPILOT_ASTER_APNS_TEAM_ID ?? "",
      topic: options.topic ?? env.AUTOPILOT_ASTER_APNS_TOPIC ?? "com.aster.ai",
    };
    this.db = new SqliteDatabase(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS aster_devices (
        token TEXT PRIMARY KEY,
        environment TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /** Whether an APNs key is configured; devices are still recorded without one. */
  get configured(): boolean {
    return Boolean((this.options.keyPath || this.options.deliver) && this.options.keyId && this.options.teamId);
  }

  register(token: string, environment: "production" | "development"): boolean {
    if (!DEVICE_TOKEN_RE.test(token)) return false;
    const now = Date.now();
    this.db.prepare(`INSERT INTO aster_devices (token, environment, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(token) DO UPDATE SET environment = excluded.environment, updated_at = excluded.updated_at`)
      .run(token.toLowerCase(), environment, now, now);
    return true;
  }

  unregister(token: string): void {
    this.db.prepare("DELETE FROM aster_devices WHERE token = ?").run(token.toLowerCase());
  }

  deviceCount(): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM aster_devices").get() as { n: number }).n;
  }

  /** Sends to every registered device; tokens Apple reports as gone are removed. Never throws. */
  async notify(message: AsterPushMessage): Promise<void> {
    if (!this.configured) return;
    const devices = this.db.prepare("SELECT token, environment FROM aster_devices").all() as DeviceRow[];
    if (devices.length === 0) return;
    const payload = JSON.stringify({
      aps: {
        alert: { title: truncate(message.title, 80), body: truncate(message.body, 180) },
        sound: "default",
        "thread-id": message.conversationId,
        ...(message.category ? { category: message.category } : {}),
      },
      conversationId: message.conversationId,
      ...(message.approvalId ? { approvalId: message.approvalId } : {}),
    });
    await Promise.all(devices.map(async (device) => {
      const host = device.environment === "development" ? "api.sandbox.push.apple.com" : "api.push.apple.com";
      try {
        const status = await this.send(host, device.token, payload);
        if (status === 410 || status === 400) this.unregister(device.token); // Unregistered or BadDeviceToken
      } catch { /* delivery is best-effort */ }
    }));
  }

  close(): void {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
    this.db.close();
  }

  private async send(host: string, token: string, payload: string): Promise<number> {
    const headers = {
      authorization: `bearer ${this.token()}`,
      "apns-topic": this.options.topic,
      "apns-push-type": "alert",
      "apns-priority": "10",
    };
    if (this.options.deliver) return this.options.deliver({ host, token, headers, payload });
    const session = this.session(host);
    return await new Promise<number>((resolve, reject) => {
      const stream = session.request({ ":method": "POST", ":path": `/3/device/${token}`, ...headers, "content-type": "application/json" });
      let status = 0;
      stream.setTimeout(15_000, () => stream.close());
      stream.on("response", (responseHeaders) => { status = Number(responseHeaders[":status"]) || 0; });
      stream.on("error", reject);
      stream.on("close", () => resolve(status));
      stream.resume();
      stream.end(payload);
    });
  }

  private session(host: string): ClientHttp2Session {
    const existing = this.sessions.get(host);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = connect(`https://${host}`);
    session.on("error", () => this.sessions.delete(host));
    session.on("close", () => this.sessions.delete(host));
    session.unref();
    this.sessions.set(host, session);
    return session;
  }

  /** Provider token (ES256 JWT); Apple accepts one for up to an hour, so it is reused for 50 minutes. */
  private token(): string {
    const now = Math.floor(Date.now() / 1000);
    if (this.jwt && now - this.jwt.issuedAt < 50 * 60) return this.jwt.value;
    this.privateKey ??= readFileSync(this.options.keyPath!, "utf8");
    const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const unsigned = `${encode({ alg: "ES256", kid: this.options.keyId })}.${encode({ iss: this.options.teamId, iat: now })}`;
    const signature = createSign("SHA256").update(unsigned).sign({ key: this.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    this.jwt = { value: `${unsigned}.${signature}`, issuedAt: now };
    return this.jwt.value;
  }
}

function truncate(value: string, limit: number): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > limit ? clean.slice(0, limit - 1) + "…" : clean;
}
