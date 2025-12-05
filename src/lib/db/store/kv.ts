// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ActorType, Session, User } from "@/types/index.js";
import { ulid } from "ulid";
import { CryptoKey, importPKCS8 } from "jose";
import { generateKeyPair } from "@/lib/crypto/keystore.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { FAILED_WORKFLOW_EVENT_TTL, OTP_TTL, SESSION_TTL, STATE_TTL, EVENT_TTL, AGENT_UPDATE_TTL, RELEASE_CACHE_TTL, DEDUP_TTL } from "@/lib/constants/index.js";
import { JsonWebKey } from "crypto";

export class KVStore {
  constructor(public kv: IKVAdapter) { }

  // Session management
  async createSession(sessionId: string, user: Omit<User, "createdAt" | "updatedAt">, clusters: { id: string, name: string, owner: string }[]): Promise<Session> {
    const session: Session = {
      userId: user.id,
      email: user.email,
      provider: user.provider,
      clusters: clusters,
      createdAt: Date.now(),
      expiresAt: Date.now() + SESSION_TTL * 1000,
    };

    await this.kv.put(`session:${sessionId}`, JSON.stringify(session), {
      expirationTtl: SESSION_TTL,
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
      await this.kv.put(idemKey, "1", { expirationTtl: DEDUP_TTL });
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
        this.kv.put(actorKey, JSON.stringify(actorEvent), { expirationTtl: EVENT_TTL })
      ];

      for (const target of targets) {
        const event = {
          ...baseEvent,
          id,
          targets: [target],
        };
        const targetKey = `target:${target.id}:event:${id}`;
        writes.push(this.kv.put(targetKey, JSON.stringify(event), { expirationTtl: EVENT_TTL }));
      }

      await Promise.all(writes);
    } else {
      // No targets, create single event
      const event = {
        ...baseEvent,
        id: ulid()
      };

      const actorKey = `actor:${actor.id}:event:${event.id}`;
      await this.kv.put(actorKey, JSON.stringify(event), { expirationTtl: EVENT_TTL });
    }
  }

  async getEvents(userId: string): Promise<any[]> {
    const result = await this.kv.list({ prefix: `actor:${userId}:event:` });
    const events = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        return data ? JSON.parse(data) : null;
      })
    );
    return events.filter(e => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  async getClusterEvents(clusterId: string): Promise<any[]> {
    const result = await this.kv.list({ prefix: `target:${clusterId}:event:` });
    const events = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        return data ? JSON.parse(data) : null;
      })
    );
    return events.filter(e => e !== null).sort((a: any, b: any) => b.timestamp - a.timestamp);
  }

  async createWorkflowFailedEvent(id: string, data: Record<string, unknown>): Promise<void> {
    await this.kv.put(`workflow:${id}`, JSON.stringify(data), {
      expirationTtl: FAILED_WORKFLOW_EVENT_TTL,
    });
  }

  // OAuth state management (CSRF protection)
  async createState(state: string, redirectUrl: string): Promise<void> {
    await this.kv.put(`state:${state}`, JSON.stringify({
      state,
      redirectUrl,
      createdAt: Date.now()
    }), {
      expirationTtl: STATE_TTL,
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
      { expirationTtl: OTP_TTL }
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
      expirationTtl: OTP_TTL,
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
      expirationTtl: AGENT_UPDATE_TTL,
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
      const resp = await fetch("https://api.github.com/repos/dployr-io/dployr/releases/latest");
      if (!resp.ok) {
        return null;
      }
      const body = await resp.json();
      const tag = (body as any).tag_name as string | undefined;
      if (!tag) return null;

      await this.kv.put("version:latest", JSON.stringify({ tag }), {
        expirationTtl: RELEASE_CACHE_TTL,
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
}
