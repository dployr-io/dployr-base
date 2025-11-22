import { Bindings, Instance, Session } from "@/types";
import { D1Store } from "@/lib/db/store";
import { ERROR, EVENTS } from "@/lib/constants";
import { KVStore } from "@/lib/db/store/kv";
import { Context } from "hono";
import { JWTService } from "@/services/jwt";

export class InstanceService {
  constructor(private env: Bindings) {}

  async createInstance({
    clusterId,
    tag,
    session,
    c,
  }: {
    clusterId: string;
    tag: string;
    session: Session;
    c: Context;
  }): Promise<{ instance: Instance; token: string }> {
    const d1 = new D1Store(this.env.BASE_DB);
    const kv = new KVStore(this.env.BASE_KV);

    const instance = await d1.instances.create(clusterId, {
      tag,
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
    await d1.bootstrapTokens.create(instance.id, decoded.nonce as string);

    return { instance, token };
  }

  async pingInstance({ 
    instanceId,
    session,
    c,
  }: { 
    instanceId: string; 
    session: Session; 
    c: Context 
  }): Promise<"completed" | "failed"> {
    const d1 = new D1Store(this.env.BASE_DB);
    const kv = new KVStore(this.env.BASE_KV);
    const instance = await d1.instances.get(instanceId);

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

    const id = this.env.INSTANCE_OBJECT.idFromName(instanceId);
    const stub = this.env.INSTANCE_OBJECT.get(id);

    const response = await stub.fetch(
      new Request("https://instance.internal/ping", {
        method: "POST",
        body: JSON.stringify({ instanceId }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    const data = await response.json();

    await kv.saveInstanceStatus(instanceId, data as Record<string, unknown>);

    if (!response.ok) {
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
        type: ERROR.BOOTSTRAP.BOOTSTRAP_RUN_FAILURE.code,
        request: c.req.raw,
      });

      return "failed";
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
      type: EVENTS.BOOTSTRAP.BOOTSTRAP_RUN_COMPLETED.code,
      request: c.req.raw,
    });

    return "completed";
  }

  async registerInstance({
    token,
  }: {
    token: string;
  }): Promise<
    | { ok: true; instanceId: string; jwksUrl: string }
    | { ok: false; reason: "invalid_token" | "invalid_type" | "already_used" }
  > {
    const kv = new KVStore(this.env.BASE_KV);
    const d1 = new D1Store(this.env.BASE_DB);
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

    const wasUnused = await d1.bootstrapTokens.markUsed(payload.nonce as string);
    if (!wasUnused) {
      return { ok: false, reason: "already_used" };
    }

    return {
      ok: true,
      instanceId: payload.instance_id,
      jwksUrl: `${this.env.BASE_URL}/v1/jwks/.well-known/jwks.json`,
    };
  }
}
