// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse, SystemStatus } from "@/types/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { DployrdService } from "@/services/dployrd-service.js";
import { InstanceService } from "@/services/instances.js";
import { InstanceConflictError } from "@/lib/db/store/instances.js";
import z from "zod";
import { requireClusterAdmin, requireClusterOwner, requireClusterViewer } from "@/middleware/auth.js";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { authMiddleware } from "@/middleware/auth.js";
import { JWTService } from "@/services/jwt.js";
import { NotificationService } from "@/services/notifications.js";
import { ulid } from "ulid";
import { getKV, getDB, runBackground, getWS, type AppVariables } from "@/lib/context.js";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();
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

  const db = new DatabaseStore(getDB(c) as any);
  const kv = new KVStore(getKV(c));
  const service = new InstanceService(c.env);
  const session = c.get("session")!;

  const { page, pageSize, offset } = parsePaginationParams(
    c.req.query("page"),
    c.req.query("pageSize")
  );

  const { instances: _instances, total } = await db.instances.getByCluster(
    clusterId,
    pageSize,
    offset
  );

  const instances = await Promise.all(
    _instances.map(async (instance: any) => {
      runBackground(
        service.pingInstance({
          instanceId: instance.id,
          session,
          c,
        })
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
    const kv = new KVStore(getKV(c));
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
    const db = new DatabaseStore(getDB(c) as any);
    runBackground(
      notificationService.triggerEvent(EVENTS.INSTANCE.CREATED.code, {
        clusterId,
        instanceId: instance.id,
        userEmail: session.email,
      }, db)
    );

    runBackground(
      service.pingInstance({
        instanceId: instance.id,
        session,
        c,
      })
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

    const helpLink = "https://monitoring.dployr.io";
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

    const db = new DatabaseStore(getDB(c) as any);
    const kv = new KVStore(getKV(c));
    const instance = await db.instances.get(instanceId);

    if (!instance) {
      return c.json(
        createErrorResponse({
          message: "Instance not found",
          code: ERROR.RESOURCE.MISSING_RESOURCE.code,
        }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }

    if (instance.clusterId !== clusterId) {
      return c.json(createErrorResponse({
        message: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.message,
        code: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.code,
      }), ERROR.PERMISSION.OWNER_ROLE_REQUIRED.status);
    }

    await db.instances.delete(instanceId);

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
    runBackground(
      notificationService.triggerEvent(EVENTS.INSTANCE.DELETED.code, {
        clusterId,
        instanceId,
        userEmail: session.email,
      }, db)
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

  const kv = new KVStore(getKV(c));
  const db = new DatabaseStore(getDB(c) as any);
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

// System install - triggers dployrd install.sh with optional version
instances.post("/:instanceId/system/install", requireClusterOwner, async (c) => {
  try {
    const instanceId = c.req.param("instanceId");
    const clusterId = c.req.query("clusterId");

    if (!clusterId) {
      return c.json(createErrorResponse({
        message: "Cluster ID is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const db = new DatabaseStore(getDB(c) as any);
    const instance = await db.instances.get(instanceId);
    if (!instance) {
      return c.json(createErrorResponse({
        message: "Instance not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    if (instance.clusterId !== clusterId) {
      return c.json(createErrorResponse({
        message: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.message,
        code: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.code,
      }), ERROR.PERMISSION.OWNER_ROLE_REQUIRED.status);
    }

    let version: string | undefined;
    try {
      const body = await c.req.json();
      version = typeof body?.version === "string" ? body.version : undefined;
    } catch {
      // Empty body is valid - will install latest
    }

    const ws = getWS(c);
    if (!ws.hasAgentConnection(instanceId)) {
      return c.json(createErrorResponse({
        message: "Agent not connected",
        code: ERROR.RUNTIME.AGENT_NOT_CONNECTED.code,
      }), ERROR.RUNTIME.AGENT_NOT_CONNECTED.status);
    }

    const kv = new KVStore(getKV(c));
    const jwtService = new JWTService(kv);

    const taskId = ulid();
    const dployrd = new DployrdService();
    const token = await jwtService.createAgentAccessToken(instanceId, {
      issuer: c.env.BASE_URL,
      audience: "dployr-instance",
    });
    const task = dployrd.createSystemInstallTask(taskId, version, token);

    const sent = ws.sendTaskToAgent(instanceId, task);
    if (!sent) {
      return c.json(createErrorResponse({
        message: "Failed to send install task to agent",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
    }

    return c.json(createSuccessResponse({
      status: "accepted",
      taskId,
      message: version
        ? `Install task sent for version ${version}`
        : "Install task sent for latest version",
    }), 202);
  } catch (error) {
    console.error("Failed to send system install task", error);
    return c.json(createErrorResponse({
      message: "Failed to send system install task",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// System restart - triggers OS reboot via dployrd
instances.post("/:instanceId/system/restart", requireClusterAdmin, async (c) => {
  try {
    const instanceId = c.req.param("instanceId");
    const clusterId = c.req.query("clusterId");

    if (!clusterId) {
      return c.json(createErrorResponse({
        message: "Cluster ID is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const db = new DatabaseStore(getDB(c) as any);
    const instance = await db.instances.get(instanceId);

    if (!instance) {
      return c.json(createErrorResponse({
        message: "Instance not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    if (instance.clusterId !== clusterId) {
      return c.json(createErrorResponse({
        message: ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.message,
        code: ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.code,
      }), ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.status);
    }

    let force = false;
    try {
      const body = await c.req.json();
      force = body?.force === true;
    } catch {
      // Empty body is valid - force defaults to false
    }

    const ws = getWS(c);
    if (!ws.hasAgentConnection(instanceId)) {
      return c.json(createErrorResponse({
        message: "Agent not connected",
        code: ERROR.RUNTIME.AGENT_NOT_CONNECTED.code,
      }), ERROR.RUNTIME.AGENT_NOT_CONNECTED.status);
    }

    const kv = new KVStore(getKV(c));
    const jwtService = new JWTService(kv);

    const taskId = ulid();
    const dployrd = new DployrdService();
    const token = await jwtService.createAgentAccessToken(instanceId, {
      issuer: c.env.BASE_URL,
      audience: "dployr-instance",
    });
    const task = dployrd.createSystemRestartTask(taskId, force, token);

    const sent = ws.sendTaskToAgent(instanceId, task);
    if (!sent) {
      return c.json(createErrorResponse({
        message: "Failed to send restart task to agent",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
    }

    return c.json(createSuccessResponse({
      status: "accepted",
      taskId,
      message: force
        ? "Restart task sent (force mode - bypassing pending tasks check)"
        : "Restart task sent (will wait for pending tasks to complete)",
    }), 202);
  } catch (error) {
    console.error("Failed to send system restart task", error);
    return c.json(createErrorResponse({
      message: "Failed to send system restart task",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default instances;
