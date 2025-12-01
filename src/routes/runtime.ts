// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types";
import { authMiddleware } from "@/middleware/auth";
import { KVStore } from "@/lib/db/store/kv";
import { ERROR } from "@/lib/constants";
import { getKV, type AppVariables } from "@/lib/context";

type EventsFilters = {
  type?: string;
  search?: string;
  sort?: "newest" | "oldest";
  window?: "all" | "24h" | "7d" | "30d";
};

const runtime = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();
runtime.use("*", authMiddleware);

runtime.get("/events", async (c) => {
  const kv = new KVStore(getKV(c));
  const session = c.get("session")!;
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

    const filters: EventsFilters = {
      type: c.req.query("type") || undefined,
      search: c.req.query("search") || undefined,
      sort: (c.req.query("sort") as EventsFilters["sort"]) || "newest",
      window: (c.req.query("window") as EventsFilters["window"]) || "all",
    };

    const now = Date.now();
    const windowMs =
      filters.window === "24h" ? 24 * 60 * 60 * 1000 :
      filters.window === "7d" ? 7 * 24 * 60 * 60 * 1000 :
      filters.window === "30d" ? 30 * 24 * 60 * 60 * 1000 :
      null;

    let filteredEvents = events;

    if (filters.type) {
      filteredEvents = filteredEvents.filter((event: any) => event.type === filters.type);
    }

    if (filters.search) {
      const term = filters.search.toLowerCase();
      filteredEvents = filteredEvents.filter((event: any) =>
        JSON.stringify(event).toLowerCase().includes(term),
      );
    }

    if (windowMs !== null) {
      filteredEvents = filteredEvents.filter((event: any) =>
        typeof event.timestamp === "number" && event.timestamp >= now - windowMs,
      );
    }

    if (filters.sort === "oldest") {
      filteredEvents = [...filteredEvents].sort((a: any, b: any) => a.timestamp - b.timestamp);
    }

    const { page, pageSize, offset } = parsePaginationParams(
      c.req.query("page"),
      c.req.query("pageSize"),
    );

    const paginatedEvents = filteredEvents.slice(offset, offset + pageSize);
    const paginatedData = createPaginatedResponse(paginatedEvents, page, pageSize, filteredEvents.length);

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
