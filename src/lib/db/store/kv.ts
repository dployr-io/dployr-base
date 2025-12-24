// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ActorType, Session, User } from "@/types/index.js";
import { ulid } from "ulid";
import { CryptoKey, importPKCS8 } from "jose";
import { generateKeyPair } from "@/lib/crypto/keystore.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { FAILED_WORKFLOW_EVENT_TTL, OTP_TTL, SESSION_TTL, STATE_TTL, EVENT_TTL, AGENT_UPDATE_TTL, RELEASE_CACHE_TTL, DEDUP_TTL, PENDING_GITHUB_INSTALL_TTL, INSTANCE_STATUS_TTL } from "@/lib/constants/index.js";
import { JsonWebKey } from "crypto";

export class KVStore {
  constructor(public kv: IKVAdapter, private githubToken?: string) { }

  // Session management
  async createSession(sessionId: string, user: Omit<User, "createdAt" | "updatedAt">, clusters: { id: string, name: string, owner: string, role: string }[]): Promise<Session> {
    const session: Session = {
      userId: user.id,
      email: user.email,
      provider: user.provider,
      clusters,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL * 1000,
    };

    await this.kv.put(`session:${sessionId}`, JSON.stringify(session), {
      ttl: SESSION_TTL,
    });

    return session;
  }

  async getSession(sessionId: string): Promise<Session | null> {
    const data = await this.kv.get(`session:${sessionId}`);
    if (!data) return null;

    const session = JSON.parse(data) as Session;

    if (session.expiresAt < Date.now()) {
      await this.deleteSession(sessionId);
      return null;
    }

    return session;
  }

  async deleteSession(sessionId: string): Promise<void> {
    await this.kv.delete(`session:${sessionId}`);
  }

  // Retrieves or creates the key pair.
  async getOrCreateKeys(): Promise<{
    publicKeyJwk: JsonWebKey;
    privateKey: string;
  }> {
    const data = await this.kv.get("jwt_keys");
    let existing: { publicKeyJwk: JsonWebKey; privateKey: string } | null = null;
    if (data) {
      existing = JSON.parse(data);
    }

    if (!existing) {
      const generated = await generateKeyPair();
      existing = generated;
      await this.kv.put("jwt_keys", JSON.stringify(generated));
    }

    return existing;
  }

  // Retrieves the public key.
  async getPublicKey(): Promise<JsonWebKey> {
    const keys = await this.getOrCreateKeys();

    if (!(keys.publicKeyJwk as any).kid) {
      (keys.publicKeyJwk as any).kid = "base-key";
      await this.kv.put("jwt_keys", JSON.stringify(keys));
    }

    return keys.publicKeyJwk;
  }

  // Retrieves the private key.
  async getPrivateKey(): Promise<CryptoKey> {
    const keys = await this.getOrCreateKeys();
    return importPKCS8(keys.privateKey, "RS256");
  }

  // Event management
  async logEvent({
    type,
    actor,
    targets,
    request
  }: {
    type: string;
    actor: { id: string; type: ActorType };
    targets?: { id: string }[];
    request: Request;
  }): Promise<void> {
    const headers = request.headers;

    const timezone =
      headers.get('x-timezone') ||
      'UTC';

    const baseEvent = {
      type,
      actor,
      timestamp: Date.now(),
      timezone,
      timezoneOffset: new Date().toLocaleString('en-US', {
        timeZone: timezone,
        timeZoneName: 'shortOffset',
      })
    };

    const ray =
      headers.get('x-ray-id') ||
      headers.get('x-request-id') ||
      '';
    const targetScope = Array.isArray(targets) ? targets.map(t => t.id).sort().join(",") : "";
    const idemKey = `event:idem:${type}:${actor.id}:${ray}:${targetScope}`;
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

      const actorKey = `actor:${actor.id}:event:${id}`;
      const writes: Promise<any>[] = [
        this.kv.put(actorKey, JSON.stringify(actorEvent), { ttl: EVENT_TTL })
      ];

      for (const target of targets) {
        const event = {
          ...baseEvent,
          id,
          targets: [target],
        };
        const targetKey = `target:${target.id}:event:${id}`;
        writes.push(this.kv.put(targetKey, JSON.stringify(event), { ttl: EVENT_TTL }));
      }

      await Promise.all(writes);
    } else {
      // No targets, create single event
      const event = {
        ...baseEvent,
        id: ulid()
      };

      const actorKey = `actor:${actor.id}:event:${event.id}`;
      await this.kv.put(actorKey, JSON.stringify(event), { ttl: EVENT_TTL });
    }
  }

  async getEvents(userId: string): Promise<any[]> {
    const result = await this.kv.list({ prefix: `actor:${userId}:event:` });
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
      })
    );
    return events.filter(e => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  async getClusterEvents(clusterId: string): Promise<any[]> {
    const prefix = `target:${clusterId}:event:`;
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
      })
    );
    return events.filter(e => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  async createWorkflowFailedEvent(id: string, data: Record<string, unknown>): Promise<void> {
    await this.kv.put(`workflow:${id}`, JSON.stringify(data), {
      ttl: FAILED_WORKFLOW_EVENT_TTL,
    });
  }

  // OAuth state management (CSRF protection)
  async createState(state: string, redirectUrl: string): Promise<void> {
    await this.kv.put(`state:${state}`, JSON.stringify({
      state,
      redirectUrl,
      createdAt: Date.now()
    }), {
      ttl: STATE_TTL,
    });
  }

  async validateState(state: string): Promise<string | null> {
    const data = await this.kv.get(`state:${state}`);
    if (!data) return null;

    const stateData = JSON.parse(data) as {
      state: string;
      redirectUrl: string;
      createdAt: number;
    };

    await this.kv.delete(`state:${state}`);
    return stateData.redirectUrl;
  }

  async createOTP(email: string): Promise<string> {
    const code = this.generateOTP();

    await this.kv.put(
      `otp:${email}`,
      JSON.stringify({
        code,
        email,
        createdAt: Date.now(),
        attempts: 0,
      }),
      { ttl: OTP_TTL }
    );

    return code;
  }

  async validateOTP(email: string, code: string): Promise<boolean> {
    const data = await this.kv.get(`otp:${email}`);
    if (!data) return false;

    const otpData = JSON.parse(data) as {
      code: string;
      email: string;
      createdAt: number;
      attempts: number;
    };

    if (otpData.attempts >= 3) {
      await this.kv.delete(`otp:${email}`);
      return false;
    }

    otpData.attempts++;
    await this.kv.put(`otp:${email}`, JSON.stringify(otpData), {
      ttl: OTP_TTL,
    });

    if (otpData.code === code) {
      await this.kv.delete(`otp:${email}`);
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

  async saveDomain(domain: string, address: string): Promise<void> {
    await this.kv.put(`domain:${domain}`, address);
  }

  async getDomain(domain: string): Promise<string | null> {
    const data = await this.kv.get(`domain:${domain}`);
    if (!data) return null;
    return data;
  }

  // Agent update management
  async saveAgentUpdate(instanceId: string, update: Record<string, unknown>): Promise<void> {
    const now = Date.now();
    const data = {
      ...update,
      lastUpdated: now,
    };
    
    // Save latest update with TTL
    await this.kv.put(`agent:${instanceId}:update`, JSON.stringify(data), {
      ttl: AGENT_UPDATE_TTL,
    });
  }

  async getAgentUpdate(instanceId: string): Promise<Record<string, unknown> | null> {
    const data = await this.kv.get(`agent:${instanceId}:update`);
    if (!data) return null;
    return JSON.parse(data);
  }

  // Version cache for latest GitHub release
  private async getCachedLatestVersion(): Promise<string | null> {
    try {
      const raw = await this.kv.get("version:latest");
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

      await this.kv.put("version:latest", JSON.stringify({ tag }), {
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
    await this.kv.put(`pending_github_install:${userId}`, clusterId, {
      ttl: PENDING_GITHUB_INSTALL_TTL,
    });
  }

  async getPendingGitHubInstall(userId: string): Promise<string | null> {
    return this.kv.get(`pending_github_install:${userId}`);
  }

  async deletePendingGitHubInstall(userId: string): Promise<void> {
    await this.kv.delete(`pending_github_install:${userId}`);
  }

  // Instance caching
  async cacheInstance(instance: { id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number }): Promise<void> {
    const data = JSON.stringify(instance);
    const ttl = INSTANCE_STATUS_TTL;
    
    // Cache by ID, clusterId+tag, and tag-only for triple lookup support
    await Promise.all([
      this.kv.put(`instance:id:${instance.id}`, data, { ttl }),
      this.kv.put(`instance:name:${instance.clusterId}:${instance.tag}`, data, { ttl }),
      this.kv.put(`instance:tag:${instance.tag}`, data, { ttl }),
    ]);
  }

  async getCachedInstance(instanceId: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(`instance:id:${instanceId}`);
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async getCachedInstanceByName(clusterId: string, tag: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(`instance:name:${clusterId}:${tag}`);
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async getCachedInstanceByTag(tag: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(`instance:tag:${tag}`);
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async invalidateInstanceCache(instanceId: string, clusterId?: string, tag?: string): Promise<void> {
    const deletes: Promise<void>[] = [
      this.kv.delete(`instance:id:${instanceId}`),
    ];
    
    if (clusterId && tag) {
      deletes.push(this.kv.delete(`instance:name:${clusterId}:${tag}`));
    }
    
    if (tag) {
      deletes.push(this.kv.delete(`instance:tag:${tag}`));
    }
    
    await Promise.all(deletes);
  }
}
