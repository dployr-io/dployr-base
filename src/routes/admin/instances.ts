// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createErrorResponse, createSuccessResponse } from "@/types/index.js";
import { requireDployrAdministrator } from "@/middleware/auth.js";
import {
  attachListInstances,
  attachGetInstance,
  attachDeleteInstance,
  attachCreateInstance,
  attachAddInstanceDomain,
  attachPingInstance,
  attachRotateInstanceToken,
  attachInstallDployr,
  attachRebootInstance,
  attachRestartDaemon,
} from "@/lib/instances/instance-helpers.js";
import { getKVStore } from "@/lib/context.js";
import { loadConfig } from "@/lib/config/loader.js";
import { ERROR } from "@/lib/constants/index.js";

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();

instances.use("*", requireDployrAdministrator);

// Free instance management

instances.post("/free/seed", async (c) => {
  const config = loadConfig();
  if (!config.free_instances || config.free_instances.length === 0) {
    return c.json(createErrorResponse({ message: "No free_instances defined in config", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }
  const kv = getKVStore(c);
  await kv.setFreeInstancePool(config.free_instances);
  return c.json(createSuccessResponse({ seeded: config.free_instances }));
});

instances.delete("/free/:id", async (c) => {
  const id = c.req.param("id");
  const kv = getKVStore(c);

  const pool = await kv.getFreeInstancePool();
  if (!pool) {
    return c.json(createErrorResponse({ message: "Pool not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const exists = pool.some((inst) => inst.id === id);
  if (!exists) {
    return c.json(createErrorResponse({ message: "Instance not found in pool", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const updatedPool = pool.filter((inst) => inst.id !== id);
  await kv.setFreeInstancePool(updatedPool);

  // Release all clusters assigned to this instance
  const assignments = await kv.getClustersFreeInstanceMap();
  await Promise.all(assignments.filter((a) => a.instanceId === id).map((a) => kv.releaseFreeInstance(a.clusterId)));

  return c.json(createSuccessResponse({ deleted: id }));
});

instances.patch("/free/:id/pause", async (c) => {
  const id = c.req.param("id");
  const kv = getKVStore(c);

  const pool = await kv.getFreeInstancePool();
  if (!pool) {
    return c.json(createErrorResponse({ message: "Pool not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const idx = pool.findIndex((inst) => inst.id === id);
  if (idx === -1) {
    return c.json(createErrorResponse({ message: "Instance not found in pool", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  pool[idx] = { ...pool[idx], status: "paused" };
  await kv.setFreeInstancePool(pool);

  return c.json(createSuccessResponse({ id, status: "paused" }));
});

instances.patch("/free/:id/resume", async (c) => {
  const id = c.req.param("id");
  const kv = getKVStore(c);

  const pool = await kv.getFreeInstancePool();
  if (!pool) {
    return c.json(createErrorResponse({ message: "Pool not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const idx = pool.findIndex((inst) => inst.id === id);
  if (idx === -1) {
    return c.json(createErrorResponse({ message: "Instance not found in pool", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  pool[idx] = { ...pool[idx], status: "active" };
  await kv.setFreeInstancePool(pool);

  return c.json(createSuccessResponse({ id, status: "active" }));
});

attachListInstances(instances);

attachGetInstance(instances);

attachCreateInstance(instances);

attachDeleteInstance(instances);

attachPingInstance(instances);

attachAddInstanceDomain(instances);

attachRotateInstanceToken(instances);

attachInstallDployr(instances);

attachRebootInstance(instances);

attachRestartDaemon(instances);

export default instances;
