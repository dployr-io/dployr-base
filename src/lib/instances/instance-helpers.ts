// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Context } from "hono";
import { createErrorResponse, createPaginatedResponse, createSuccessResponse, parsePaginationParams } from "@/types/index.js";
import { ERROR, INSTANCE_REGIONS } from "@/lib/constants/index.js";
import { getInstanceService } from "@/lib/config/context.js";
import { BillingService } from "@/services/billing/index.js";
import { Bindings, Variables } from "@/types/index.js";
import { Hono } from "hono";
import z from "zod";
import { DatabaseConflictError, handleInstanceError } from "../errors/errors.js";

export const createInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().regex(/^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/, "Address must be a valid IPv4 address"),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters"),
  region: z.enum(INSTANCE_REGIONS).optional(),
});

const rotateSchema = z.object({
  token: z.string().min(1, "Token is required"),
});

const installDployrSchema = z.object({
  version: z.string().min(1, "Version is required"),
});

const rebootInstanceSchema = z.object({
  force: z.boolean().default(false),
});

const restartDaemonSchema = z.object({
  force: z.boolean().default(false),
});

export function requireClusterId(c: Context): { ok: true; clusterId: string } | { ok: false; response: Response } {
  const clusterId = c.req.query("clusterId");
  if (!clusterId) {
    return {
      ok: false,
      response: c.json(
        createErrorResponse({
          message: "clusterId is required",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      ) as unknown as Response,
    };
  }
  return { ok: true, clusterId };
}

export function attachCreateInstance(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post("/", async (c) => {
    const data = await c.req.json();
    const session = c.get("session")!;
    const sessionId = c.req.query("sessionId");
    const validation = createInstanceSchema.safeParse(data);

    if (!validation.success) {
      const message = validation.error.issues.map((e: { path: any[]; message: any }) => `${e.path.join(".")}: ${e.message}`).join(", ");
      return c.json(createErrorResponse({ message: `Validation failed — ${message}`, code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { clusterId, tag, address, region } = validation.data;

    try {
      const instance = await getInstanceService(c).createInstance({
        clusterId,
        tag,
        address,
        userId: sessionId ?? session.userId,
        c,
        metadata: region ? { region } : undefined,
      });

      return c.json(createSuccessResponse({ data: instance }));
    } catch (error: any) {
      if (error instanceof DatabaseConflictError) {
        return c.json(
          createErrorResponse({
            message: `An instance with this ${error.field} already exists`,
            code: ERROR.RESOURCE.CONFLICT.code,
          }),
          ERROR.RESOURCE.CONFLICT.status,
        );
      }

      console.error(`[Instances] Failed to create instance for user ${sessionId ?? session.userId}:`, error);

      return c.json(
        createErrorResponse({
          message: ERROR.REQUEST.INTERNAL_SERVER_ERROR.message,
          code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
        }),
        ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
      );
    }
  });
}

export function attachListInstances(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.get("/", async (c) => {
    const clusterId = c.req.query("clusterId");
    const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));
    const instanceService = getInstanceService(c);
    const [{ instances, total }, instance] = await Promise.all([
      instanceService.listInstances({
        c,
        clusterId,
        limit: pageSize,
        offset,
      }),
      instanceService.resolveInstance({ c, clusterId }),
    ]);

    const finalInstances = instance ? [instance, ...instances] : instances;
    const finalTotal = instance ? total + 1 : total;
    const paginatedData = createPaginatedResponse(finalInstances, page, pageSize, finalTotal);

    return c.json(createSuccessResponse(paginatedData));
  });
}

export function attachGetInstance(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.get("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      const instance = await getInstanceService(c).getInstance({ instanceId: id, c });
      return c.json({ success: true, data: instance });
    } catch {
      return c.json(
        createErrorResponse({
          message: "Instance not found",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }
  });
}

export function attachDeleteInstance(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.delete("/:id", async (c) => {
    const id = c.req.param("id");
    try {
      await getInstanceService(c).deleteInstance({ instanceId: id, c });
      return c.json({ success: true, data: { deleted: true } });
    } catch {
      return c.json(
        createErrorResponse({
          message: "Instance not found",
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }
  });
}

export function attachPingInstance(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post("/:name/ping", async (c) => {
    const instanceName = c.req.param("name");

    try {
      await getInstanceService(c).pingInstance({ instanceName, c });
      return c.json(createSuccessResponse({ status: "enqueued" }));
    } catch (error: any) {
      if (error.message === "Instance not found") {
        return c.json(
          createErrorResponse({
            message: "Instance not found",
            code: ERROR.REQUEST.BAD_REQUEST.code,
          }),
          ERROR.REQUEST.BAD_REQUEST.status,
        );
      }
      throw error;
    }
  });
}

export function attachAddInstanceDomain(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post("/:name/domain", async (c) => {
    const instanceName = c.req.param("name");

    try {
      const domain = await getInstanceService(c).saveDomain({ instanceName, c });
      return c.json(createSuccessResponse({ domain }));
    } catch (error: any) {
      if (error.message === "Instance not found") {
        return c.json(
          createErrorResponse({
            message: "Instance not found",
            code: ERROR.REQUEST.BAD_REQUEST.code,
          }),
          ERROR.REQUEST.BAD_REQUEST.status,
        );
      }
      throw error;
    }
  });
}

export function attachRotateInstanceToken(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post("/:instanceId/tokens/rotate", async (c) => {
    const instanceId = c.req.param("instanceId");
    const body = await c.req.json();
    const validation = rotateSchema.safeParse(body);
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

    const { token } = validation.data;

    try {
      const rotated = await getInstanceService(c).rotateInstanceBootstrapToken({
        instanceId,
        token,
        c,
      });

      return c.json(createSuccessResponse({ token: rotated }), 200);
    } catch (e) {
      return handleInstanceError(c, e, "Failed to rotate token");
    }
  });
}

export function attachInstallDployr(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post("/:instanceId/system/install", async (c) => {
    try {
      const instanceId = c.req.param("instanceId");
      const guard = requireClusterId(c);
      if (!guard.ok) return guard.response as any;
      const body = await c.req.json();
      const validation = installDployrSchema.safeParse(body);
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

      const { version } = validation.data;

      const taskId = await getInstanceService(c).installDployr({
        c,
        clusterId: guard.clusterId,
        instanceId,
        version,
      });

      return c.json(
        createSuccessResponse({
          status: "accepted",
          taskId,
          message: version ? `Install task sent for version ${version}` : "Install task sent for latest version",
        }),
        202,
      );
    } catch (error) {
      return handleInstanceError(c, error, "Failed to send system install task");
    }
  });
}

export function attachRebootInstance(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post("/:instanceId/system/reboot", async (c) => {
    try {
      const instanceId = c.req.param("instanceId");
      const guard = requireClusterId(c);
      if (!guard.ok) return guard.response as any;
      const body = await c.req.json();
      const validation = rebootInstanceSchema.safeParse(body);
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

      const { force } = validation.data;

      const taskId = await getInstanceService(c).rebootInstance({
        c,
        clusterId: guard.clusterId,
        instanceId,
        force,
      });

      return c.json(
        createSuccessResponse({
          status: "accepted",
          taskId,
          message: force ? "Reboot instance task with force mode sent" : "Reboot instance task sent",
        }),
        202,
      );
    } catch (error) {
      return handleInstanceError(c, error, "Failed to send system reboot instance task");
    }
  });
}

export function attachRestartDaemon(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post("/:instanceId/system/restart", async (c) => {
    try {
      const instanceId = c.req.param("instanceId");
      const guard = requireClusterId(c);
      if (!guard.ok) return guard.response as any;
      const body = await c.req.json();
      const validation = restartDaemonSchema.safeParse(body);
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

      const { force } = validation.data;

      const taskId = await getInstanceService(c).restartDaemon({
        c,
        clusterId: guard.clusterId,
        instanceId,
        force,
      });

      return c.json(
        createSuccessResponse({
          status: "accepted",
          taskId,
          message: force ? "Restart daemon task with force mode sent" : "Restart daemon task sent",
        }),
        202,
      );
    } catch (error) {
      return handleInstanceError(c, error, "Failed to send system restart daemon task");
    }
  });
}
