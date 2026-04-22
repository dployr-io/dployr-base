// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ActorType, Session, User } from "@/types/index.js";
import { ulid } from "ulid";
import { CryptoKey, importPKCS8, SignJWT } from "jose";
import { ADMIN_JWT_TTL, ADMIN_JWT_REFRESH_THRESHOLD, BILLING_NOTIFICATION_TTL } from "@/lib/constants/index.js";
import { generateKeyPair } from "@/lib/crypto/keystore.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv-keys.js";
import {
  FAILED_WORKFLOW_EVENT_TTL,
  OTP_TTL,
  SESSION_TTL,
  STATE_TTL,
  EVENT_TTL,
  NODE_UPDATE_TTL,
  RELEASE_CACHE_TTL,
  DEDUP_TTL,
  PENDING_GITHUB_INSTALL_TTL,
  INSTANCE_STATUS_TTL,
} from "@/lib/constants/index.js";
import { JsonWebKey } from "crypto";

export class KVStore {
  constructor(
    public kv: IKVAdapter,
    private githubToken?: string,
  ) {}

  // Session management
  async createSession(sessionId: string, user: Omit<User, "createdAt" | "updatedAt">, clusters: { id: string; name: string; owner: string; role: string }[]): Promise<Session> {
    const session: Session = {
      userId: user.id,
      email: user.email,
      provider: user.provider,
      clusters,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL * 1000,
    };

    const ttl = SESSION_TTL;

    await Promise.all([
      this.kv.put(KV_KEYS.SESSION(sessionId), JSON.stringify(session), { ttl }),
      this.kv.put(KV_KEYS.SESSION_BY_USER(user.id), sessionId, { ttl }),
    ]);

    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.kv.get(KV_KEYS.SESSION(sessionId));
    if (!data) return null;

    const session = JSON.parse(data) as Session;

    if (session.expiresAt < Date.now()) {
      await this.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  async getSessionIdByUserId(userId: string): Promise<string | null> {
    return await this.kv.get(KV_KEYS.SESSION_BY_USER(userId));
  }

  async refreshSession({ sessionId, updates }: { sessionId: string; updates: { clusters: Session["clusters"] } }): Promise<void> {
    const existing = await this.getSession(sessionId);
    if (!existing) return;

    const refreshed: Session = {
      ...existing,
      clusters: updates.clusters,
    };

    const remainingMs = existing.expiresAt - Date.now();
    const ttl = Math.ceil(remainingMs / 1000);

    await Promise.all([
      this.kv.put(KV_KEYS.SESSION(sessionId), JSON.stringify(refreshed), { ttl }),
      this.kv.put(KV_KEYS.SESSION_BY_USER(existing.userId), sessionId, { ttl }),
    ]);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.getSession(sessionId);
    if (session) {
      await Promise.all([
        this.kv.delete(KV_KEYS.SESSION(sessionId)),
        this.kv.delete(KV_KEYS.SESSION_BY_USER(session.userId)),
      ]);
    } else {
      await this.kv.delete(KV_KEYS.SESSION(sessionId));
    }
  }

  // Retrieves or creates the key pair.
  async getOrCreateKeys(): Promise<{
    publicKeyJwk: JsonWebKey;
    privateKey: string;
  }> {
    const data = await this.kv.get(KV_KEYS.JWT_KEYS);
    let existing: { publicKeyJwk: JsonWebKey; privateKey: string } | null = null;
    if (data) {
      existing = JSON.parse(data);
    }

    if (!existing) {
      const generated = await generateKeyPair();
      existing = generated;
      await this.kv.put(KV_KEYS.JWT_KEYS, JSON.stringify(generated));
    }

    return existing;
  }

  // Retrieves the public key.
  async getPublicKey(): Promise<JsonWebKey> {
    const keys = await this.getOrCreateKeys();

    if (!(keys.publicKeyJwk as any).kid) {
      (keys.publicKeyJwk as any).kid = "base-key";
      await this.kv.put(KV_KEYS.JWT_KEYS, JSON.stringify(keys));
    }

    return keys.publicKeyJwk;
  }

  // Retrieves the private key.
  async getPrivateKey(): Promise<CryptoKey> {
    const keys = await this.getOrCreateKeys();
    return importPKCS8(keys.privateKey, "RS256");
  }

  // Event management
  async logEvent({ type, actor, targets, request }: { type: string; actor: { id: string; type: ActorType }; targets?: { id: string }[]; request: Request }): Promise<void> {
    const headers = request.headers;

    const timezone = headers.get("x-timezone") || "UTC";

    const baseEvent = {
      type,
      actor,
      timestamp: Date.now(),
      timezone,
      timezoneOffset: new Date().toLocaleString("en-US", {
        timeZone: timezone,
        timeZoneName: "shortOffset",
      }),
    };

    const ray = headers.get("x-ray-id") || headers.get("x-request-id") || "";
    const targetScope = Array.isArray(targets)
      ? targets
          .map((t) => t.id)
          .sort()
          .join(",")
      : "";
    const idemKey = KV_KEYS.EVENT_IDEM(type, actor.id, ray, targetScope);
    if (ray) {
      const exists = await this.kv.get(idemKey);
      if (exists) {
        return;
      }
      await this.kv.put(idemKey, "1", { ttl: DEDUP_TTL });
    }

    if (targets && targets.length > 0) {
      // Create separate events for each target
      const id = ulid();
      const actorEvent = {
        ...baseEvent,
        id,
        targets,
      };

      const actorKey = KV_KEYS.ACTOR_EVENT(actor.id, id);
      const writes: Promise<any>[] = [this.kv.put(actorKey, JSON.stringify(actorEvent), { ttl: EVENT_TTL })];

      for (const target of targets) {
        const event = {
          ...baseEvent,
          id,
          targets: [target],
        };
        const targetKey = KV_KEYS.TARGET_EVENT(target.id, id);
        writes.push(this.kv.put(targetKey, JSON.stringify(event), { ttl: EVENT_TTL }));
      }

      await Promise.all(writes);
    } else {
      // No targets, create single event
      const event = {
        ...baseEvent,
        id: ulid(),
      };

      const actorKey = KV_KEYS.ACTOR_EVENT(actor.id, event.id);
      await this.kv.put(actorKey, JSON.stringify(event), { ttl: EVENT_TTL });
    }
  }

  async getEvents(userId: string): Promise<any[]> {
    const result = await this.kv.list({ prefix: KV_KEYS.ACTOR_EVENT(userId, "") });
    const events = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        try {
          return JSON.parse(data);
        } catch (err) {
          console.warn("[KV] Skipping invalid event JSON", { key: key.name, err });
          return null;
        }
      }),
    );
    return events.filter((e) => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  async getClusterEvents(clusterId: string): Promise<any[]> {
    const prefix = KV_KEYS.TARGET_EVENT(clusterId, "");
    const result = await this.kv.list({ prefix });
    const events = await Promise.all(
      result.map(async (key) => {
        if (!key.name.startsWith(prefix)) {
          return null;
        }
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const trimmed = data.trimStart();
        if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
          return null;
        }
        try {
          return JSON.parse(data);
        } catch (err) {
          return null;
        }
      }),
    );
    return events.filter((e) => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  async createWorkflowFailedEvent(id: string, data: Record<string, unknown>): Promise<void> {
    await this.kv.put(KV_KEYS.WORKFLOW(id), JSON.stringify(data), {
      ttl: FAILED_WORKFLOW_EVENT_TTL,
    });
  }

  // Billing
  async getbillingNotification({ clusterId }: { clusterId: string }): Promise<String | null> {
    return await this.kv.get(KV_KEYS.BILLING_NOTIFICATION(clusterId));
  }

  async setReminderNotification({ clusterId }: { clusterId: string }): Promise<void> {
    await this.kv.put(KV_KEYS.BILLING_NOTIFICATION(clusterId), "1", {
      ttl: BILLING_NOTIFICATION_TTL,
    });
  }

  // OAuth state management (CSRF protection)
  async createState({ state, redirectUrl }: { state: string; redirectUrl: string }): Promise<void> {
    await this.kv.put(
      KV_KEYS.STATE(state),
      JSON.stringify({
        state,
        redirectUrl,
        createdAt: Date.now(),
      }),
      {
        ttl: STATE_TTL,
      },
    );
  }

  async validateState(state: string): Promise<string | null> {
    try {
      const data = await this.kv.get(KV_KEYS.STATE(state));
      if (!data) {
        console.error(`[OAuth] State validation failed: state not found in KV store (state: ${state})`);
        return null;
      }

      const stateData = JSON.parse(data) as {
        state: string;
        redirectUrl: string;
        createdAt: number;
      };

      console.log(`[OAuth] State validated successfully (redirectUrl: ${stateData.redirectUrl})`);
      await this.kv.delete(KV_KEYS.STATE(state));
      return stateData.redirectUrl;
    } catch (error) {
      console.error(`[OAuth] State validation error:`, error);
      return null;
    }
  }

  async createOTP(email: string): Promise<string> {
    const code = this.generateOTP();

    await this.kv.put(
      KV_KEYS.OTP(email),
      JSON.stringify({
        code,
        email,
        createdAt: Date.now(),
        attempts: 0,
      }),
      { ttl: OTP_TTL },
    );

    return code;
  }

  async validateOTP({ email, code }: { email: string; code: string }): Promise<boolean> {
    const data = await this.kv.get(KV_KEYS.OTP(email));
    if (!data) return false;

    const otpData = JSON.parse(data) as {
      code: string;
      email: string;
      createdAt: number;
      attempts: number;
    };

    if (otpData.attempts >= 3) {
      await this.kv.delete(KV_KEYS.OTP(email));
      return false;
    }

    otpData.attempts++;
    await this.kv.put(KV_KEYS.OTP(email), JSON.stringify(otpData), {
      ttl: OTP_TTL,
    });

    if (otpData.code === code) {
      await this.kv.delete(KV_KEYS.OTP(email));
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

  async saveDomain({ domain, address }: { domain: string; address: string }): Promise<void> {
    await this.kv.put(KV_KEYS.DOMAIN(domain), address);
  }

  async getDomain(domain: string): Promise<string | null> {
    const data = await this.kv.get(KV_KEYS.DOMAIN(domain));
    if (!data) return null;
    return data;
  }

  // Node update management
  async saveNodeUpdate({ instanceId, update }: { instanceId: string; update: Record<string, unknown> }): Promise<void> {
    const now = Date.now();
    const data = {
      ...update,
      lastUpdated: now,
    };

    // Save latest update with TTL
    await this.kv.put(KV_KEYS.NODE_UPDATE(instanceId), JSON.stringify(data), {
      ttl: NODE_UPDATE_TTL,
    });
  }

  async getNodeUpdate(instanceId: string): Promise<Record<string, unknown> | null> {
    const data = await this.kv.get(KV_KEYS.NODE_UPDATE(instanceId));
    if (!data) return null;
    return JSON.parse(data);
  }

  // Version cache for latest GitHub release
  private async getCachedLatestVersion(): Promise<string | null> {
    try {
      const raw = await this.kv.get(KV_KEYS.VERSION_LATEST);
      if (!raw) return null;
      const data = JSON.parse(raw) as { tag?: string } | null;
      if (data && typeof data.tag === "string" && data.tag.length > 0) {
        return data.tag;
      }
    } catch {}
    return null;
  }

  private async fetchAndCacheLatestVersion(): Promise<string | null> {
    try {
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "dployr-base",
      };
      const token = (this.githubToken || "").trim();
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const resp = await fetch("https://api.github.com/repos/dployr-io/dployr/releases/latest", { headers });
      if (!resp.ok) {
        return null;
      }
      const body = await resp.json();
      const tag = (body as any).tag_name as string | undefined;
      if (!tag) return null;

      await this.kv.put(KV_KEYS.VERSION_LATEST, JSON.stringify({ tag }), {
        ttl: RELEASE_CACHE_TTL,
      });

      return tag;
    } catch {
      return null;
    }
  }

  async getLatestVersion(): Promise<string | null> {
    const cached = await this.getCachedLatestVersion();
    if (cached) return cached;
    return this.fetchAndCacheLatestVersion();
  }

  // Pending GitHub installation
  async setPendingGitHubInstall(userId: string, clusterId: string): Promise<void> {
    await this.kv.put(KV_KEYS.PENDING_GITHUB_INSTALL(userId), clusterId, {
      ttl: PENDING_GITHUB_INSTALL_TTL,
    });
  }

  async getPendingGitHubInstall(userId: string): Promise<string | null> {
    return this.kv.get(KV_KEYS.PENDING_GITHUB_INSTALL(userId));
  }

  async deletePendingGitHubInstall(userId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.PENDING_GITHUB_INSTALL(userId));
  }

  // Instance caching
  async cacheInstance(instance: { id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number }): Promise<void> {
    const data = JSON.stringify(instance);
    const ttl = INSTANCE_STATUS_TTL;

    // Cache by ID, clusterId+tag, and tag-only for triple lookup support
    await Promise.all([
      this.kv.put(KV_KEYS.INSTANCE_BY_ID(instance.id), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE_BY_NAME(instance.clusterId, instance.tag), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE_BY_TAG(instance.tag), data, { ttl }),
    ]);
  }

  async getCachedInstance(instanceId: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_ID(instanceId));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async getCachedInstanceByName({ clusterId, tag }: { clusterId: string; tag: string }): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_NAME(clusterId, tag));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async getCachedInstanceByTag(tag: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_TAG(tag));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async invalidateInstanceCache({ instanceId, clusterId, tag }: { instanceId: string; clusterId?: string; tag?: string }): Promise<void> {
    const deletes: Promise<void>[] = [this.kv.delete(KV_KEYS.INSTANCE_BY_ID(instanceId))];

    if (clusterId && tag) {
      deletes.push(this.kv.delete(KV_KEYS.INSTANCE_BY_NAME(clusterId, tag)));
    }

    if (tag) {
      deletes.push(this.kv.delete(KV_KEYS.INSTANCE_BY_TAG(tag)));
    }

    await Promise.all(deletes);
  }
  // Service state caching

  async cacheServices(instanceId: string, services: Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }>): Promise<void> {
    const data = JSON.stringify(services);
    await this.kv.put(KV_KEYS.SERVICES(instanceId), data, { ttl: 60 });
  }

  async getCachedServices(instanceId: string): Promise<Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }> | null> {
    try {
      const data = await this.kv.get(KV_KEYS.SERVICES(instanceId));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async invalidateServiceCache(instanceId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.SERVICES(instanceId));
  }

  async saveProcessSnapshot({ instanceId, seq, snapshot }: { instanceId: string; seq: number; snapshot: Record<string, unknown> }): Promise<void> {
    const timestamp = Date.now();
    const key = KV_KEYS.PROCESS_SNAPSHOT(instanceId, timestamp);
    await this.kv.put(key, JSON.stringify({ seq, timestamp, data: snapshot }), {
      ttl: 60 * 60 * 2, // 120 minutes
    });
  }

  async getProcessSnapshot({ instanceId, timestamp }: { instanceId: string; timestamp: number }): Promise<Record<string, unknown> | null> {
    const key = KV_KEYS.PROCESS_SNAPSHOT(instanceId, timestamp);
    const data = await this.kv.get(key);
    if (!data) return null;
    const parsed = JSON.parse(data);
    return parsed.data;
  }

  async getLatestProcessSnapshots({ instanceId, limit = 10 }: { instanceId: string; limit?: number }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const prefix = `process:${instanceId}:snapshot:`;
    const maxLimit = Math.min(limit, 1000); // Cap at 1000 snapshots max
    const result = await this.kv.list({ prefix, limit: maxLimit });

    const snapshots = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const timestampMatch = key.name.match(/:snapshot:(\d+)$/);
        if (!timestampMatch) return null;
        try {
          const parsed = JSON.parse(data);
          return {
            seq: parsed.seq,
            timestamp: parseInt(timestampMatch[1], 10),
            data: parsed.data,
          };
        } catch {
          return null;
        }
      }),
    );

    return snapshots
      .filter((s): s is { seq: number; timestamp: number; data: Record<string, unknown> } => s !== null)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxLimit);
  }

  async getProcessSnapshotsByTimeRange({ instanceId, startTime, endTime }: { instanceId: string; startTime: number; endTime: number }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    // Cap at 1 hour max range
    const maxRange = 60 * 60 * 1000; // 1 hour in milliseconds
    const cappedEndTime = Math.min(endTime, startTime + maxRange);

    const prefix = `process:${instanceId}:snapshot:`;
    const result = await this.kv.list({ prefix, limit: 10000 });

    const snapshots = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const timestampMatch = key.name.match(/:snapshot:(\d+)$/);
        if (!timestampMatch) return null;
        const timestamp = parseInt(timestampMatch[1], 10);

        // Filter by time range
        if (timestamp < startTime || timestamp > cappedEndTime) return null;

        try {
          const parsed = JSON.parse(data);
          return {
            seq: parsed.seq,
            timestamp,
            data: parsed.data,
          };
        } catch {
          return null;
        }
      }),
    );

    return snapshots.filter((s): s is { seq: number; timestamp: number; data: Record<string, unknown> } => s !== null).sort((a, b) => a.timestamp - b.timestamp); // Ascending order for timeline
  }

  async createAdminJWT({ sessionId, ttl }: { sessionId: string; ttl?: number }): Promise<string> {
    const privateKey = await this.getPrivateKey();
    const payload = {
      sub: sessionId,
      type: "admin",
    };
    return await new SignJWT(payload).setProtectedHeader({ alg: "RS256" }).setIssuedAt().setExpirationTime("30m").sign(privateKey);
  }

  async getAdminJWT(sessionId: string): Promise<string | null> {
    const data = await this.kv.get(KV_KEYS.ADMIN_JWT(sessionId));
    if (!data) return null;
    try {
      const parsed = JSON.parse(data);
      const expiresAt = parsed.expiresAt;
      const now = Date.now();
      if (expiresAt - now < ADMIN_JWT_REFRESH_THRESHOLD * 1000) {
        return null;
      }
      return parsed.token;
    } catch {
      return null;
    }
  }

  async saveAdminJWT({ sessionId, token, ttl = ADMIN_JWT_TTL }: { sessionId: string; token: string; ttl?: number }): Promise<void> {
    const expiresAt = Date.now() + ttl * 1000;
    await this.kv.put(`admin_jwt:${sessionId}`, JSON.stringify({ token, expiresAt }), { ttl });
  }
}
