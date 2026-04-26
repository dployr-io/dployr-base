// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createErrorResponse, createSuccessResponse } from "@/types/index.js";
import { DEFAULT_INSTANCE_IMAGE, DEFAULT_INSTANCE_REGION, DEFAULT_INSTANCE_SIZE } from "@/lib/constants/vm.js";
import { ERROR } from "@/lib/constants/index.js";
import { z } from "zod";
import { ulid } from "ulid";
import type { VMRegion, VMSize, VMImage } from "@/types/vm.js";
import { getVMService, getJWTService, getDbStore } from "@/lib/config/context.js";
import { worker } from "@/services/background/index.js";

const vm = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const createVmSchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  size: z.string().default(DEFAULT_INSTANCE_SIZE) as z.ZodType<VMSize>,
  image: z.string().default(DEFAULT_INSTANCE_IMAGE) as z.ZodType<VMImage>,
  region: z.string().default(DEFAULT_INSTANCE_REGION) as z.ZodType<VMRegion>,
  sshKey: z.union([z.string(), z.number()]).optional(),
  vpcUuid: z.string().optional(),
  tags: z.array(z.string()).optional(),
  userData: z.string().optional(), // install dployrd on init
});

const actionSchema = z.object({
  wait: z.boolean().default(false), // poll until the action completes before responding
});

const rebootSchema = actionSchema;

// List all Droplets visible to the configured API token.
vm.get("/", async (c) => {
  try {
    const service = getVMService(c);
    const droplets = await service.list();
    return c.json(createSuccessResponse({ droplets, total: droplets.length }));
  } catch (error: any) {
    console.error("[Admin/VM] Failed to list VMs:", error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Auto install dployrd on init
vm.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = createVmSchema.safeParse(body);

  if (!validation.success) {
    const message = validation.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    return c.json(createErrorResponse({ message: `Validation failed — ${message}`, code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const { userData, ...options } = validation.data;

  try {
    const service = getVMService(c);

    let token: string | undefined;
    if (userData) {
      const jwt = getJWTService(c);
      const db = getDbStore(c);
      const instanceId = ulid();
      token = await jwt.createBootstrapToken(options.name);
      const decoded = await jwt.verifyToken(token);
      await db.bootstrapTokens.create(instanceId, decoded.nonce as string);
    }

    const droplet = await service.create({
      ...options,
      token,
      userData,
    });

    worker.emit("pool-sync");

    return c.json(createSuccessResponse({ droplet }), 201);
  } catch (error: any) {
    console.error("[Admin/VM] Failed to create VM:", error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Retrieve a single Droplet by its numeric DigitalOcean ID.
vm.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  try {
    const service = getVMService(c);
    const droplet = await service.get(id);

    if (!droplet) {
      return c.json(createErrorResponse({ message: "Droplet not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }

    return c.json(createSuccessResponse({ droplet }));
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to get VM ${id}:`, error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Permanently destroy a Droplet. This is irreversible.
vm.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  try {
    const service = getVMService(c);
    await service.delete(id);
    return c.json(createSuccessResponse({ deleted: id }));
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to delete VM ${id}:`, error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Power on a stopped Droplet.
vm.post("/:id/start", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  try {
    const service = getVMService(c);
    const action = await service.start(id);

    const body = await c.req.json().catch(() => ({}));
    const { wait } = actionSchema.parse(body);

    if (wait) {
      const completed = await service.waitForAction(id, action.id);
      return c.json(createSuccessResponse({ action: completed }));
    }

    return c.json(createSuccessResponse({ action }), 202);
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to start VM ${id}:`, error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Gracefully shut down a Droplet.
vm.post("/:id/stop", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  try {
    const service = getVMService(c);
    const action = await service.stop(id);

    const body = await c.req.json().catch(() => ({}));
    const { wait } = actionSchema.parse(body);

    if (wait) {
      const completed = await service.waitForAction(id, action.id);
      return c.json(createSuccessResponse({ action: completed }));
    }

    return c.json(createSuccessResponse({ action }), 202);
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to stop VM ${id}:`, error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Power-cycle (hard reboot) a Droplet.
vm.post("/:id/restart", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  try {
    const service = getVMService(c);
    const action = await service.restart(id);

    const body = await c.req.json().catch(() => ({}));
    const { wait } = rebootSchema.parse(body);

    if (wait) {
      const completed = await service.waitForAction(id, action.id);
      return c.json(createSuccessResponse({ action: completed }));
    }

    return c.json(createSuccessResponse({ action }), 202);
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to restart VM ${id}:`, error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Check whether a Droplet is active and reachable via the DO API.
vm.get("/:id/ping", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  try {
    const service = getVMService(c);
    const alive = await service.ping(id);
    return c.json(createSuccessResponse({ id, alive }));
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to ping VM ${id}:`, error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Retrieve bandwidth and resource metrics from the DO Monitoring API.
// Requires the Monitoring agent to be installed on the Droplet.
vm.get("/:id/metrics", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  try {
    const service = getVMService(c);
    const metrics = await service.getMetrics(id);
    return c.json(createSuccessResponse({ id, metrics }));
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to get metrics for VM ${id}:`, error);
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default vm;
