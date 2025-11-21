import { Bindings, Instance, Session } from "@/types";
import { D1Store } from "@/lib/db/store";
import { ERROR, EVENTS } from "@/lib/constants";
import { KVStore } from "@/lib/db/store/kv";
import { Context } from "hono";
import { KeyStore } from "@/lib/crypto/keystore";
import { JWTService } from "@/services/jwt";

export class InstanceService {
  constructor(private env: Bindings) {}

  async createInstance({
    clusterId,
    address,
    tag,
    session,
    c,
  }: {
    clusterId: string;
    address: string;
    tag: string;
    session: Session;
    c: Context;
  }) {
    const d1 = new D1Store(this.env.BASE_DB);
    const kv = new KVStore(this.env.BASE_KV);

    const instance = await d1.instances.create(clusterId, "", {
      address,
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
    
    const keyStore = new KeyStore(this.env.BASE_KV);
    const jwtService = new JWTService(keyStore);
    const bootstrapToken = await jwtService.createBootstrapToken(instance.id);
    const decoded = await jwtService.verifyToken(bootstrapToken);
    await d1.bootstrapTokens.create(instance.id, decoded.nonce as string);

    return instance;
  }

  async updateInstance({
    instanceId,
    clusterId,
    address,
    publicKey,
    tag,
    session,
    c,
  }: {
    instanceId: string;
    clusterId: string;
    address?: string;
    publicKey?: string;
    tag?: string;
    session: Session;
    c: Context;
  }) {
    const d1 = new D1Store(this.env.BASE_DB);
    const kv = new KVStore(this.env.BASE_KV);

    const instance = await d1.instances.update(instanceId, {
      id: clusterId,  
      address,
      tag,
      publicKey
    } as Partial<Omit<Instance, "id" | "resources" | "status" | "createdAt">>);

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

    return instance;
  }


  async startInstance({ 
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
      new Request("https://instance.internal/start", {
        method: "POST",
        body: JSON.stringify({ instanceId }),
        headers: { "Content-Type": "application/json" },
      }),
    );

    if (!response.ok) {
      await d1.instances.update(instanceId, {
        metadata: { provisioningStatus: "failed" },
      });

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

    await d1.instances.update(instanceId, {
      metadata: { provisioningStatus: "completed" },
    });

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
    publicKey,
  }: {
    token: string;
    publicKey: string;
  }): Promise<
    | { ok: true; instanceId: string; jwksUrl: string }
    | { ok: false; reason: "invalid_token" | "invalid_type" | "already_used" }
  > {
    const keyStore = new KeyStore(this.env.BASE_KV);
    const jwtService = new JWTService(keyStore);
    const d1 = new D1Store(this.env.BASE_DB);

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

    const instance = await d1.instances.update(payload.instance_id as string, {
      publicKey,
      metadata: { registered_at: Date.now() },
    });

    return {
      ok: true,
      instanceId: instance!.id,
      jwksUrl: `${this.env.BASE_URL}/v1/jwks/.well-known/jwks.json`,
    };
  }
}
