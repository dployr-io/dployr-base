import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { InstanceService } from "@/services/instances";
import z from "zod";
import { authMiddleware, requireClusterAdmin, requireClusterOwner, requireClusterViewer } from "@/middleware/auth";
import { ERROR, EVENTS } from "@/lib/constants";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();
instances.use("*", authMiddleware);

const createInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().min(10, "Address with a minimum of 10 characters is required").max(16, "Address must be a maximum of 16 characters"),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters"),
});

const updateInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().min(10, "Address with a minimum of 10 characters is required").max(16, "Address must be a maximum of 16 characters" ).optional(),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters").optional(),
  publicKey: z.string().min(1, "Public key is required").max(255, "Public key must be a maximum of 255 characters").optional(),
});

const registerInstanceSchema = z.object({
  token: z.string().min(1, "Token is required"),
  publicKey: z.string().min(1, "Public key is required").max(255, "Public key must be a maximum of 255 characters"),
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

  const { page, pageSize, offset } = parsePaginationParams(
    c.req.query("page"),
    c.req.query("pageSize")
  );

  const { instances, total } = await d1.instances.getByCluster(
    clusterId,
    pageSize,
    offset
  );

  const paginatedData = createPaginatedResponse(instances, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

// Create a new instance
instances.post("/", requireClusterOwner, async (c) => {
  try {
    const session = c.get("session")!;
    const service = new InstanceService(c.env);
    const data = await c.req.json();

    const validation = createInstanceSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ 
        message: "Validation failed " + errors, 
        code: ERROR.REQUEST.BAD_REQUEST.code 
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { clusterId, address, tag } = validation.data;

    const instance = await service.createInstance({
      clusterId,
      address,
      tag,
      session,
      c,
    });

    const provisioningStatus = await service.startInstance({
      instanceId: instance.id,
      session,
      c,
    });

    return c.json(
      createSuccessResponse(
        { instance, provisioningStatus },
        "Instance provisioning started",
      ),
      { status: 202 }
    );
  } catch (error) {
    console.error("Failed to create instance", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ 
      message: "Instance creation failed", 
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink 
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Update an instance 
instances.patch("/:instanceId", requireClusterOwner, async (c) => {
  try {
    const session = c.get("session")!;
    const instanceId = c.req.param("instanceId");
    const service = new InstanceService(c.env);
    const data = await c.req.json();

    const validation = updateInstanceSchema.safeParse(data);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({ 
        message: "Validation failed " + errors, 
        code: ERROR.REQUEST.BAD_REQUEST.code 
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { clusterId, address, publicKey, tag } = validation.data;

    const instance = await service.updateInstance({
      instanceId,
      clusterId,
      address,
      publicKey,
      tag,
      session,
      c,
    });

    c.executionCtx.waitUntil(
      service.startInstance({
        instanceId,
        session,
        c,
      }),
    );

    return c.json(
      createSuccessResponse(
        { instance },
        "Instance update provisioning started",
      ),
      { status: 202 }
    );
  } catch (error) {
    console.error("Failed to update instance", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({ 
      message: "Instance update failed", 
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

instances.post("/register", async (c) => {
  const body = await c.req.json();
  const validation = registerInstanceSchema.safeParse(body);
  if (!validation.success) {
    const errors = validation.error.issues.map((err) => ({
      field: err.path.join("."),
      message: err.message,
    }));
    return c.json(
      createErrorResponse({
        message: "Validation failed " + JSON.stringify(errors),
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const { token, publicKey } = validation.data;

  const service = new InstanceService(c.env);
  const result = await service.registerInstance({ token, publicKey });

  if (!result.ok) {
    if (result.reason === "invalid_token") {
      return c.json(createErrorResponse({ 
        message: "Invalid or expired token", 
        code: ERROR.AUTH.BAD_TOKEN.code 
      }), ERROR.AUTH.BAD_TOKEN.status);
    }

    if (result.reason === "invalid_type") {
      return c.json(createErrorResponse({ 
        message: "Invalid token type", 
        code: ERROR.AUTH.BAD_TOKEN.code 
      }), ERROR.AUTH.BAD_TOKEN.status);
    }

    return c.json(createErrorResponse({ 
      message: "Token already used", 
      code: ERROR.AUTH.BAD_TOKEN.code 
    }), ERROR.AUTH.BAD_TOKEN.status);
  }

  return c.json(createSuccessResponse({ 
    instanceId: result.instanceId,
    jwksUrl: result.jwksUrl,
  }));
});

export default instances;
