// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse, SystemStatus } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { InstanceService } from "@/services/instances";
import { InstanceConflictError } from "@/lib/db/store/instances";
import z from "zod";
import { requireClusterAdmin, requireClusterOwner, requireClusterViewer } from "@/middleware/auth";
import { ERROR, EVENTS } from "@/lib/constants";
import { authMiddleware } from "@/middleware/auth";
import { JWTService } from "@/services/jwt";
import { NotificationService } from "@/services/notifications";
import { ulid } from "ulid";

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

const rotateSchema = z.object({
  token: z.string().min(1, "Token is required")
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
      c.executionCtx.waitUntil(
        service.pingInstance({
          instanceId: instance.id,
          session,
          c,
        }),
      );
      
      return { ...instance };
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

    // Trigger notifications
    const notificationService = new NotificationService(c.env);
    c.executionCtx.waitUntil(
      notificationService.triggerEvent(EVENTS.INSTANCE.CREATED.code, {
        clusterId,
        instanceId: instance.id,
        userEmail: session.email,
      })
    );

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

    // Trigger notifications
    const notificationService = new NotificationService(c.env);
    c.executionCtx.waitUntil(
      notificationService.triggerEvent(EVENTS.INSTANCE.DELETED.code, {
        clusterId,
        instanceId,
        userEmail: session.email,
      })
    );

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

instances.post("/:instanceId/tokens/rotate", async (c) => {
  const instanceId = c.req.param("instanceId");
  const body = await c.req.json();
  const validation = rotateSchema.safeParse(body);
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

  const { token } = validation.data;

  const kv = new KVStore(c.env.BASE_KV);
  const d1 = new D1Store(c.env.BASE_DB);
  const jwtService = new JWTService(kv);

  let payload: any;
  try {
    payload = await jwtService.verifyTokenIgnoringExpiry(token);
  } catch {
    return c.json(
      createErrorResponse({
        message: "Invalid token signature",
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  if (payload.token_type !== "bootstrap" || payload.instance_id !== instanceId) {
    return c.json(
      createErrorResponse({
        message: "Invalid bootstrap token for instance",
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const nonce = payload.nonce as string | undefined;
  if (!nonce) {
    return c.json(
      createErrorResponse({
        message: "Invalid bootstrap token payload",
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const rotated = await jwtService.rotateBootstrapToken(instanceId, nonce, "5m");

  // update token in instance

  return c.json(createSuccessResponse({ token: rotated }), 200);
});

// Client WebSocket subscription for instance status/updates
instances.get("/:instanceId/stream", requireClusterViewer, async (c) => {
  const instanceId = c.req.param("instanceId");
  const clusterId = c.req.query("clusterId");

  if (!clusterId) {
    return c.json(createErrorResponse({
      message: "Cluster ID is required",
      code: ERROR.REQUEST.BAD_REQUEST.code,
    }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const d1 = new D1Store(c.env.BASE_DB);
  const instance = await d1.instances.get(instanceId);
  if (!instance || instance.clusterId !== clusterId) {
    return c.json(createErrorResponse({
      message: "Instance not found",
      code: ERROR.RESOURCE.MISSING_RESOURCE.code,
    }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const id = c.env.INSTANCE_OBJECT.idFromName(instanceId);
  const stub = c.env.INSTANCE_OBJECT.get(id);
  const upgradeReq = new Request(c.req.raw);

  return stub.fetch(upgradeReq);
});

// Stream logs from instance
instances.post("/:instanceId/logs/stream", requireClusterViewer, async (c) => {
  try {
    const instanceId = c.req.param("instanceId");
    const clusterId = c.req.query("clusterId");
    const session = c.get("session")!;

    if (!clusterId) {
      return c.json(createErrorResponse({
        message: "Cluster ID is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const body = await c.req.json();
    const logType = body?.logType as string | undefined;
    const streamId = body?.streamId as string | undefined;
    const mode = body?.mode as string | undefined || "tail";
    const startFrom = typeof body?.startFrom === "number" ? body.startFrom : -1;
    const limit = typeof body?.limit === "number" ? body.limit : 100;

    if (!logType || !streamId) {
      return c.json(createErrorResponse({
        message: "logType and streamId are required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    // Validate logType
    const validLogTypes = ["app", "install"];
    if (!validLogTypes.includes(logType)) {
      return c.json(createErrorResponse({
        message: `Invalid logType. Must be one of: ${validLogTypes.join(", ")}`,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    // Validate mode
    const validModes = ["tail", "historical"];
    if (!validModes.includes(mode)) {
      return c.json(createErrorResponse({
        message: `Invalid mode. Must be one of: ${validModes.join(", ")}`,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const d1 = new D1Store(c.env.BASE_DB);
    const instance = await d1.instances.get(instanceId);
    if (!instance || instance.clusterId !== clusterId) {
      return c.json(createErrorResponse({
        message: "Instance not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    const service = new InstanceService(c.env);
    const kv = new KVStore(c.env.BASE_KV);
    const token = await service.getOrCreateInstanceUserToken(kv, session, instanceId);

    // Create task to stream logs
    const id = c.env.INSTANCE_OBJECT.idFromName(instanceId);
    const stub = c.env.INSTANCE_OBJECT.get(id);
    await stub.fetch(`https://do/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: ulid(),
        type: "logs/stream:post",
        payload: { 
          token, 
          logType, 
          streamId,
          mode,
          startFrom,
          limit
        },
        createdAt: Date.now(),
      }),
    });

    return c.json(createSuccessResponse({ 
      streamId, 
      logType, 
      mode, 
      startFrom, 
      limit 
    }, "Log stream initiated"));
  } catch (error) {
    console.error("Failed to initiate log stream", error);
    return c.json(createErrorResponse({
      message: "Failed to initiate log stream",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default instances;
