// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { ulid } from "ulid";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { authMiddleware, requireClusterDeveloper, requireClusterViewer, resolveCluster } from "@/middleware/auth.js";
import { getDbStore, getTrafficRouter, getWS, getJWTService } from "@/lib/config/context.js";
import { ERROR } from "@/lib/constants/index.js";
import { DployrdService } from "@/services/dployrd.js";

const dployrdService = new DployrdService();

const proxy = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// All routes require authentication
proxy.use("*", authMiddleware);

/**
 * List all routable services for a cluster
 */
proxy.get("/services", requireClusterViewer, async (c) => {
  const clusterId = c.req.query("clusterId");

  if (!clusterId) {
    return c.json(
      createErrorResponse({
        message: "clusterId query parameter is required",
        code: ERROR.VALIDATION.MISSING_FIELDS.code,
      }),
      ERROR.VALIDATION.MISSING_FIELDS.status,
    );
  }

  const db = getDbStore(c);
  const baseDomain = c.env?.TLD ?? "dployr.io";

  // Get cluster
  const cluster = await db.clusters.get(clusterId);
  if (!cluster) {
    return c.json(
      createErrorResponse({
        message: "Cluster not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  // Get all instances in the cluster
  const { instances } = await db.instances.list({ clusterId });

  // Get services for each instance
  const services: Array<{
    serviceName: string;
    instanceId: string;
    instanceTag: string;
    url: string;
  }> = [];

  for (const instance of instances) {
    const { services: instanceServices } = await db.services.list({ clusterId });
    for (const service of instanceServices) {
      services.push({
        serviceName: service.name,
        instanceId: instance.id,
        instanceTag: instance.tag,
        url: `https://${service.name}.${cluster.name}.${baseDomain}`,
      });
    }
  }

  return c.json(
    createSuccessResponse({
      clusterId,
      clusterName: cluster.name,
      baseDomain,
      services,
    }),
  );
});

/**
 * Invalidate proxy cache for a service
 */
proxy.post("/invalidate", requireClusterViewer, async (c) => {
  const body = await c.req.json<{
    serviceName?: string;
    clusterName?: string;
    all?: boolean;
  }>();

  const router = getTrafficRouter(c);

  if (body.all) {
    router.clearCache();
    return c.json(createSuccessResponse({ message: "All routes invalidated" }));
  }

  if (body.serviceName && body.clusterName) {
    router.invalidateRoute(body.serviceName, body.clusterName);
    return c.json(
      createSuccessResponse({
        message: `Route ${body.serviceName}.${body.clusterName} invalidated`,
      }),
    );
  }

  if (body.clusterName) {
    router.invalidateCluster(body.clusterName);
    return c.json(
      createSuccessResponse({
        message: `All routes for cluster ${body.clusterName} invalidated`,
      }),
    );
  }

  return c.json(
    createErrorResponse({
      message: "Specify serviceName+clusterName, clusterName, or all:true",
      code: ERROR.VALIDATION.MISSING_FIELDS.code,
    }),
    ERROR.VALIDATION.MISSING_FIELDS.status,
  );
});

proxy.get("/node/status", resolveCluster('proxy', { path: 'id' }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const clusterId = c.get("resolvedClusterId")!;
  const instanceName = c.req.query("instanceName");

  if (!instanceName) {
    return c.json(createErrorResponse({ message: "instanceName is required", code: ERROR.VALIDATION.MISSING_FIELDS.code }), ERROR.VALIDATION.MISSING_FIELDS.status);
  }

  const instance = await db.instances.find({ tag: instanceName });
  if (!instance) {
    return c.json(createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const jwtService = getJWTService(c);
  const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
  const taskId = ulid();
  const task = dployrdService.createProxyStatusTask(taskId, token);
  const routingKey = await db.instances.getRoutingKey(clusterId);
  getWS(c).sendTask(routingKey, task);

  return c.json(createSuccessResponse({ taskId, message: "Proxy status task dispatched" }));
});

proxy.post("/node/restart", resolveCluster('proxy', { path: 'id' }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const clusterId = c.get("resolvedClusterId")!;
  const body = await c.req.json().catch(() => ({} as any));
  const { instanceName, force = false } = body as { instanceName?: string; force?: boolean };

  if (!instanceName) {
    return c.json(createErrorResponse({ message: "instanceName is required", code: ERROR.VALIDATION.MISSING_FIELDS.code }), ERROR.VALIDATION.MISSING_FIELDS.status);
  }

  const instance = await db.instances.find({ tag: instanceName });
  if (!instance) {
    return c.json(createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const jwtService = getJWTService(c);
  const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
  const taskId = ulid();
  const task = dployrdService.createProxyRestartTask(taskId, force, token);
  const routingKey = await db.instances.getRoutingKey(clusterId);
  getWS(c).sendTask(routingKey, task);

  return c.json(createSuccessResponse({ taskId, message: "Proxy restart task dispatched" }));
});

proxy.post("/node/routes", resolveCluster('proxy', { path: 'id' }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const clusterId = c.get("resolvedClusterId")!;
  const body = await c.req.json().catch(() => ({} as any));
  const { instanceName, serviceName, upstream, domain, template } = body as {
    instanceName?: string;
    serviceName?: string;
    upstream?: string;
    domain?: string;
    template?: string;
  };

  if (!instanceName || !serviceName || !upstream) {
    return c.json(createErrorResponse({ message: "instanceName, serviceName, and upstream are required", code: ERROR.VALIDATION.MISSING_FIELDS.code }), ERROR.VALIDATION.MISSING_FIELDS.status);
  }

  const instance = await db.instances.find({ tag: instanceName });
  if (!instance) {
    return c.json(createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const jwtService = getJWTService(c);
  const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
  const taskId = ulid();
  const task = dployrdService.createProxyAddTask(taskId, serviceName, upstream, domain, template, token);
  const routingKey = await db.instances.getRoutingKey(clusterId);
  getWS(c).sendTask(routingKey, task);

  return c.json(createSuccessResponse({ taskId, message: "Proxy route add task dispatched" }), 202);
});

proxy.delete("/node/routes/:service", resolveCluster('proxy', { path: 'id' }), requireClusterDeveloper, async (c) => {
  const db = getDbStore(c);
  const session = c.get("session")!;
  const clusterId = c.get("resolvedClusterId")!;
  const serviceName = c.req.param("service");
  const instanceName = c.req.query("instanceName");

  if (!instanceName) {
    return c.json(createErrorResponse({ message: "instanceName is required", code: ERROR.VALIDATION.MISSING_FIELDS.code }), ERROR.VALIDATION.MISSING_FIELDS.status);
  }

  const instance = await db.instances.find({ tag: instanceName });
  if (!instance) {
    return c.json(createErrorResponse({ message: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const jwtService = getJWTService(c);
  const token = await jwtService.createInstanceAccessToken(session, instanceName, clusterId);
  const taskId = ulid();
  const task = dployrdService.createProxyRemoveTask(taskId, serviceName, token);
  const routingKey = await db.instances.getRoutingKey(clusterId);
  getWS(c).sendTask(routingKey, task);

  return c.json(createSuccessResponse({ taskId, message: "Proxy route remove task dispatched" }));
});

export default proxy;
