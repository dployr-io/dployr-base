// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { TrafficRouter } from "@/services/traffic-router.js";
import { authMiddleware, requireClusterViewer } from "@/middleware/auth.js";
import { getDB, getKV, type AppVariables } from "@/lib/context.js";
import { ERROR } from "@/lib/constants/index.js";

const proxy = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

// All routes require authentication
proxy.use("*", authMiddleware);

/**
 * Resolve a hostname to its route (for debugging/testing)
 * GET /v1/proxy/resolve?hostname=service.cluster.dployr.io
 */
proxy.get("/resolve", async (c) => {
  const hostname = c.req.query("hostname");
  
  if (!hostname) {
    return c.json(
      createErrorResponse({
        message: "hostname query parameter is required",
        code: ERROR.VALIDATION.MISSING_FIELDS.code,
      }),
      ERROR.VALIDATION.MISSING_FIELDS.status
    );
  }

  const db = new DatabaseStore(getDB(c));
  const kv = new KVStore(getKV(c));
  
  // Get base domain from config or default
  const baseDomain = c.env?.PROXY_BASE_DOMAIN ?? "dployr.io";
  const router = new TrafficRouter(db, kv, { baseDomain });

  const parsed = router.parseHostname(hostname);
  if (!parsed) {
    return c.json(
      createErrorResponse({
        message: `Invalid hostname format. Expected: service.cluster.${baseDomain}`,
        code: ERROR.VALIDATION.INVALID_FORMAT.code,
      }),
      ERROR.VALIDATION.INVALID_FORMAT.status
    );
  }

  const route = await router.resolveRoute(hostname);
  
  if (!route) {
    return c.json(
      createErrorResponse({
        message: "Service not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status
    );
  }

  return c.json(
    createSuccessResponse({
      hostname,
      parsed,
      route: {
        serviceName: route.serviceName,
        clusterName: route.clusterName,
        instanceAddress: route.instanceAddress,
        instancePort: route.instancePort,
        serviceId: route.serviceId,
        instanceId: route.instanceId,
      },
    })
  );
});

/**
 * Get proxy server statistics
 * GET /v1/proxy/stats
 */
proxy.get("/stats", async (c) => {
  const db = new DatabaseStore(getDB(c));
  const kv = new KVStore(getKV(c));
  
  const baseDomain = c.env?.PROXY_BASE_DOMAIN ?? "dployr.io";
  const router = new TrafficRouter(db, kv, { baseDomain });

  return c.json(
    createSuccessResponse({
      router: router.getStats(),
      baseDomain,
    })
  );
});

/**
 * List all routable services for a cluster
 * GET /v1/proxy/services?clusterId=xxx
 */
proxy.get("/services", requireClusterViewer, async (c) => {
  const clusterId = c.req.query("clusterId");
  
  if (!clusterId) {
    return c.json(
      createErrorResponse({
        message: "clusterId query parameter is required",
        code: ERROR.VALIDATION.MISSING_FIELDS.code,
      }),
      ERROR.VALIDATION.MISSING_FIELDS.status
    );
  }

  const db = new DatabaseStore(getDB(c));
  const baseDomain = c.env?.PROXY_BASE_DOMAIN ?? "dployr.io";

  // Get cluster
  const cluster = await db.clusters.get(clusterId);
  if (!cluster) {
    return c.json(
      createErrorResponse({
        message: "Cluster not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status
    );
  }

  // Get all instances in the cluster
  const { instances } = await db.instances.getByCluster(clusterId);

  // Get services for each instance
  const services: Array<{
    serviceName: string;
    instanceId: string;
    instanceTag: string;
    url: string;
  }> = [];

  for (const instance of instances) {
    const instanceServices = await db.services.getByInstance(instance.id);
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
    })
  );
});

/**
 * Invalidate proxy cache for a service
 * POST /v1/proxy/invalidate
 */
proxy.post("/invalidate", requireClusterViewer, async (c) => {
  const body = await c.req.json<{
    serviceName?: string;
    clusterName?: string;
    all?: boolean;
  }>();

  const db = new DatabaseStore(getDB(c));
  const kv = new KVStore(getKV(c));
  
  const baseDomain = c.env?.PROXY_BASE_DOMAIN ?? "dployr.io";
  const router = new TrafficRouter(db, kv, { baseDomain });

  if (body.all) {
    router.clearCache();
    return c.json(createSuccessResponse({ message: "All routes invalidated" }));
  }

  if (body.serviceName && body.clusterName) {
    router.invalidateRoute(body.serviceName, body.clusterName);
    return c.json(
      createSuccessResponse({
        message: `Route ${body.serviceName}.${body.clusterName} invalidated`,
      })
    );
  }

  if (body.clusterName) {
    router.invalidateCluster(body.clusterName);
    return c.json(
      createSuccessResponse({
        message: `All routes for cluster ${body.clusterName} invalidated`,
      })
    );
  }

  return c.json(
    createErrorResponse({
      message: "Specify serviceName+clusterName, clusterName, or all:true",
      code: ERROR.VALIDATION.MISSING_FIELDS.code,
    }),
    ERROR.VALIDATION.MISSING_FIELDS.status
  );
});

export default proxy;
