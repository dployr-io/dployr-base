import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { getCookie } from "hono/cookie";
import { D1Store } from "@/lib/db/store";
import { InstanceService } from "@/services/instances";
import z from "zod";
import { authMiddleware, requireClusterAdmin, requireClusterOwner } from "@/middleware/auth";
import { ERROR, EVENTS } from "@/lib/constants";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();
instances.use("*", authMiddleware);

const createInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().min(10, "Address with a minimum of 10 characters is required").max(16, "Address must be a maximum of 16 characters"),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters"),
  publicKey: z.string().min(1, "Public key is required").max(255, "Public key must be a maximum of 255 characters"),
});

const updateInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().min(10, "Address with a minimum of 10 characters is required").max(16, "Address must be a maximum of 16 characters" ).optional(),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters").optional(),
  publicKey: z.string().min(1, "Public key is required").max(255, "Public key must be a maximum of 255 characters").optional(),
});

// List all instances by cluster
instances.get("/", async (c) => {
  const sessionId = getCookie(c, "session");
  const clusterId = c.req.param("clusterId");

  if (!sessionId) {
    return c.json(createErrorResponse({ 
      message: "Not authenticated", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  if (!clusterId) {
    return c.json(createErrorResponse({ 
      message: "Cluster ID is required", 
      code: ERROR.REQUEST.BAD_REQUEST.code 
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json(createErrorResponse({ 
      message: "Invalid or expired session", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }), ERROR.AUTH.BAD_SESSION.status);
  }

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
    const sessionId = getCookie(c, "session");

    if (!sessionId) {
      return c.json(createErrorResponse({ 
        message: "Not authenticated", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);
    const service = new InstanceService(c.env);
    const session = await kv.getSession(sessionId);

    if (!session) {
      return c.json(createErrorResponse({ 
        message: "Invalid or expired session", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

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

    const { clusterId, address, publicKey, tag } = validation.data;

    const instance = await service.createInstance({
      clusterId,
      address,
      publicKey,
      tag,
      session,
      c,
    });

    const provisioningStatus = await service.startInstance({
      instanceId: instance.id,
      session,
      c,
    });

    // Connect to your Dployr instance
    // const { client, tokenManager } = createDployrClient(address);

    // // Login to get authentication tokens
    // const auth = await client.auth.request.post({
    //   email: session.email,
    //   secret: 
    // });

    // // Store tokens for authenticated requests
    // tokenManager.setTokens(auth?.accessToken || '', auth?.refreshToken || '');

    // // Now you can make authenticated API calls
    // const deployments = await client.deployments.get();
    // const services = await client.services.get();

    return c.json(
      createSuccessResponse(
        { instance, provisioningStatus },
        "Instance created successfully",
      ),
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
    const sessionId = getCookie(c, "session");
    const instanceId = c.req.param("instanceId");

    if (!sessionId) {
      return c.json(createErrorResponse({ 
        message: "Not authenticated", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

    const kv = new KVStore(c.env.BASE_KV);
    const d1 = new D1Store(c.env.BASE_DB);
    const service = new InstanceService(c.env);
    const session = await kv.getSession(sessionId);

    if (!session) {
      return c.json(createErrorResponse({ 
        message: "Invalid or expired session", 
        code: ERROR.AUTH.BAD_SESSION.code 
      }), ERROR.AUTH.BAD_SESSION.status);
    }

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
      clusterId,
      address,
      publicKey,
      tag,
      session,
      c,
    });

    const provisioningStatus = await service.startInstance({
      instanceId,
      session,
      c,
    });

    // Connect to your Dployr instance
    // const { client, tokenManager } = createDployrClient(address);

    // // Login to get authentication tokens
    // const auth = await client.auth.request.post({
    //   email: session.email,
    //   secret: 
    // });

    // // Store tokens for authenticated requests
    // tokenManager.setTokens(auth?.accessToken || '', auth?.refreshToken || '');

    // // Now you can make authenticated API calls
    // const deployments = await client.deployments.get();
    // const services = await client.services.get();

    return c.json(
      createSuccessResponse(
        { instance, provisioningStatus },
        "Instance created successfully",
      ),
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

// Get instance logs
instances.get("/:instanceId/logs", requireClusterAdmin, async (c) => {
  try {
    const instanceId = c.req.param("instanceId");

    const object = await c.env.INSTANCE_LOGS.get(`instance/${instanceId}.log`);

    if (!object) {
      return c.json(
        createErrorResponse({
          message: "Logs not found",
          code: ERROR.RESOURCE.MISSING_RESOURCE.code,
        }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }

    const text = await object.text();
    const logs = JSON.parse(text);

    return c.json(
      createSuccessResponse(logs, "Instance logs fetched successfully"),
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

export default instances;
