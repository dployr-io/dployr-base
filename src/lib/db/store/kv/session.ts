import { UAParser } from "ua-parser-js";
import { Session, SessionDevice, User } from "@/types/index.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { OTP_TTL, SESSION_TTL, STATE_TTL } from "@/lib/constants/index.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("OAuth");

function parseDevice(userAgent?: string): SessionDevice | undefined {
  if (!userAgent) return undefined;
  const parser = new UAParser(userAgent);
  const browser = parser.getBrowser();
  const os = parser.getOS();
  const device = parser.getDevice();

  const type = device.type === "mobile"
    ? "mobile"
    : device.type === "tablet"
      ? "tablet"
      : (device.type === undefined)
        ? "desktop"
        : "unknown";

  return {
    browser: browser.name ?? "Unknown",
    browserVersion: browser.major ?? "",
    os: os.name ?? "Unknown",
    osVersion: os.version ?? "",
    type,
  };
}

export class SessionStore {
  constructor(private kv: IKVAdapter) {}

  async createSession(
    sessionId: string,
    user: Omit<User, "createdAt" | "updatedAt">,
    clusters: { id: string; name: string; owner: string; role: string }[],
    ttlOverride?: number,
    meta?: { ip?: string; userAgent?: string; country?: string },
  ): Promise<Session> {
    const ttl = ttlOverride ?? SESSION_TTL;
    const session: Session = {
      id: sessionId,
      userId: user.id,
      email: user.email,
      provider: user.provider,
      clusters,
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl * 1000,
      ip: meta?.ip,
      country: meta?.country,
      device: parseDevice(meta?.userAgent),
    };

    await Promise.all([
      this.kv.put(KV_KEYS.SESSION.BY_ID(sessionId), JSON.stringify(session), { ttl }),
      this.kv.put(KV_KEYS.SESSION.BY_USER(user.id), sessionId, { ttl }),
      this.kv.put(KV_KEYS.SESSION.LIST_ENTRY(user.id, sessionId), "1", { ttl }),
    ]);

    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.kv.get(KV_KEYS.SESSION.BY_ID(sessionId));
    if (!data) return null;

    const session = JSON.parse(data) as Session;

    if (session.expiresAt < Date.now()) {
      await this.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  async getSessionIdByUserId(userId: string): Promise<string | null> {
    return await this.kv.get(KV_KEYS.SESSION.BY_USER(userId));
  }

  async listUserSessions(userId: string): Promise<Session[]> {
    const entries = await this.kv.list({ prefix: KV_KEYS.SESSION.LIST_PREFIX(userId) });
    const sessionIds = entries.map(e => e.name.split(":").pop()!);

    const sessions = await Promise.all(sessionIds.map(id => this.getSession(id)));
    return sessions.filter((s): s is Session => s !== null);
  }

  async refreshSession({ sessionId, updates }: { sessionId: string; updates: Partial<Pick<Session, "email" | "provider" | "clusters">> }): Promise<void> {
    const existing = await this.getSession(sessionId);
    if (!existing) return;

    const refreshed: Session = { ...existing, ...updates };
    const remainingMs = existing.expiresAt - Date.now();
    const ttl = Math.ceil(remainingMs / 1000);

    await Promise.all([
      this.kv.put(KV_KEYS.SESSION.BY_ID(sessionId), JSON.stringify(refreshed), { ttl }),
      this.kv.put(KV_KEYS.SESSION.BY_USER(existing.userId), sessionId, { ttl }),
    ]);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.kv.get(KV_KEYS.SESSION.BY_ID(sessionId));
    if (session) {
      const parsed = JSON.parse(session) as Session;
      await Promise.all([
        this.kv.delete(KV_KEYS.SESSION.BY_ID(sessionId)),
        this.kv.delete(KV_KEYS.SESSION.BY_USER(parsed.userId)),
        this.kv.delete(KV_KEYS.SESSION.LIST_ENTRY(parsed.userId, sessionId)),
      ]);
    } else {
      await this.kv.delete(KV_KEYS.SESSION.BY_ID(sessionId));
    }
  }

  async deleteAllUserSessions(userId: string): Promise<void> {
    const sessions = await this.listUserSessions(userId);
    await Promise.all(sessions.map(s => this.deleteSession(s.id)));
  }

  async createState({ state, redirectUrl }: { state: string; redirectUrl: string }): Promise<void> {
    await this.kv.put(
      KV_KEYS.WORKFLOW.STATE(state),
      JSON.stringify({ state, redirectUrl, createdAt: Date.now() }),
      { ttl: STATE_TTL },
    );
  }

  async validateState(state: string): Promise<string | null> {
    try {
      const data = await this.kv.get(KV_KEYS.WORKFLOW.STATE(state));
      if (!data) {
        log.error(`State validation failed: state not found in KV store (state: ${state})`);
        return null;
      }
      const stateData = JSON.parse(data) as { state: string; redirectUrl: string; createdAt: number };
      log.info(`State validated successfully (redirectUrl: ${stateData.redirectUrl})`);
      await this.kv.delete(KV_KEYS.WORKFLOW.STATE(state));
      return stateData.redirectUrl;
    } catch (error) {
      log.error(`State validation error:`, error);
      return null;
    }
  }

  async createOTP(email: string): Promise<string> {
    const code = this.generateOTP();
    await this.kv.put(
      KV_KEYS.OTP.BY_EMAIL(email),
      JSON.stringify({ code, email, createdAt: Date.now(), attempts: 0 }),
      { ttl: OTP_TTL },
    );
    return code;
  }

  async validateOTP({ email, code }: { email: string; code: string }): Promise<boolean> {
    const data = await this.kv.get(KV_KEYS.OTP.BY_EMAIL(email));
    if (!data) return false;

    const otpData = JSON.parse(data) as { code: string; email: string; createdAt: number; attempts: number };

    if (otpData.attempts >= 3) {
      await this.kv.delete(KV_KEYS.OTP.BY_EMAIL(email));
      return false;
    }

    otpData.attempts++;
    await this.kv.put(KV_KEYS.OTP.BY_EMAIL(email), JSON.stringify(otpData), { ttl: OTP_TTL });

    if (otpData.code === code) {
      await this.kv.delete(KV_KEYS.OTP.BY_EMAIL(email));
      return true;
    }

    return false;
  }

  private generateOTP(): string {
    const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
    let result = "";
    for (let i = 0; i < 6; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  }
}
