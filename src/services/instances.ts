import { Bindings, Instance, Session } from "@/types";
import { D1Store } from "@/lib/db/store";
import { ERROR, EVENTS } from "@/lib/constants";
import { KVStore } from "@/lib/db/store/kv";
import { Context } from "hono";

export class InstanceService {
  constructor(private env: Bindings) {}

  async createInstance({
    clusterId,
    address,
    publicKey,
    tag,
    session,
    c,
  }: {
    clusterId: string;
    address: string;
    publicKey: string;
    tag: string;
    session: Session;
    c: Context;
  }) {
    const d1 = new D1Store(this.env.BASE_DB);
    const kv = new KVStore(this.env.BASE_KV);

    const instance = await d1.instances.create(clusterId, publicKey, {
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
}
