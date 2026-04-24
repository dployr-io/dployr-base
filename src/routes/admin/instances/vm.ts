// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createErrorResponse, createSuccessResponse } from "@/types/index.js";
import { FREE_INSTANCE_IMAGE, FREE_INSTANCE_REGION, FREE_INSTANCE_SIZE } from "@/lib/constants/vm.js";
import { ERROR } from "@/lib/constants/index.js";
import { z } from "zod";
import type { VMRegion, VMSize, VMImage } from "@/types/vm.js";
import { getVMService } from "@/lib/config/context.js";

const vm = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const createVMSchema = z.object({
  name: z.string().min(1, "Name is required").max(255),
  size: z.string().default(FREE_INSTANCE_SIZE) as z.ZodType<VMSize>,
  image: z.string().default(FREE_INSTANCE_IMAGE) as z.ZodType<VMImage>,
  region: z.string().default(FREE_INSTANCE_REGION) as z.ZodType<VMRegion>,
  sshKey: z.union([z.string(), z.number()]).optional(),
  vpcUuid: z.string().optional(),
  tags: z.array(z.string()).optional(),
  autoInstall: z.boolean().default(true), // install dployrd on init
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
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

// Auto install dployrd on init
vm.post("/", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const validation = createVMSchema.safeParse(body);

  if (!validation.success) {
    const message = validation.error.issues
      .map((e) => `${e.path.join(".")}: ${e.message}`)
      .join(", ");
    return c.json(
      createErrorResponse({ message: `Validation failed — ${message}`, code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const { autoInstall, ...options } = validation.data;

  try {
    const service = getVMService(c);
    const droplet = await service.create({
      ...options,
      // Passing undefined lets the service fall back to DPLOYR_INSTALL_SCRIPT
      userData: autoInstall ? undefined : "",
    });

    return c.json(createSuccessResponse({ droplet }), 201);
  } catch (error: any) {
    console.error("[Admin/VM] Failed to create VM:", error);
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * GET /v1/admin/vm/:id
 * Retrieve a single Droplet by its numeric DigitalOcean ID.
 */
vm.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(
      createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  try {
    const service = getVMService(c);
    const droplet = await service.get(id);

    if (!droplet) {
      return c.json(
        createErrorResponse({ message: "Droplet not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
        ERROR.RESOURCE.MISSING_RESOURCE.status,
      );
    }

    return c.json(createSuccessResponse({ droplet }));
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to get VM ${id}:`, error);
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * DELETE /v1/admin/vm/:id
 * Permanently destroy a Droplet. This is irreversible.
 */
vm.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(
      createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  try {
    const service = getVMService(c);
    await service.delete(id);
    return c.json(createSuccessResponse({ deleted: id }));
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to delete VM ${id}:`, error);
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * POST /v1/admin/vm/:id/start
 * Power on a stopped Droplet.
 */
vm.post("/:id/start", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(
      createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
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
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * POST /v1/admin/vm/:id/stop
 * Gracefully shut down a Droplet.
 */
vm.post("/:id/stop", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(
      createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
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
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * POST /v1/admin/vm/:id/restart
 * Power-cycle (hard reboot) a Droplet.
 */
vm.post("/:id/restart", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(
      createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
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
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * GET /v1/admin/vm/:id/ping
 * Check whether a Droplet is active and reachable via the DO API.
 */
vm.get("/:id/ping", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(
      createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  try {
    const service = getVMService(c);
    const alive = await service.ping(id);
    return c.json(createSuccessResponse({ id, alive }));
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to ping VM ${id}:`, error);
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * GET /v1/admin/vm/:id/metrics
 * Retrieve bandwidth and resource metrics from the DO Monitoring API.
 * Requires the Monitoring agent to be installed on the Droplet.
 */
vm.get("/:id/metrics", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(
      createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  try {
    const service = getVMService(c);
    const metrics = await service.getMetrics(id);
    return c.json(createSuccessResponse({ id, metrics }));
  } catch (error: any) {
    console.error(`[Admin/VM] Failed to get metrics for VM ${id}:`, error);
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

/**
 * POST /v1/admin/vm/:id/wait
 * Block until a Droplet reaches `active` status and has a public IPv4.
 * Useful after provisioning when you need the IP before proceeding.
 * Accepts an optional `timeoutMs` body parameter (default: 300 000).
 */
vm.post("/:id/wait", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  if (isNaN(id)) {
    return c.json(
      createErrorResponse({ message: "Invalid Droplet ID", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const body = await c.req.json().catch(() => ({}));
  const timeoutMs = typeof body.timeoutMs === "number" ? body.timeoutMs : 300_000;

  try {
    const service = getVMService(c);
    const droplet = await service.waitForActive(id, timeoutMs);
    return c.json(createSuccessResponse({ droplet }));
  } catch (error: any) {
    console.error(`[Admin/VM] Timed out waiting for VM ${id}:`, error);
    return c.json(
      createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }),
      ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status,
    );
  }
});

export default vm;