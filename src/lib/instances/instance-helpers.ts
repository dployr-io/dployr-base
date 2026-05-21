// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createErrorResponse, createPaginatedResponse, createSuccessResponse, parsePaginationParams } from "@/types/index.js";
import { ERROR, SUCCESS } from "@/lib/constants/index.js";
import { getDbStore, getInstancePoolService, getInstanceService, getKVStore, getTraefikRouterService, getVMService, getWS } from "@/lib/config/context.js";
import { Bindings, Variables } from "@/types/index.js";
import { Hono } from "hono";
import z from "zod";
import { DatabaseConflictError, handleInstanceError } from "../errors/errors.js";
import { INSTANCE_REGIONS } from "@/lib/constants/instances.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Instances");

export const createInstanceSchema = z.object({
  clusterId: z.ulid("Cluster ID is required"),
  address: z.string().regex(/^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/, "Address must be a valid IPv4 address"),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(21, "Tag must be a maximum of 21 characters"),
  region: z.enum(INSTANCE_REGIONS).optional(),
  managed: z.boolean().optional().default(true),
  role: z.enum(["instance", "build"]).optional().default("instance"),
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

    const { clusterId, tag, address, region, managed, role } = validation.data;

    try {
      const instance = await getInstanceService(c).createInstance({
        clusterId,
        tag,
        address,
        userId: sessionId ?? session.userId,
        c,
        managed,
        role,
        metadata: region ? { region } : undefined,
      });

      return c.json(createSuccessResponse(instance), SUCCESS.CREATED.status);
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

      log.error(`Failed to create instance for user ${sessionId ?? session.userId}:`, error);

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
    const role = c.req.query("role");
    const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));
    const instanceService = getInstanceService(c);
    const instancePoolService = getInstancePoolService(c);
    const [{ instances, total }, instance] = await Promise.all([
      instanceService.listInstances({ c, clusterId, role, limit: pageSize, offset }),
      instancePoolService.resolveInstancePool({ db: getDbStore(c), clusterId }),
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
    const db = getDbStore(c);

    try {
      // Lookup instance by ID or tag
      let instance = await db.instances.find({ id });
      if (!instance) {
        instance = await db.instances.find({ tag: id });
      }

      if (!instance) {
        return c.json(
          createErrorResponse({
            message: "Instance not found",
            code: ERROR.REQUEST.BAD_REQUEST.code,
          }),
          ERROR.REQUEST.BAD_REQUEST.status,
        );
      }

      const traefik = getTraefikRouterService(c);
      if (traefik) {
        try {
          const { clusters } = await db.clusters.list({ instanceTag: instance.tag });
          await Promise.all(
            clusters.map(async ({ id: clusterId }) => {
              const { services } = await db.services.list({ clusterId });
              await Promise.all(services.map((svc) => traefik.setLoadingMode(svc.name)));
            }),
          );
        } catch (err) {
          log.error(`Failed to set loading mode before deleting instance ${instance.tag}`, { error: String(err) });
        }
      }

      await db.instances.delete({ id: instance.id });
      getWS(c).evictNodeByTag(instance.tag);
      return c.json({ success: true, data: { deleted: true, instance: instance.tag } });
    } catch {
      return c.json(
        createErrorResponse({
          message: "Failed to delete instance",
          code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
        }),
        ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
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
      const clusterId = c.req.query("clusterId")!;
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
        clusterId,
        tag: instanceId,
        version,
      });

      return c.json(
        createSuccessResponse({
          status: "accepted",
          taskId,
          message: version ? `Install task sent for version ${version}` : "Install task sent for latest version",
        }),
        SUCCESS.ACCEPTED.status,
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
      const clusterId = c.req.query("clusterId")!;
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
        clusterId,
        instanceId,
        force,
      });

      return c.json(
        createSuccessResponse({
          status: "accepted",
          taskId,
          message: force ? "Reboot instance task with force mode sent" : "Reboot instance task sent",
        }),
        SUCCESS.ACCEPTED.status,
      );
    } catch (error) {
      return handleInstanceError(c, error, "Failed to send system reboot instance task");
    }
  });
}

export function attachGetInstanceHealth(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.get("/:tag/health", async (c) => {
    const tag = c.req.param("tag");
    const kv = getKVStore(c);
    const [healthEntity, resourcesEntity, nodeEntity, statusEntity, processesEntity] = await Promise.all([
      kv.entities.getEntity<any>(KV_KEYS.INSTANCE.ENTITY(tag, "health")),
      kv.entities.getEntity<any>(KV_KEYS.INSTANCE.ENTITY(tag, "resources")),
      kv.entities.getEntity<any>(KV_KEYS.INSTANCE.ENTITY(tag, "node")),
      kv.entities.getEntity<any>(KV_KEYS.INSTANCE.ENTITY(tag, "status")),
      kv.entities.getEntity<any>(KV_KEYS.INSTANCE.ENTITY(tag, "processes")),
    ]);
    if (!healthEntity && !resourcesEntity && !nodeEntity && !statusEntity && !processesEntity) {
      return c.json(createSuccessResponse(null));
    }
    const resources = resourcesEntity?.data as any;
    const node = nodeEntity?.data as any;
    const status = statusEntity?.data as any;
    const processes = processesEntity?.data as any;
    const lastUpdated = Math.max(
      healthEntity?.timestamp ?? 0,
      resourcesEntity?.timestamp ?? 0,
      nodeEntity?.timestamp ?? 0,
      statusEntity?.timestamp ?? 0,
      processesEntity?.timestamp ?? 0,
    );
    const data = {
      health: healthEntity?.data,
      resources: {
        cpu: resources?.cpu,
        memory: resources?.memory,
        disks: (resources?.disks as any[])?.slice(0, 4),
      },
      processes: (processes?.list as any[])?.slice(0, 6),
      uptime: status?.uptime_seconds,
      version: node?.version,
      go_version: node?.go_version,
      timestamp: lastUpdated ? new Date(lastUpdated).toISOString() : undefined,
      lastUpdated: lastUpdated || undefined,
    };
    return c.json(createSuccessResponse(data));
  });
}

export function attachRestartDaemon(app: Hono<{ Bindings: Bindings; Variables: Variables }>) {
  app.post("/:instanceId/system/restart", async (c) => {
    try {
      const instanceId = c.req.param("instanceId");
      const clusterId = c.req.query("clusterId")!;
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
        clusterId,
        instanceId,
        force,
      });

      return c.json(
        createSuccessResponse({
          status: "accepted",
          taskId,
          message: force ? "Restart daemon task with force mode sent" : "Restart daemon task sent",
        }),
        SUCCESS.ACCEPTED.status,
      );
    } catch (error) {
      return handleInstanceError(c, error, "Failed to send system restart daemon task");
    }
  });
}
