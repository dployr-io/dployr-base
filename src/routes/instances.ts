import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { InstanceService } from "@/services/instances";
import { InstanceConflictError } from "@/lib/db/store/instances";
import z from "zod";
import { requireClusterAdmin, requireClusterOwner, requireClusterViewer } from "@/middleware/auth";
import { ERROR, EVENTS } from "@/lib/constants";
import { authMiddleware } from "@/middleware/auth";
import { SystemStatus } from "@dployr-io/dployr-sdk/dist/client/models";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();
instances.use("*", authMiddleware);

const createInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().regex(
    /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/,
    "Address must be a valid IPv4 address"
  ),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters"),
});

// List all instances by cluster
instances.get("/", requireClusterViewer, async (c) => {
  const clusterId = c.req.query("clusterId");
  if (!clusterId) {
    return c.json(createErrorResponse({ 
      message: "Cluster ID is required", 
      code: ERROR.REQUEST.BAD_REQUEST.code 
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const kv = new KVStore(c.env.BASE_KV);
  const service = new InstanceService(c.env);
  const session = c.get("session")!;

  const { page, pageSize, offset } = parsePaginationParams(
    c.req.query("page"),
    c.req.query("pageSize")
  );

  const { instances: _instances, total } = await d1.instances.getByCluster(
    clusterId,
    pageSize,
    offset
  );

  const instances = await Promise.all(
    _instances.map(async (instance) => {
      const status: SystemStatus | undefined = await kv.getInstanceStatus(instance.id);

      c.executionCtx.waitUntil(
        service.pingInstance({
          instanceId: instance.id,
          session,
          c,
        }),
      );
      
      return { ...instance, status };
    })
  );

  const paginatedData = createPaginatedResponse(instances, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

// Create a new instance
instances.post("/", requireClusterOwner, async (c) => {
  try {
    const session = c.get("session")!;
    const service = new InstanceService(c.env);
    const kv = new KVStore(c.env.BASE_KV);
    const data = await c.req.json();

    const validation = createInstanceSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ 
        message: "Validation failed " + errors.map(e => `${e.field}: ${e.message}`).join(", "), 
        code: ERROR.REQUEST.BAD_REQUEST.code 
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { clusterId, tag, address } = validation.data;

    const { instance, token } = await service.createInstance({
      clusterId,
      tag,
      address,
      session,
      c,
    });

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
      type: EVENTS.RESOURCE.RESOURCE_CREATED.code,
      request: c.req.raw,
    });

    c.executionCtx.waitUntil(
      service.pingInstance({
        instanceId: instance.id,
        session,
        c,
      }),
    );

    return c.json(
      createSuccessResponse(
        { instance, token },
        "Instance provisioning started",
      ),
      { status: 202 }
    );
  } catch (error) {
    console.error("Failed to create instance", error);

    if (error instanceof InstanceConflictError) {
      const field = error.field;
      const message =
        field === "address"
          ? "Instance address already in use"
          : field === "tag"
          ? "Instance tag already in use"
          : "Instance already exists";

      return c.json(
        createErrorResponse({
          message,
          code: ERROR.RESOURCE.CONFLICT.code,
        }),
        ERROR.RESOURCE.CONFLICT.status,
      );
    }

    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ 
      message: "Instance creation failed", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Get instance logs
instances.get("/:instanceId/logs", requireClusterAdmin, async (c) => {
  try {
    const instanceId = c.req.param("instanceId");
    const clusterId = c.req.query("clusterId")!;

    if (!clusterId) {
      return c.json(createErrorResponse({ 
        message: "Cluster ID is required", 
        code: ERROR.REQUEST.BAD_REQUEST.code 
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const object = await c.env.INSTANCE_LOGS.get(`${clusterId}/${instanceId}.log`);

    if (!object) {
      return c.json(
        createErrorResponse({
          message: "Logs not found",
          code: ERROR.RESOURCE.MISSING_RESOURCE.code,
        }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }

    const session = c.get("session");
    const userId = session?.userId!;

    const kv = new KVStore(c.env.BASE_KV);

    await kv.logEvent({
      actor: {
        id: userId,
        type: "user",
      },
      targets: [{ id: clusterId }],
      type: EVENTS.READ.BOOTSTRAP_LOGS.code,
      request: c.req.raw,
    });

    const logs = await object.text();
    const data = JSON.parse(logs);

    return c.json(
      createSuccessResponse(data, "Instance logs fetched successfully"),
    );
  } catch (error) {
    console.error("Get instance logs error:", error);
    return c.json(
      createErrorResponse({
        message: "Failed to fetch instance logs",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Delete an instance
instances.delete("/:instanceId", requireClusterOwner, async (c) => {
  try {
    const instanceId = c.req.param("instanceId");
    const clusterId = c.req.query("clusterId");
    const session = c.get("session")!;

    if (!clusterId) {
      return c.json(
        createErrorResponse({
          message: "Cluster ID is required",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }

    const d1 = new D1Store(c.env.BASE_DB);
    const kv = new KVStore(c.env.BASE_KV);
    const instance = await d1.instances.get(instanceId);

    if (!instance || instance.clusterId !== clusterId) {
      return c.json(
        createErrorResponse({
          message: "Instance not found",
          code: ERROR.RESOURCE.MISSING_RESOURCE.code,
        }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }

    await d1.instances.delete(instanceId);

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
      type: EVENTS.RESOURCE.RESOURCE_DELETED.code,
      request: c.req.raw,
    });

    return c.json(
      createSuccessResponse({}, "Instance deleted successfully"),
    );
  } catch (error) {
    console.error("Failed to delete instance", error);
    return c.json(
      createErrorResponse({
        message: "Instance deletion failed",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Get instance status

// Run instance doctor

export default instances;
