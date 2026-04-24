// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, InstanceEntry, Variables, createErrorResponse, createSuccessResponse } from "@/types/index.js";
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
import { getKV } from "@/lib/config/context.js";
import { ERROR, INSTANCE_REGIONS } from "@/lib/constants/index.js";
import z from "zod";
import { ulid } from "ulid";
import { InstanceStore } from "@/lib/db/store/kv/free-instance.js";

export const addPoolInstanceSchema = z.object({
  address: z.string().regex(/^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/, "Address must be a valid IPv4 address"),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters"),
  capacity: z.number().int().positive("Capacity must be a positive integer"),
  region: z.enum(INSTANCE_REGIONS).optional(),
});

const instances = new Hono<{ Bindings: Bindings; Variables: Variables }>();

instances.use("*", requireDployrAdministrator);

// Add an instance to pool
instances.post("/pool", async (c) => {
  const data = await c.req.json();
  const validation = addPoolInstanceSchema.safeParse(data);

  if (!validation.success) {
    const errors = validation.error.issues.map((err) => ({
      field: err.path.join("."),
      message: err.message,
    }));
    return c.json(
      createErrorResponse({
        message: "Validation failed " + errors.map((e) => `${e.field}: ${e.message}`).join(", "),
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const { address, tag, capacity, region } = validation.data;
  const kvAdapter = getKV(c);
  const instanceStore = new InstanceStore(kvAdapter);

  const pool = await instanceStore.getInstancePool();
  if (!pool) {
    return c.json(createErrorResponse({ message: "Pool not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const exists = pool.some((inst) => inst.tag === tag);
  if (exists) {
    return c.json(createErrorResponse({ message: "Instance already exists in pool", code: ERROR.RESOURCE.CONFLICT.code }), ERROR.RESOURCE.CONFLICT.status);
  }

  const newInstance: InstanceEntry = {
    id: ulid(),
    address,
    tag,
    capacity,
    region,
    status: "active",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  pool.push(newInstance);
  await instanceStore.setInstancePool(pool);
  return c.json(createSuccessResponse({ instance: newInstance }));
});

// Removes an instance from pool (does not remove VM)
instances.delete("/pool/:id", async (c) => {
  const id = c.req.param("id");
  const kvAdapter = getKV(c);
  const instanceStore = new InstanceStore(kvAdapter);

  const pool = await instanceStore.getInstancePool();
  if (!pool) {
    return c.json(createErrorResponse({ message: "Pool not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const exists = pool.some((inst) => inst.id === id);
  if (!exists) {
    return c.json(createErrorResponse({ message: "Instance not found in pool", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const updatedPool = pool.filter((inst) => inst.id !== id);
  await instanceStore.setInstancePool(updatedPool);

  // Release all clusters assigned to this instance
  const assignments = await instanceStore.getClustersInstanceMap();
  await Promise.all(assignments.filter((a) => a.instanceId === id).map((a) => instanceStore.releaseInstance(a.clusterId)));

  return c.json(createSuccessResponse({ deleted: id }));
});

// Pause deployments to this instance during that window
instances.patch("/pool/:id/pause", async (c) => {
  const id = c.req.param("id");
  const kvAdapter = getKV(c);
  const instanceStore = new InstanceStore(kvAdapter);

  const pool = await instanceStore.getInstancePool();
  if (!pool) {
    return c.json(createErrorResponse({ message: "Pool not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const idx = pool.findIndex((inst) => inst.id === id);
  if (idx === -1) {
    return c.json(createErrorResponse({ message: "Instance not found in pool", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  pool[idx] = { ...pool[idx], status: "paused" };
  await instanceStore.setInstancePool(pool);

  return c.json(createSuccessResponse({ id, status: "paused" }));
});

// Resume deployments to this instance
instances.patch("/pool/:id/resume", async (c) => {
  const id = c.req.param("id");
  const kvAdapter = getKV(c);
  const instanceStore = new InstanceStore(kvAdapter);

  const pool = await instanceStore.getInstancePool();
  if (!pool) {
    return c.json(createErrorResponse({ message: "Pool not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  const idx = pool.findIndex((inst) => inst.id === id);
  if (idx === -1) {
    return c.json(createErrorResponse({ message: "Instance not found in pool", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  pool[idx] = { ...pool[idx], status: "active" };
  await instanceStore.setInstancePool(pool);

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
