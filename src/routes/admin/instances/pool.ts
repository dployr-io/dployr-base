// pool.routes.ts
import { Hono } from "hono";
import { Bindings, Variables, createErrorResponse, createSuccessResponse } from "@/types/index.js";
import { getDbStore } from "@/lib/config/context.js";
import { DatabaseConflictError, ResourceNotFoundError } from "@/lib/errors/errors.js";
import { ERROR, INSTANCE_REGIONS } from "@/lib/constants/index.js";
import { z } from "zod";

const addPoolInstanceSchema = z.object({
  address: z.string().regex(/^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/, "Address must be a valid IPv4 address"),
  tag: z.string().min(3, "Tag with a minimum of 3 characters is required").max(15, "Tag must be a maximum of 15 characters"),
  capacity: z.number().int().positive(),
  region: z.enum(INSTANCE_REGIONS).optional(),
});

export const pool = new Hono<{ Bindings: Bindings; Variables: Variables }>();

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
    const instance = await db.instancePool.addToPool({ address, tag, region, capacity });
    return c.json(createSuccessResponse({ instance }));
  } catch (error) {
    if (error instanceof DatabaseConflictError) {
      return c.json(createErrorResponse({ message: "Instance with that address or tag already exists", code: ERROR.RESOURCE.CONFLICT.code }), ERROR.RESOURCE.CONFLICT.status);
    }
    throw error;
  }
});

// Remove instance from pool 
pool.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const db = getDbStore(c);

  try {
    await db.instancePool.removeFromPool(id);
    return c.json(createSuccessResponse({ deleted: id }));
  } catch (error) {
    if (error instanceof ResourceNotFoundError) {
      return c.json(createErrorResponse({ message: "Instance not found in pool", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }
    throw error;
  }
});

// Update instance status
pool.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const { status } = await c.req.json();

  if (!["active", "paused"].includes(status)) {
    return c.json(
      createErrorResponse({
        message: "Status must be either 'active' or 'paused'",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const db = getDbStore(c);

  try {
    await db.instancePool.updateStatus(id, status);
    return c.json(createSuccessResponse({ id, status }));
  } catch (error) {
    if (error instanceof ResourceNotFoundError) {
      return c.json(createErrorResponse({ message: "Instance not found in pool", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
    }
    throw error;
  }
});
