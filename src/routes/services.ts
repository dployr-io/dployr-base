// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { ulid } from "ulid";
import z from "zod";
import type { Bindings, Variables } from "@/types/index.js";
import { resolveCluster, requireClusterViewer, requireClusterDeveloper, authMiddleware } from "@/middleware/auth.js";
import { ERROR } from "@/lib/constants/index.js";
import { getDbStore, getWS, getJWTService, getTraefikRouterService } from "@/lib/config/context.js";
import { createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { DployrdService } from "@/services/dployrd.js";
import { DeploymentSchema } from "@/lib/tasks/types.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Services");

const services = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const dployrdService = new DployrdService();

const envsSchema = z.object({
  envs: z.record(z.string(), z.string()),
});

const secretsSchema = z.object({
  secrets: z.record(z.string(), z.string()),
});

const patchServiceSchema = z.object({
  instanceName: z.string().min(1),
  payload: DeploymentSchema,
});

function validationError(c: any, error: z.ZodError) {
  const errors = error.issues.map((e) => ({ field: e.path.join("."), message: e.message }));
  return c.json(
    createErrorResponse({ message: "Validation failed: " + errors.map((e) => `${e.field}: ${e.message}`).join(", "), code: ERROR.REQUEST.BAD_REQUEST.code }),
    ERROR.REQUEST.BAD_REQUEST.status,
  );
}

services.use("*", authMiddleware);

services.get("/", requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const clusterId = c.get("resolvedClusterId")!;
  const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));

  const { services: list, total } = await db.services.list({ clusterId, limit: pageSize, offset });
  const paginatedData = createPaginatedResponse(list, page, pageSize, total);

  return c.json(createSuccessResponse(paginatedData));
});

services.get("/:id", resolveCluster("service", { path: "id" }), requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;

  const service = await db.services.find({ id: serviceId });
  return c.json(createSuccessResponse({ service }));
});

services.patch("/:id", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const serviceId = c.get("resolvedServiceId")!;
  const clusterId = c.get("resolvedClusterId")!;

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json(createErrorResponse({ message: "Request body is required", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const validation = patchServiceSchema.safeParse(body);
  if (!validation.success) return validationError(c, validation.error);

  const { instanceName, payload: deployPayload } = validation.data;

  const service = await db.services.find({ id: serviceId });
  if (!service) {
    return c.json(createErrorResponse({ message: "Service not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  if (service.type !== deployPayload.type) {
    return c.json(
      createErrorResponse({ message: `Runtime mismatch: service is '${service.type}', incoming is '${deployPayload.type}'. Undeploy previous service first.`, code: ERROR.RESOURCE.CONFLICT.code }),
      ERROR.RESOURCE.CONFLICT.status,
    );
  }

  const instance = await db.instances.find({ tag: instanceName });
  if (!instance) {
    return c.json(createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  try {
    // Merge envs and secrets (upsert only — existing keys not in the payload are untouched)
    if (deployPayload.env_vars && Object.keys(deployPayload.env_vars).length > 0) {
      await db.serviceEnvs.set({ serviceId, envs: deployPayload.env_vars });
    }
    if (deployPayload.secrets && Object.keys(deployPayload.secrets).length > 0 && db.serviceSecrets) {
      await db.serviceSecrets.set({ serviceId, secrets: deployPayload.secrets });
    }

    const deployment = await db.deployments.upsert({
      clusterId,
      userId: deployPayload.user_id,
      name: service.name,
      type: service.type,
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
      return c.json(createErrorResponse({ message: "No node connected to this cluster", code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code }), ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status);
    }

    log.info(`Dispatched update task ${taskId} for service ${service.name} in cluster ${clusterId}`);
    return c.json(createSuccessResponse({ service, deployment, taskId }));
  } catch (error) {
    log.error("Failed to update service:", error);
    return c.json(createErrorResponse({ message: "Failed to update service", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Delete service — dispatches remove task to node, then removes from DB.
services.delete("/:id", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const traefik = getTraefikRouterService(c);
  const session = c.get("session")!;
  const serviceId = c.get("resolvedServiceId")!;
  const clusterId = c.get("resolvedClusterId")!;

  const service = await db.services.find({ id: serviceId });
  if (!service) {
    return c.json(createErrorResponse({ message: "Service not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), 404);
  }

  const instance = await db.instances.find({ clusterId, kind: "dedicated" });

  if (instance) {
    try {
      const jwtService = getJWTService(c);
      const token = await jwtService.createInstanceAccessToken(session, instance.tag, clusterId);
      const taskId = ulid();
      const task = dployrdService.createServiceRemoveTask(taskId, service.name, token);
      const routingKey = await db.instances.getRoutingKey(clusterId);
      getWS(c).sendTask(routingKey, task);
    } catch {
      // Fire-and-forget — proceed with DB deletion regardless
    }
  }

  // Unregister the route from Traefik
  if (traefik) {
    try {
      await traefik.unregisterRoute(service.name);
      log.info(`Unregistered Traefik route for service ${service.name}`);
    } catch (err) {
      log.error(`Failed to unregister Traefik route for ${service.name}:`, err);
    }
  }

  await db.services.delete({ id: serviceId });
  return c.json(createSuccessResponse({}));
});

services.get("/:id/envs", resolveCluster("service", { path: "id" }), requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;

  const envs = await db.serviceEnvs.list({ serviceId });
  return c.json(createSuccessResponse({ envs }));
});

services.put("/:id/envs", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;

  const body = await c.req.json();
  const validation = envsSchema.safeParse(body);
  if (!validation.success) return validationError(c, validation.error);

  await db.serviceEnvs.set({ serviceId, envs: validation.data.envs });
  return c.json(createSuccessResponse({}));
});

services.delete("/:id/envs/:key", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;
  const key = c.req.param("key");

  await db.serviceEnvs.delete({ serviceId, key });
  return c.json(createSuccessResponse({}));
});

services.get("/:id/secrets", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;

  if (!db.serviceSecrets) {
    return c.json(createErrorResponse({ message: "Secrets not configured on this server", code: ERROR.REQUEST.BAD_REQUEST.code }), 503);
  }

  const secrets = await db.serviceSecrets.list({ serviceId });
  return c.json(createSuccessResponse({ secrets }));
});

services.put("/:id/secrets", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;

  if (!db.serviceSecrets) {
    return c.json(createErrorResponse({ message: "Secrets not configured on this server", code: ERROR.REQUEST.BAD_REQUEST.code }), 503);
  }

  const body = await c.req.json();
  const validation = secretsSchema.safeParse(body);
  if (!validation.success) return validationError(c, validation.error);

  await db.serviceSecrets.set({ serviceId, secrets: validation.data.secrets });
  return c.json(createSuccessResponse({}));
});

services.delete("/:id/secrets/:key", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;
  const key = c.req.param("key");

  if (!db.serviceSecrets) {
    return c.json(createErrorResponse({ message: "Secrets not configured on this server", code: ERROR.REQUEST.BAD_REQUEST.code }), 503);
  }

  await db.serviceSecrets.delete({ serviceId, key });
  return c.json(createSuccessResponse({}));
});

export default services;
