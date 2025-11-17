import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types";
import { authMiddleware } from "@/middleware/auth";
import { KVStore } from "@/lib/db/store/kv";
import { getCookie } from "hono/cookie";
import { ERROR } from "@/lib/constants";

const runtime = new Hono<{ Bindings: Bindings; Variables: Variables }>();
runtime.use("*", authMiddleware);

runtime.get("/events", async (c) => {
  const sessionId = getCookie(c, "session");

  if (!sessionId) {
    return c.json(createErrorResponse({
      message: "Not authenticated",
      code: ERROR.AUTH.BAD_SESSION.code,
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  const kv = new KVStore(c.env.BASE_KV);
  const session = await kv.getSession(sessionId);

  if (!session) {
    return c.json(createErrorResponse({
      message: "Invalid or expired session",
      code: ERROR.AUTH.BAD_SESSION.code,
    }), ERROR.AUTH.BAD_SESSION.status);
  }

  const clusterId = c.req.query("clusterId");

  if (!clusterId) {
    return c.json(createErrorResponse({
      message: "clusterId is required",
      code: ERROR.REQUEST.MISSING_PARAMS.code,
    }), ERROR.REQUEST.MISSING_PARAMS.status);
  }

  const hasAccessToCluster = session.clusters?.some((cluster) => cluster.id === clusterId);

  if (!hasAccessToCluster) {
    return c.json(createErrorResponse({
      message: "Insufficient permissions to view this cluster's events",
      code: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.code,
    }), ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.status);
  }

  try {
    const events = await kv.getClusterEvents(clusterId);

    const { page, pageSize, offset } = parsePaginationParams(
      c.req.query("page"),
      c.req.query("pageSize"),
    );

    const paginatedEvents = events.slice(offset, offset + pageSize);
    const paginatedData = createPaginatedResponse(paginatedEvents, page, pageSize, events.length);

    return c.json(createSuccessResponse(paginatedData));
  } catch (error) {
    console.error("Failed to retrieve events", error);
    const helpLink = "https://monitoring.dployr.dev";
    return c.json(createErrorResponse({
      message: "Failed to retrieve events",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink,
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default runtime;
