// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { ulid } from "ulid";
import z from "zod";
import type { Bindings, Variables } from "@/types/index.js";
import { resolveCluster, requireClusterViewer, requireClusterDeveloper, authMiddleware } from "@/middleware/auth.js";
import { ERROR } from "@/lib/constants/index.js";
import { getDbStore, getWS, getJWTService, getKVStore, getTraefikRouterService } from "@/lib/config/context.js";
import { createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { DployrdService } from "@/services/dployrd.js";
import { enqueueBuild, computeBuildFingerprint, resolveRemoteAuthUrl } from "@/services/deployments.js";
import { InstanceNotConnectedError } from "@/lib/errors/errors.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Services");

const services = new Hono<{ Bindings: Bindings; Variables: Variables }>();
const dployrdService = new DployrdService();

const patchServiceSchema = z.object({
  instanceName: z.string().min(1),
  env_vars: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  keep_secret_keys: z.array(z.string()).optional().default([]),
  description: z.string().nullish(),
  run_cmd: z.string().nullish(),
  build_cmd: z.string().nullish(),
  port: z.number().int().positive().nullish(),
  working_dir: z.string().nullish(),
  static_dir: z.string().nullish(),
  image: z.string().nullish(),
  domain: z.string().nullish(),
  runtime: z.string().nullish(),
  version: z.string().nullish(),
  remote_url: z.string().nullish(),
  remote_branch: z.string().nullish(),
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

  const { instanceName, env_vars, secrets, keep_secret_keys, ...fields } = validation.data;

  // Load the service and its latest deployment in parallel
  const service = await db.services.find({ id: serviceId });
  if (!service) {
    return c.json(createErrorResponse({ message: "Service not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const [existing, instance] = await Promise.all([service.deploymentId ? db.deployments.get(service.deploymentId) : Promise.resolve(null), db.instances.find({ tag: instanceName })]);

  if (!instance) {
    return c.json(createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  try {
    // Persist env var changes (full atomic replace, also clears deployment-linked rows)
    if (env_vars !== undefined) {
      await db.serviceEnvs.replace({ serviceId, deploymentId: service.deploymentId ?? undefined, envs: env_vars });
    }

    // Persist secret changes (selective atomic replace, also clears deployment-linked rows)
    if (secrets !== undefined || keep_secret_keys.length > 0) {
      if (db.serviceSecrets) {
        await db.serviceSecrets.replaceSelective({
          serviceId,
          deploymentId: service.deploymentId ?? undefined,
          newSecrets: secrets ?? {},
          keepKeys: keep_secret_keys,
        });
      }
    }

    // Merge fields with existing deployment values
    // undefined in the request = keep existing value; null = explicitly clear it
    const pick = <T>(incoming: T | null | undefined, fallback: T | null | undefined): T | undefined => (incoming !== undefined ? (incoming ?? undefined) : (fallback ?? undefined));

    // When the request explicitly provides remote_url, the intent is a fresh rebuild —
    // clear any image that was cached from a previous build so the routing logic and
    // DB record both reflect "remote" consistently.
    const explicitRemote = fields.remote_url !== undefined;

    const merged = {
      description: pick(fields.description, existing?.description),
      runCmd: pick(fields.run_cmd, existing?.runCmd),
      buildCmd: pick(fields.build_cmd, existing?.buildCmd),
      port: pick(fields.port, existing?.port),
      workingDir: pick(fields.working_dir, existing?.workingDir),
      staticDir: pick(fields.static_dir, existing?.staticDir),
      image: explicitRemote ? undefined : pick(fields.image, existing?.image),
      domain: pick(fields.domain, existing?.domain),
      runtimeType: pick(fields.runtime, existing?.runtimeType),
      runtimeVersion: pick(fields.version, existing?.runtimeVersion),
      remoteUrl: pick(fields.remote_url, existing?.remoteUrl),
      remoteBranch: pick(fields.remote_branch, existing?.remoteBranch),
    };

    // source follows the content: explicit remote_url always means "remote" (rebuild);
    // if only image is set use "image"; if only remote_url is set use "remote";
    // otherwise preserve whatever was on the existing deployment.
    const source = explicitRemote ? "remote" : merged.image && !merged.remoteUrl ? "image" : merged.remoteUrl && !merged.image ? "remote" : (existing?.source ?? "remote");

    if (!existing) {
      return c.json(createErrorResponse({ message: "Service has no deployment record", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    // Persist config changes
    const deployment = await db.deployments.patchConfig({
      name: service.name,
      source,
      description: merged.description,
      runCmd: merged.runCmd,
      buildCmd: merged.buildCmd,
      port: merged.port,
      workingDir: merged.workingDir,
      staticDir: merged.staticDir,
      image: merged.image,
      domain: merged.domain,
      runtimeType: merged.runtimeType,
      runtimeVersion: merged.runtimeVersion,
      remoteUrl: merged.remoteUrl,
      remoteBranch: merged.remoteBranch,
    });

    if (!deployment) {
      return c.json(createErrorResponse({ message: "Failed to patch deployment record", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    // Read current env vars and secrets for the dispatch payload.
    // Both use serviceName so deployment-linked rows (from initial deploy) are included via JOIN.
    const [envList, allSecretKeys] = await Promise.all([
      db.serviceEnvs.list({ serviceId, serviceName: service.name }),
      db.serviceSecrets ? db.serviceSecrets.list({ serviceId, serviceName: service.name }).then((r) => r.map((s: any) => s.key)) : Promise.resolve([] as string[]),
    ]);

    const currentEnvs: Record<string, string> = Object.fromEntries(envList.map((e: any) => [e.key, e.value]));
    const { values: currentSecrets } =
      allSecretKeys.length > 0 && db.serviceSecrets ? await db.serviceSecrets.getDecrypted({ serviceId, keys: allSecretKeys }) : { values: {} as Record<string, string> };

    // Build and dispatch the deploy task
    const deployPayload = {
      name: service.name,
      user_id: session.userId,
      type: service.type,
      source: deployment.source,
      description: deployment.description ?? undefined,
      runtime: deployment.runtimeType ?? undefined,
      version: deployment.runtimeVersion ?? undefined,
      run_cmd: deployment.runCmd ?? undefined,
      build_cmd: deployment.buildCmd ?? undefined,
      port: deployment.port ?? undefined,
      working_dir: deployment.workingDir && !deployment.workingDir.startsWith("/") ? deployment.workingDir : undefined,
      static_dir: deployment.staticDir ?? undefined,
      image: deployment.image ?? undefined,
      domain: deployment.domain ?? undefined,
      env_vars: Object.keys(currentEnvs).length > 0 ? currentEnvs : undefined,
      secrets: Object.keys(currentSecrets).length > 0 ? currentSecrets : undefined,
      remote: deployment.remoteUrl ? { url: deployment.remoteUrl, branch: deployment.remoteBranch, commit_hash: deployment.remoteCommitHash } : undefined,
    };

    const jwtService = getJWTService(c);
    const kv = getKVStore(c);
    let taskId: string;

    if (deployPayload.source === "remote" && deployPayload.remote?.url) {
      // source=remote: inject fresh git credentials and route through the build node.
      // The build node clones + builds the image, then callbacks to the instance node to deploy.
      const authUrl = await resolveRemoteAuthUrl(deployPayload.remote.url, clusterId, db, c.env);
      const authedPayload = { ...deployPayload, remote: { ...deployPayload.remote, url: authUrl }, force_rebuild: false } as any;
      const fingerprint = await computeBuildFingerprint(authedPayload);
      try {
        const result = await enqueueBuild({
          db,
          kv,
          clusterId,
          instanceName,
          deployPayload: authedPayload,
          fingerprint,
          jwtService,
          ws: getWS(c),
          issuer: c.env.BASE_URL,
        });
        taskId = result.taskId;
      } catch (err) {
        if (err instanceof InstanceNotConnectedError) {
          return c.json(createErrorResponse({ message: "No build node available", code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code }), ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status);
        }
        throw err;
      }
    } else {
      // source=image: deploy directly to the instance node.
      taskId = ulid();
      const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
      const task = dployrdService.createDeployTask(taskId, deployPayload as any, token);
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
    }

    log.info(`Dispatched update task ${taskId!} for service ${service.name} in cluster ${clusterId}`);
    return c.json(createSuccessResponse({ service, deployment, taskId: taskId! }));
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

// Stop service — sends a sleep task to the node daemon
services.post("/:id/stop", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const serviceId = c.get("resolvedServiceId")!;
  const clusterId = c.get("resolvedClusterId")!;

  const service = await db.services.find({ id: serviceId });
  if (!service) {
    return c.json(createErrorResponse({ message: "Service not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const instance = await db.instances.find({ clusterId, kind: "dedicated" });
  if (!instance) {
    return c.json(createErrorResponse({ message: "No node connected to this cluster", code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code }), ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status);
  }

  try {
    const jwtService = getJWTService(c);
    const token = await jwtService.createInstanceAccessToken(session, instance.tag, clusterId);
    const taskId = ulid();
    const task = dployrdService.createServiceSleepTask(taskId, service.name, token);
    const routingKey = await db.instances.getRoutingKey(clusterId);
    getWS(c).sendTask(routingKey, task);
    log.info(`Dispatched stop task ${taskId} for service ${service.name}`);
    return c.json(createSuccessResponse({ taskId }));
  } catch (error) {
    log.error("Failed to stop service:", error);
    return c.json(createErrorResponse({ message: "Failed to stop service", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Start (wake) a stopped service
services.post("/:id/start", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const serviceId = c.get("resolvedServiceId")!;
  const clusterId = c.get("resolvedClusterId")!;

  const service = await db.services.find({ id: serviceId });
  if (!service) {
    return c.json(createErrorResponse({ message: "Service not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const instance = await db.instances.find({ clusterId, kind: "dedicated" });
  if (!instance) {
    return c.json(createErrorResponse({ message: "No node connected to this cluster", code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code }), ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status);
  }

  try {
    const jwtService = getJWTService(c);
    const token = await jwtService.createInstanceAccessToken(session, instance.tag, clusterId);
    const taskId = ulid();
    const task = dployrdService.createServiceWakeTask(taskId, service.name, token);
    const routingKey = await db.instances.getRoutingKey(clusterId);
    getWS(c).sendTask(routingKey, task);
    log.info(`Dispatched start task ${taskId} for service ${service.name}`);
    return c.json(createSuccessResponse({ taskId }));
  } catch (error) {
    log.error("Failed to start service:", error);
    return c.json(createErrorResponse({ message: "Failed to start service", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

services.get("/:id/envs", resolveCluster("service", { path: "id" }), requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;

  const service = await db.services.find({ id: serviceId });
  const envList = await db.serviceEnvs.list({ serviceId, serviceName: service?.name ?? null });
  const envs = Object.fromEntries(envList.map((e) => [e.key, e.value]));
  return c.json(createSuccessResponse({ envs }));
});

// Read secret keys/metadata (values are never returned — edits go through PATCH /:id)
services.get("/:id/secrets", resolveCluster("service", { path: "id" }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const serviceId = c.get("resolvedServiceId")!;

  if (!db.serviceSecrets) {
    return c.json(createErrorResponse({ message: "Secrets not configured on this server", code: ERROR.REQUEST.BAD_REQUEST.code }), 503);
  }

  const service = await db.services.find({ id: serviceId });
  const secrets = await db.serviceSecrets.list({ serviceId, serviceName: service?.name ?? null });
  return c.json(createSuccessResponse({ secrets }));
});

services.get("/metrics/:name", authMiddleware, requireClusterViewer, async (c) => {
  const db = getDbStore(c);
  const name = c.req.param("name");

  const now = Date.now();
  const from = parseInt(c.req.query("from") ?? String(now - 24 * 60 * 60 * 1000), 10);
  const to = parseInt(c.req.query("to") ?? String(now), 10);

  const [buckets, totals] = await Promise.all([db.serviceMetrics.list(name, from, to), db.serviceMetrics.totals(name, from, to)]);

  return c.json(createSuccessResponse({ buckets, totals }));
});

export default services;
