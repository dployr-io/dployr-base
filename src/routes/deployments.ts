// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import type { Bindings, Variables } from "@/types/index.js";
import { requireClusterViewer, requireClusterDeveloper, authMiddleware } from "@/middleware/auth.js";
import { ERROR, SUCCESS } from "@/lib/constants/index.js";
import { getDbStore, getWS, getJWTService } from "@/lib/config/context.js";
import { createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { DployrdService } from "@/services/dployrd.js";
import { DeploymentPayload, DeploymentSchema } from "@/lib/tasks/types.js";
import { DatabaseConflictError } from "@/lib/errors/errors.js";
import { validateString } from "@/lib/validators/string-sanitizer.js";

const deployments = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const dployrdService = new DployrdService();

const finishDeploymentSchema = z.object({
  token: z.string().min(1, "Token is required"),
  id: z.ulid("Invalid deployment ID"),
  blueprint: z.record(z.string(), z.any()),
  userId: z.ulid(),
  logs: z.string().min(1, "Logs are required"),
});

// Finish deployment via token (called by dployrd to sync logs)
deployments.post("/finish", async (c) => {
  try {
    const body = await c.req.json();
    const validation = finishDeploymentSchema.safeParse(body);
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

    const { token, id, logs, userId, blueprint } = validation.data;
    const jwtService = getJWTService(c);
    const decoded = await jwtService.verifyToken(token);
    if (!decoded) {
      return c.json(
        createErrorResponse({
          message: "Invalid or expired token",
          code: ERROR.AUTH.BAD_TOKEN.code,
        }),
        ERROR.AUTH.BAD_TOKEN.status,
      );
    }

    const db = getDbStore(c);
    const deployment = await db.deployments.get(id);
    if (!deployment) {
      const cluster = await db.clusters.find({ userId });
      if (!cluster) {
        return c.json(
          createErrorResponse({
            message: "Cluster not found",
            code: ERROR.RESOURCE.MISSING_RESOURCE.code,
          }),
          ERROR.RESOURCE.MISSING_RESOURCE.status,
        );
      }

      await db.deployments.upsert({
        clusterId: cluster.id,
        userId: blueprint.user_id,
        id,
        name: blueprint.name,
        type: blueprint.type,
        source: blueprint.source,
        logs,
      });
    }

    // Update deployment logs
    const updated = await db.deployments.updateLogs(id, logs);
    if (!updated) {
      return c.json(
        createErrorResponse({
          message: "Failed to update deployment logs",
          code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
        }),
        ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
      );
    }

    return c.json(createSuccessResponse({ deployment: updated }));
  } catch (error) {
    // Service name conflict with another cluster
    if (error instanceof DatabaseConflictError && error.field === "name") {
      return c.json(
        createErrorResponse({
          message: `Service name is already in use by another cluster. Service names must be globally unique.`,
          code: ERROR.RESOURCE.CONFLICT.code,
        }),
        ERROR.RESOURCE.CONFLICT.status,
      );
    }
    console.error("[Deployments] Failed to finish deployment", error);
    return c.json(
      createErrorResponse({
        message: "Failed to update deployment logs",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

deployments.use("*", authMiddleware);
// Create a deployment — dispatch-and-return
deployments.post("/", requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const clusterId = c.req.query("clusterId")!;

  // Parse and validate request
  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json(createErrorResponse({ message: "Request body is required", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const { instanceName, payload } = body as { instanceName?: string; payload?: DeploymentPayload };
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

  // Validate deployment name
  const nameValidation = validateString(deployPayload.name, "name");
  if (!nameValidation.valid) {
    return c.json(createErrorResponse({ message: nameValidation.error || "This name is not allowed", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  // Create deployment record and set envs/secrets
  let deployment: any;
  try {
    deployment = await db.deployments.upsert({
      clusterId,
      userId: deployPayload.user_id,
      name: deployPayload.name,
      type: deployPayload.type,
      source: deployPayload.source,
      description: deployPayload.description,
      runCmd: deployPayload.run_cmd,
      buildCmd: deployPayload.build_cmd,
      port: deployPayload.port,
      workingDir: deployPayload.working_dir,
      staticDir: deployPayload.static_dir,
      image: deployPayload.image,
      domain: deployPayload.domain,
      runtimeType: deployPayload.runtime,
      runtimeVersion: deployPayload.version,
      remoteUrl: deployPayload.remote?.url,
      remoteBranch: deployPayload.remote?.branch,
      remoteCommitHash: deployPayload.remote?.commit_hash,
    });

    if (deployment) {
      if (deployPayload.env_vars && typeof deployPayload.env_vars === "object") {
        await db.serviceEnvs.set({ deploymentId: deployment.id, envs: deployPayload.env_vars }).catch((error) => {
          console.error(`[Deployments] Failed to set envs for deployment ${deployment.id}:`, error);
        });
      }

      if (deployPayload.secrets && typeof deployPayload.secrets === "object" && db.serviceSecrets) {
        await db.serviceSecrets.set({ deploymentId: deployment.id, secrets: deployPayload.secrets }).catch((error) => {
          console.error(`[Deployments] Failed to set secrets for deployment ${deployment.id}:`, error);
        });
      }
    }
  } catch (error) {
    if (error instanceof DatabaseConflictError && error.field === "name") {
      return c.json(
        createErrorResponse({
          message: `Service name '${deployPayload.name}' is already in use by another cluster. Service names must be globally unique.`,
          code: ERROR.RESOURCE.CONFLICT.code,
        }),
        ERROR.RESOURCE.CONFLICT.status,
      );
    }
    throw error;
  }

  // Dispatch task to instance
  try {
    const instance = await db.instances.find({ tag: instanceName });
    if (!instance) {
      return c.json(createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    const taskId = ulid();
    const jwtService = getJWTService(c);
    const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
    const task = dployrdService.createDeployTask(taskId, deployPayload, token);
    const routingKey = instance.kind === "pool" ? `pool:${instanceName}` : instanceName;

    let dispatched = false;
    try {
      dispatched = getWS(c).sendTask(routingKey, task);
    } catch (error) {
      console.error("[Deployments] Failed to dispatch deployment task:", error);
    }

    if (!dispatched) {
      console.warn(`[Deployments] No node available to dispatch deploy task ${taskId} for cluster ${clusterId}`);
      return c.json(createErrorResponse({ message: "No node connected to this cluster", code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code }), ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status);
    }

    console.log(`[Deployments] Dispatched deploy task ${taskId} for cluster ${clusterId}`);
    return c.json(createSuccessResponse({ deployPayload, taskId }), SUCCESS.ACCEPTED.status);
  } catch (error) {
    console.error("[Deployments] Unable to deploy task:", error);
    return c.json(createErrorResponse({ message: "Failed to create deployment", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// List deployments for a cluster
deployments.get("/", requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.req.query("clusterId")!;
  const serviceId = c.req.query("serviceId");
  const status = c.req.query("status") as any;
  const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));

  const { deployments, total } = await db.deployments.list({ clusterId, serviceId, status, limit: pageSize, offset });
  const paginatedData = createPaginatedResponse(deployments, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

// Get single deployment by ID
deployments.get("/:id", requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.req.query("clusterId")!;
  const id = c.req.param("id");

  const deployment = await db.deployments.get(id);
  if (!deployment || deployment.clusterId !== clusterId) {
    return c.json(createErrorResponse({ message: "Deployment not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  return c.json(createSuccessResponse({ deployment }));
});

// Delete a deployment record
deployments.delete("/:id", requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.req.query("clusterId")!;
  const id = c.req.param("id");

  const deployment = await db.deployments.get(id);
  if (!deployment || deployment.clusterId !== clusterId) {
    return c.json(createErrorResponse({ message: "Deployment not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  if (deployment.status === "running") {
    return c.json(createErrorResponse({ message: "Cannot delete a running deployment", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  await db.deployments.delete({ id });
  return c.json(createSuccessResponse({}));
});

export default deployments;
