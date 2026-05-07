// pool.routes.ts
import { Hono } from "hono";
import { z } from "zod";
import { Bindings, Variables, createErrorResponse, createPaginatedResponse, createSuccessResponse, parsePaginationParams } from "@/types/index.js";
import { getDbStore } from "@/lib/config/context.js";
import { DatabaseConflictError } from "@/lib/errors/errors.js";
import { ERROR } from "@/lib/constants/index.js";
import { INSTANCE_REGIONS } from "@/lib/constants/instances.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Admin/Pool");

const addPoolInstanceSchema = z.object({
  address: z.string().regex(/^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/, "Address must be a valid IPv4 address"),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters"),
  capacity: z.number().int().positive(),
  region: z.enum(INSTANCE_REGIONS).optional(),
});

export const pool = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Retrieve all instances in pool
pool.get("/", async (c) => {
  const db = getDbStore(c);
  const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));

  try {
    const [{ instances, total }, clusterMap] = await Promise.all([db.instances.list({ limit: pageSize, offset }), db.instances.getPoolClustersMap()]);

    const countByInstance = new Map<string, number>();
    for (const { instanceId } of clusterMap) {
      countByInstance.set(instanceId, (countByInstance.get(instanceId) ?? 0) + 1);
    }

    const enriched = instances.map((i) => ({ ...i, clusterCount: countByInstance.get(i.id) ?? 0 }));
    const paginated = createPaginatedResponse(enriched, page, pageSize, total);
    return c.json(createSuccessResponse({ data: paginated }));
  } catch (error: any) {
    log.error("Failed to list instance pools: ", error);
    if (error instanceof DatabaseConflictError) {
      return c.json(createErrorResponse({ message: "Instance with that address or tag already exists", code: ERROR.RESOURCE.CONFLICT.code }), ERROR.RESOURCE.CONFLICT.status);
    }
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Add instance to pool
pool.post("/", async (c) => {
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

  const { address, tag, region, capacity } = validation.data;
  const db = getDbStore(c);

  try {
    const instance = await db.instances.addPool({ address, tag, region, capacity, status: "healthy" });
    return c.json(createSuccessResponse({ instance }));
  } catch (error: any) {
    log.error("Failed to add instance pools: ", error);
    if (error instanceof DatabaseConflictError) {
      return c.json(createErrorResponse({ message: "Instance with that address or tag already exists", code: ERROR.RESOURCE.CONFLICT.code }), ERROR.RESOURCE.CONFLICT.status);
    }
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Remove instance from pool
pool.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDbStore(c);

  try {
    await db.instances.removePool(id);
    return c.json(createSuccessResponse({ deleted: id }));
  } catch (error: any) {
    log.error("Failed to remove instance from pools: ", error);
    if (error instanceof DatabaseConflictError) {
      return c.json(createErrorResponse({ message: "Instance with that address or tag already exists", code: ERROR.RESOURCE.CONFLICT.code }), ERROR.RESOURCE.CONFLICT.status);
    }
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Update instance status
pool.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const { status } = await c.req.json();

  if (!["healthy", "degraded", "offline", "provisioning"].includes(status)) {
    return c.json(
      createErrorResponse({
        message: "Status must be one of: healthy, degraded, offline, provisioning",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const db = getDbStore(c);

  try {
    await db.instances.update({ id }, { status });
    return c.json(createSuccessResponse({ id, status }));
  } catch (error: any) {
    log.error("Failed to update instance pools: ", error);
    if (error instanceof DatabaseConflictError) {
      return c.json(createErrorResponse({ message: "Instance with that address or tag already exists", code: ERROR.RESOURCE.CONFLICT.code }), ERROR.RESOURCE.CONFLICT.status);
    }
    return c.json(createErrorResponse({ message: error.message, code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});
