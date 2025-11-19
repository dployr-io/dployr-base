import { Bindings } from "@/types";
import { D1Store } from "@/lib/db/store";

export class InstanceService {
  constructor(private env: Bindings) {}

  async createInstance(
    clusterId: string,
    address: string,
    publicKey: string,
    tag: string,
  ) {
    const d1 = new D1Store(this.env.BASE_DB);

    const instance = await d1.instances.create(clusterId, publicKey, {
      address,
      tag,
    } as any);

    return instance;
  }

  async startInstance(instanceId: string): Promise<"completed" | "failed"> {
    const d1 = new D1Store(this.env.BASE_DB);
    const instance = await d1.instances.get(instanceId);

    if (!instance) {
      throw new Error("Instance not found");
    }

    const id = this.env.INSTANCE_OBJECT.idFromString(instanceId);
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
      return "failed";
    }

    await d1.instances.update(instanceId, {
      metadata: { provisioningStatus: "completed" },
    });

    return "completed";
  }
}
