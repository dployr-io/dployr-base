import { Bindings } from "@/types";
import { D1Store } from "@/lib/db/store";

export class InstanceObject {
  constructor(private state: DurableObjectState, private env: Bindings) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname.endsWith("/start")) {
      return this.handleStart(request);
    }

    return new Response("Not found", { status: 404 });
  }

  private async handleStart(request: Request): Promise<Response> {
    const { instanceId } = (await request.json().catch(() => ({}))) as {
      instanceId?: string;
    };

    if (!instanceId) {
      return new Response(JSON.stringify({ error: "instanceId is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const d1 = new D1Store(this.env.BASE_DB);
    const instance = await d1.instances.get(instanceId);

    if (!instance) {
      return new Response(JSON.stringify({ error: "Instance not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    // Artificial delay for provisioning placeholder
    await new Promise((resolve) => setTimeout(resolve, 5000));

    const logEntry = {
      ts: Date.now(),
      level: "info" as const,
      message: "Instance provisioned",
      instanceId,
      address: instance.address,
    };

    await this.env.INSTANCE_LOGS.put(
      `${instance.clusterId}/${instanceId}.log`,
      JSON.stringify([logEntry]),
      {
        httpMetadata: {
          contentType: "application/json",
        },
      },
    );

    return new Response(
      JSON.stringify({ instanceId, status: "completed" }),
      {
        status: 200,
        headers: { "Content-Type": "application/json" },
      },
    );
  }
}
