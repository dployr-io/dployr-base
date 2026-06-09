// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";
import type { Bindings, Variables } from "@/types/index.js";
import { requireClusterViewer, requireClusterDeveloper, authMiddleware } from "@/middleware/auth.js";
import { ERROR, SUCCESS } from "@/lib/constants/index.js";
import { getJWTService, getDbStore } from "@/lib/config/context.js";
import { createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { DeploymentSchema } from "@/lib/tasks/types.js";
import { DatabaseConflictError, handleInstanceError } from "@/lib/errors/errors.js";
import { DeploymentService } from "@/services/deployments.js";

const deployments = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const finishDeploymentSchema = z.object({
  token: z.string().min(1, "Token is required"),
  id: z.ulid("Invalid deployment ID"),
  blueprint: z.record(z.string(), z.any()).optional().default({}),
});

deployments.post("/finish", async (c) => {
  const service = new DeploymentService(c.env);
  try {
    const body = await c.req.json();
    const validation = finishDeploymentSchema.safeParse(body);
    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({ field: err.path.join("."), message: err.message }));
      return c.json(createErrorResponse({ message: "Validation failed " + JSON.stringify(errors), code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { token, id, blueprint } = validation.data;
    const jwtService = getJWTService(c);
    let decoded: Awaited<ReturnType<typeof jwtService.verifyToken>>;
    try {
      decoded = await jwtService.verifyToken(token);
    } catch {
      return c.json(createErrorResponse({ message: "Invalid or expired token", code: ERROR.AUTH.BAD_TOKEN.code }), ERROR.AUTH.BAD_TOKEN.status);
    }
    if (!decoded) {
      return c.json(createErrorResponse({ message: "Invalid or expired token", code: ERROR.AUTH.BAD_TOKEN.code }), ERROR.AUTH.BAD_TOKEN.status);
    }

    const isNodeToken = (decoded as any).token_type === "node";
    const instanceId = (decoded as any).instance_id as string | undefined;
    const userId = decoded.sub as string;

    if (!isNodeToken && !userId) {
      return c.json(createErrorResponse({ message: "Invalid token: missing subject", code: ERROR.AUTH.BAD_TOKEN.code }), ERROR.AUTH.BAD_TOKEN.status);
    }
    if (isNodeToken && !instanceId) {
      return c.json(createErrorResponse({ message: "Invalid token: missing instance_id", code: ERROR.AUTH.BAD_TOKEN.code }), ERROR.AUTH.BAD_TOKEN.status);
    }

    const updated = await service.finish(c, { id, blueprint, isNodeToken, instanceId, userId });
    if (!updated) {
      return c.json(createErrorResponse({ message: "Failed to update deployment logs", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
    }

    return c.json(createSuccessResponse({ deployment: updated }));
  } catch (error) {
    if (error instanceof DatabaseConflictError && error.field === "name") {
      return c.json(createErrorResponse({ message: "Service name is already in use by another cluster. Service names must be globally unique.", code: ERROR.RESOURCE.CONFLICT.code }), ERROR.RESOURCE.CONFLICT.status);
    }
    return c.json(createErrorResponse({ message: "Failed to finish deployment", code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

deployments.use("*", authMiddleware);

deployments.post("/", requireClusterDeveloper, async (c) => {
  const service = new DeploymentService(c.env);
  const db = getDbStore(c);
  const clusterId = c.req.query("clusterId")!;
  const session = c.get("session")!;

  const body = await c.req.json().catch(() => null);
  if (!body) {
    return c.json(createErrorResponse({ message: "Request body is required", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const payload = {
    name: body.name,
    description: body.description,
    user_id: session.userId,
    type: body.type,
    source: body.source,
    runtime: body.runtimeType ?? body.runtime,
    version: body.runtimeVersion ?? body.version,
    run_cmd: body.runCmd ?? body.run_cmd,
    build_cmd: body.buildCmd ?? body.build_cmd,
    port: body.port,
    working_dir: body.workingDir ?? body.working_dir,
    static_dir: body.staticDir ?? body.static_dir,
    health_check: body.healthCheck ?? body.health_check,
    image: body.image,
    domain: body.domain,
    env_vars: body.envVars ?? body.env_vars,
    secrets: body.secrets,
    remote: (body.remoteUrl ?? body.remote?.url)
      ? { url: body.remoteUrl ?? body.remote?.url, branch: body.remoteBranch ?? body.remote?.branch, commit_hash: body.remoteCommitHash ?? body.remote?.commit_hash }
      : undefined,
    force_rebuild: body.forceRebuild ?? body.force_rebuild ?? false,
  };

  const validation = DeploymentSchema.safeParse(payload);
  if (!validation.success) {
    const errors = validation.error.issues.map((e) => ({ field: e.path.join("."), message: e.message }));
    return c.json(createErrorResponse({ message: "Validation failed: " + errors.map((e) => `${e.field}: ${e.message}`).join(", "), code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const instanceName = await db.instances.getRoutingKey(clusterId);
  if (!instanceName || instanceName === clusterId) {
    return c.json(createErrorResponse({ message: "Cluster has no assigned instance", code: ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.code }), ERROR.RUNTIME.INSTANCE_NOT_CONNECTED.status);
  }

  try {
    const result = await service.create(c, { clusterId, instanceName, payload: validation.data, session });
    return c.json(createSuccessResponse(result), SUCCESS.ACCEPTED.status);
  } catch (error) {
    return handleInstanceError(c, error, "Failed to create deployment");
  }
});

deployments.get("/", requireClusterViewer, async (c) => {
  const service = new DeploymentService(c.env);
  const clusterId = c.req.query("clusterId")!;
  const serviceId = c.req.query("serviceId");
  const status = c.req.query("status");
  const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));

  const { deployments: items, total } = await service.list(c, { clusterId, serviceId, status, pageSize, offset });
  return c.json(createSuccessResponse(createPaginatedResponse(items, page, pageSize, total)));
});

deployments.get("/:id", requireClusterViewer, async (c) => {
  const service = new DeploymentService(c.env);
  const clusterId = c.req.query("clusterId")!;
  const id = c.req.param("id");

  const deployment = await service.get(c, { clusterId, id });
  if (!deployment) {
    return c.json(createErrorResponse({ message: "Deployment not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }
  return c.json(createSuccessResponse({ deployment }));
});

deployments.delete("/:id", requireClusterDeveloper, async (c) => {
  const service = new DeploymentService(c.env);
  const clusterId = c.req.query("clusterId")!;
  const id = c.req.param("id");

  try {
    await service.delete(c, { clusterId, id });
    return c.json(createSuccessResponse({}));
  } catch (error) {
    return handleInstanceError(c, error, "Failed to delete deployment");
  }
});

export default deployments;
