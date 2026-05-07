// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { ulid } from "ulid";
import { z } from "zod";
import type { Bindings, Variables } from "@/types/index.js";
import { requireClusterViewer, requireClusterDeveloper, authMiddleware } from "@/middleware/auth.js";
import { ERROR, SUCCESS } from "@/lib/constants/index.js";
import { getDbStore, getWS, getJWTService, getKVStore } from "@/lib/config/context.js";
import { createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { DployrdService } from "@/services/dployrd.js";
import { DeploymentPayload, DeploymentSchema } from "@/lib/tasks/types.js";
import { DatabaseConflictError } from "@/lib/errors/errors.js";
import { validateString } from "@/lib/validators/string-sanitizer.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Deployments");

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
      const kv = getKVStore(c);
      const pending = await kv.payloads.consumeDeploymentPayload({ clusterId: cluster.id, name: blueprint.name });
      const payload = pending?.payload;

      const synced = await db.deployments.upsert({
        clusterId: cluster.id,
        userId: blueprint.user_id,
        id,
        name: blueprint.name,
        type: blueprint.type ?? payload?.type,
        source: blueprint.source ?? payload?.source,
        description: blueprint.description ?? payload?.description,
        runCmd: blueprint.run_cmd ?? payload?.run_cmd,
        buildCmd: blueprint.build_cmd ?? payload?.build_cmd,
        port: blueprint.port ?? payload?.port,
        workingDir: blueprint.working_dir ?? payload?.working_dir,
        staticDir: blueprint.static_dir ?? payload?.static_dir,
        image: blueprint.image ?? payload?.image,
        domain: blueprint.domain ?? payload?.domain,
        runtimeType: blueprint.runtime_type ?? blueprint.runtime.type ?? payload?.runtime,
        runtimeVersion: blueprint.runtime_version ?? blueprint.runtime.version ?? payload?.version,
        remoteUrl: blueprint.remote_url ?? blueprint.remote.url ?? payload?.remote?.url,
        remoteBranch: blueprint.remote_branch ?? blueprint.remote?.branch ?? payload?.remote?.branch,
        remoteCommitHash: blueprint.remote_commit_hash ?? blueprint.remote?.commit_hash ?? payload?.remote?.commit_hash,
        logs,
      });

      if (synced && payload) {
        if (payload.env_vars && typeof payload.env_vars === "object") {
          await db.serviceEnvs.set({ deploymentId: synced.id, envs: payload.env_vars }).catch((error) => {
            log.error(`Failed to set envs for deployment ${synced.id}:`, error);
          });
        }

        if (payload.secrets && typeof payload.secrets === "object" && db.serviceSecrets) {
          await db.serviceSecrets.set({ deploymentId: synced.id, secrets: payload.secrets }).catch((error) => {
            log.error(`Failed to set secrets for deployment ${synced.id}:`, error);
          });
        }
      }
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
    log.error("Failed to finish deployment", error);
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
    const routingKey = instanceName;
    const kv = getKVStore(c);

    await kv.payloads.saveDeploymentPayload({ clusterId, instanceName, taskId, payload: deployPayload });

    let dispatched = false;
    try {
      dispatched = getWS(c).sendTask(routingKey, task);
    } catch (error) {
      log.error("Failed to dispatch deployment task:", error);
    }

    if (!dispatched) {
      log.warn(`No node available to dispatch deploy task ${taskId} for cluster ${clusterId}`);
      return c.json(createErrorResponse({ message: "No node connected to this cluster", code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code }), ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status);
    }

    log.info(`Dispatched deploy task ${taskId} for cluster ${clusterId}`);
    return c.json(createSuccessResponse({ deployPayload, taskId }), SUCCESS.ACCEPTED.status);
  } catch (error) {
    log.error("Unable to deploy task:", error);
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
