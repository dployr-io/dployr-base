// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Bindings, Instance, Session } from "@/types/index.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { EVENTS } from "@/lib/constants/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { Context } from "hono";
import { JWTService } from "@/services/jwt.js";
import { ulid } from "ulid";
import { getKV, getDB, getWS } from "@/lib/context.js";

export class InstanceService {
  constructor(private env: Bindings) {}

  async createInstance({
    clusterId,
    tag,
    address,
    session,
    c,
  }: {
    clusterId: string;
    tag: string;
    address: string;
    session: Session;
    c: Context;
  }): Promise<{ instance: Instance; token: string }> {
    const db = new DatabaseStore(getDB(c));
    const kv = new KVStore(getKV(c));

    const instance = await db.instances.create(clusterId, {
      tag,
      address,
    } as any);

    await kv.logEvent({
      actor: {
        id: session.userId,
        type: "user",
      },
      targets: [
        {
          id: clusterId,
        },
      ],
      type: EVENTS.BOOTSTRAP.BOOTSTRAP_SETUP_COMPLETED.code,
      request: c.req.raw,
    });
    
    const jwtService = new JWTService(kv);
    const token = await jwtService.createBootstrapToken(instance.id);
    const decoded = await jwtService.verifyToken(token);
    await db.bootstrapTokens.create(instance.id, decoded.nonce as string);

    return { instance, token };
  }

  async getOrCreateInstanceUserToken(
    kv: KVStore,
    session: Session,
    instanceId: string,
  ): Promise<string> {
    const role = "viewer";
    const key = `inst:${instanceId}:user:${session.userId}:role:${role}:token`;

    try {
      const raw = await kv.kv.get(key);
      const cached = typeof raw === "string" ? (JSON.parse(raw) as { token?: string } | null) : null;
      const tok = cached && typeof cached.token === "string" ? cached.token : undefined;
      if (typeof tok === "string" && tok.trim().length > 0) {
        return tok;
      }
    } catch {}

    const jwtService = new JWTService(kv);
    const token = await jwtService.createInstanceAccessToken(
      session,
      instanceId,
      role,
      { issuer: this.env.BASE_URL, audience: "dployr-daemon" },
    );

    let ttl = 240;
    try {
      const payload = await jwtService.verifyToken(token);
      const expSec = typeof (payload as any).exp === "number" ? (payload as any).exp : 0;
      const nowMs = Date.now();
      const expMs = expSec * 1000;
      const bufferMs = 10_000;
      const remainMs = expMs - nowMs - bufferMs;
      ttl = Math.max(0, Math.floor(remainMs / 1000));
    } catch {}

    try {
      if (ttl > 0) {
        await kv.kv.put(key, JSON.stringify({ token }), { ttl: ttl });
      }
    } catch {}

    return token;
  }

  async pingInstance({ 
    instanceId,
    session,
    c,
  }: { 
    instanceId: string; 
    session: Session; 
    c: Context 
  }): Promise<"enqueued"> {
    const db = new DatabaseStore(getDB(c));
    const kv = new KVStore(getKV(c));
    const instance = await db.instances.get(instanceId);

    if (!instance) {
      throw new Error("Instance not found");
    }

    await kv.logEvent({
      actor: {
        id: session.userId,
        type: "user",
      },
      targets: [
        {
          id: instance.clusterId,
        },
      ],
      type: EVENTS.BOOTSTRAP.BOOTSTRAP_RUN_STARTED.code,
      request: c.req.raw,
    });

    const token = await this.getOrCreateInstanceUserToken(kv, session, instance.id);
    
    // Task queuing removed - agents connect via WebSocket and receive tasks directly
    // TODO: Implement task queue if async task delivery is needed
    // For now, tasks are sent when agent is connected via WS
    return "enqueued";
  }

  async registerInstance({
    token,
    c,
  }: {
    token: string;
    c: Context;
  }): Promise<
    | { ok: true; instanceId: string; jwksUrl: string }
    | { ok: false; reason: "invalid_token" | "invalid_type" | "already_used" }
  > {
    const kv = new KVStore(getKV(c));
    const db = new DatabaseStore(getDB(c));
    const jwtService = new JWTService(kv);

    let payload: any;
    try {
      payload = await jwtService.verifyToken(token);
    } catch {
      return { ok: false, reason: "invalid_token" };
    }

    if (payload.token_type !== "bootstrap") {
      return { ok: false, reason: "invalid_type" };
    }

    const wasUnused = await db.bootstrapTokens.markUsed(payload.nonce as string);
    if (!wasUnused) {
      return { ok: false, reason: "already_used" };
    }

    return {
      ok: true,
      instanceId: payload.instance_id,
      jwksUrl: `${this.env.BASE_URL}/v1/jwks/.well-known/jwks.json`,
    };
  }

  async saveDomain({
    instanceId,
    c,
  }: {
    instanceId: string;
    c: Context;
  }) {
    const db = new DatabaseStore(getDB(c));
    const kv = new KVStore(getKV(c));
    const instance = await db.instances.get(instanceId);

    if (!instance) {
      throw new Error("Instance not found");
    }

    await kv.saveDomain(instance.tag, instance.address);

    return `${instance.tag}.dployr.io`;
  }
}
