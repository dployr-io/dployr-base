// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { ulid } from "ulid";
import type { Bindings, Variables } from "@/types/index.js";
import { requireClusterViewer, requireClusterDeveloper, authMiddleware, resolveCluster } from "@/middleware/auth.js";
import { ERROR } from "@/lib/constants/index.js";
import { getDbStore, getWS, getJWTService } from "@/lib/config/context.js";
import { createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { DployrdService } from "@/services/dployrd.js";
import { DeploymentSchema } from "@/lib/tasks/types.js";

const deployments = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const dployrdService = new DployrdService();

deployments.use("*", authMiddleware);
// Create a deployment — fire-and-return. Client polls GET /v1/deployments/:id
// or listens for { kind: "refresh", entity: "deployments" } on WS.
deployments.post("/", requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const clusterId = c.get("resolvedClusterId")!;

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json(createErrorResponse({ message: "Request body is required", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const { instanceName, payload } = body as { instanceName?: string; payload?: unknown };
  if (!instanceName || !payload) {
    return c.json(createErrorResponse({ message: "instanceName and payload are required", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const validation = DeploymentSchema.safeParse(payload);
  if (!validation.success) {
    const errors = validation.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }));
    return c.json(
      createErrorResponse({ message: "Validation failed: " + errors.map((e) => `${e.field}: ${e.message}`).join(", "), code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const deployPayload = validation.data;

  try {
    const existing = await db.services.find({ name: deployPayload.name, clusterId });
    if (existing) {
      if (existing.type !== deployPayload.type) {
        return c.json(
          createErrorResponse({ message: `Service '${deployPayload.name}' already exists as type '${existing.type}'. Undeploy it before deploying a different type.`, code: ERROR.RESOURCE.CONFLICT.code }),
          ERROR.RESOURCE.CONFLICT.status,
        );
      }
      return c.json(
        createErrorResponse({ message: `Service '${deployPayload.name}' is already deployed. Use PATCH /v1/services/:id to update it.`, code: ERROR.RESOURCE.CONFLICT.code }),
        ERROR.RESOURCE.CONFLICT.status,
      );
    }

    const instance = await db.instances.find({ tag: instanceName });
    if (!instance) {
      return c.json(createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    const deployment = await db.deployments.upsert({
      clusterId,
      name: deployPayload.name,
      type: deployPayload.type,
      source: deployPayload.source,
      blueprint: deployPayload,
    });

    if (!deployment) {
      return c.json(createErrorResponse({ message: "Failed to create deployment record", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const jwtService = getJWTService(c);
    const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
    const taskId = ulid();
    const task = dployrdService.createDeployTask(taskId, deployPayload, token);
    const routingKey = await db.instances.getRoutingKey(clusterId);

    let dispatched = false;
    try {
      dispatched = getWS(c).sendTask(routingKey, task);
    } catch {
      // WS handler unavailable
    }

    if (!dispatched) {
      console.warn(`[Deployments] No node available to dispatch deploy task ${taskId} for cluster ${clusterId}`);
      return c.json(createErrorResponse({ message: "No node connected to this cluster", code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code }), ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status);
    }

    console.log(`[Deployments] Dispatched deploy task ${taskId} for cluster ${clusterId}`);
    return c.json(createSuccessResponse({ deployment, taskId }), 201);
  } catch (error) {
    console.error("[Deployments] Unable to deploy task: ", error);
    return c.json(createErrorResponse({ message: "Failed to create deployment", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// List deployments for a cluster — optional ?serviceId and ?status filters
deployments.get("/", requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.get("resolvedClusterId")!;
  const serviceId = c.req.query("serviceId");
  const status = c.req.query("status") as any;

  const list = await db.deployments.list({ clusterId, serviceId, status });
  return c.json(createSuccessResponse({ deployments: list }));
});

// Get single deployment by ID — cluster ownership enforced post-fetch
deployments.get("/:id", resolveCluster('deployment', { path: 'id' }), requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.get("resolvedClusterId")!;
  const id = c.req.param("id");

  const deployment = await db.deployments.get(id);
  if (!deployment || deployment.clusterId !== clusterId) {
    return c.json(createErrorResponse({ message: "Deployment not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), 404);
  }

  return c.json(createSuccessResponse({ deployment }));
});

// Delete a deployment record — running deployments cannot be deleted
deployments.delete("/:id", resolveCluster('deployment', { path: 'id' }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.get("resolvedClusterId")!;
  const id = c.req.param("id");

  const deployment = await db.deployments.get(id);
  if (!deployment || deployment.clusterId !== clusterId) {
    return c.json(createErrorResponse({ message: "Deployment not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), 404);
  }

  if (deployment.status === "running") {
    return c.json(createErrorResponse({ message: "Cannot delete a running deployment", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  await db.deployments.delete({ id });
  return c.json(createSuccessResponse({}));
});

export default deployments;
