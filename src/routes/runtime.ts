// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { authMiddleware, requireClusterViewer } from "@/middleware/auth.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { ERROR, LATEST_COMPATIBILITY_DATE } from "@/lib/constants/index.js";
import { getKV, type AppVariables } from "@/lib/context.js";
import { isCompatible, getUpgradeLevel } from "@/lib/version.js";
import { z } from "zod";

type EventsFilters = {
  type?: string;
  search?: string;
  sort?: "newest" | "oldest";
  window?: "all" | "24h" | "7d" | "30d";
};

const compatibilityCheckSchema = z.object({
  compatibilityDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Invalid date format. Expected YYYY-MM-DD"),
  version: z.string().optional(),
});

type GitHubRelease = {
  tag_name?: string;
  prerelease?: boolean;
  draft?: boolean;
  published_at?: string;
};

const runtime = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

// Public endpoint for version compatibility check (no auth required)
runtime.post("/compatibility/check", async (c) => {
  try {
    const body = await c.req.json();
    const validation = compatibilityCheckSchema.safeParse(body);

    if (!validation.success) {
      const errors = validation.error.issues.map((err) => ({
        field: err.path.join("."),
        message: err.message,
      }));
      return c.json(createErrorResponse({
        message: "Validation failed: " + errors.map(e => `${e.field}: ${e.message}`).join(", "),
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }), ERROR.REQUEST.BAD_REQUEST.status);
    }

    const { compatibilityDate, version } = validation.data;
    const compatible = isCompatible(compatibilityDate, LATEST_COMPATIBILITY_DATE);

    let latestVersion: string | undefined;
    try {
      const ghToken = (c.env.GITHUB_TOKEN || "").trim();
      const headers: Record<string, string> = {
        Accept: "application/vnd.github+json",
        "User-Agent": "dployr-base",
      };
      if (ghToken) {
        headers.Authorization = `Bearer ${ghToken}`;
      }

      const resp = await fetch("https://api.github.com/repos/dployr-io/dployr/releases/latest", {
        headers,
      });

      if (resp.ok) {
        const data = await resp.json() as { tag_name?: string };
        if (typeof data.tag_name === "string" && data.tag_name.length > 0) {
          latestVersion = data.tag_name;
        }
      } else {
        console.error("Failed to fetch latest daemon version from GitHub", resp.status, await resp.text());
      }
    } catch (err) {
      console.error("Error fetching latest daemon version from GitHub", err);
    }

    const upgradeLevel = latestVersion && version
      ? getUpgradeLevel(latestVersion, version)
      : "none";

    return c.json(createSuccessResponse({
      compatible,
      compatibilityDate,
      version,
      latestVersion,
      upgradeLevel,
      requiredCompatibilityDate: LATEST_COMPATIBILITY_DATE,
      message: compatible
        ? "dployrd is supported"
        : `dployrd requires compatibility_date ${LATEST_COMPATIBILITY_DATE} (received: ${compatibilityDate})`,
    }));
  } catch (error) {
    console.error("Failed to check compatibility", error);
    return c.json(createErrorResponse({
      message: "Failed to check compatibility",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

// Public endpoint to list available dployrd versions from GitHub releases
runtime.get("/versions", async (c) => {
  try {
    const showPreReleases = c.req.query("showPreReleases");
    const includePreReleases = showPreReleases === "true";

    const ghToken = (c.env.GITHUB_TOKEN || "").trim();
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "User-Agent": "dployr-base",
    };
    if (ghToken) {
      headers.Authorization = `Bearer ${ghToken}`;
    }

    const resp = await fetch("https://api.github.com/repos/dployr-io/dployr/releases", {
      headers,
    });

    if (!resp.ok) {
      console.error("Failed to fetch releases from GitHub", resp.status, await resp.text());
      return c.json(createErrorResponse({
        message: "Failed to fetch available versions",
        code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
    }

    const releases = await resp.json() as GitHubRelease[];

    const filtered = releases.filter((r) => {
      if (r.draft) return false;
      if (!includePreReleases && r.prerelease) return false;
      return typeof r.tag_name === "string" && r.tag_name.length > 0;
    });

    const versions = filtered.map((r) => r.tag_name!) as string[];
    const latest = versions[0] ?? null;
    const compatibilityCutoffTimestamp = Date.parse(`${LATEST_COMPATIBILITY_DATE}T00:00:00Z`);

    let oldestSupportedVersion: string | null = null;
    if (!Number.isNaN(compatibilityCutoffTimestamp)) {
      for (let i = filtered.length - 1; i >= 0; i -= 1) {
        const publishedAt = filtered[i].published_at;
        if (!publishedAt) continue;
        const publishedTimestamp = Date.parse(publishedAt);
        if (Number.isNaN(publishedTimestamp)) continue;
        if (publishedTimestamp >= compatibilityCutoffTimestamp) {
          oldestSupportedVersion = filtered[i].tag_name!;
          break;
        }
      }
    }

    if (!oldestSupportedVersion && versions.length > 0) {
      oldestSupportedVersion = versions[versions.length - 1];
    }

    return c.json(createSuccessResponse({
      latest,
      oldestSupportedVersion,
      versions,
      includePreReleases,
    }));
  } catch (error) {
    console.error("Failed to fetch available versions", error);
    return c.json(createErrorResponse({
      message: "Failed to fetch available versions",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

runtime.get("/events", authMiddleware, requireClusterViewer, async (c) => {
  const kv = new KVStore(getKV(c));
  const clusterId = c.req.query("clusterId");

  if (!clusterId) {
    return c.json(createErrorResponse({
      message: "clusterId is required",
      code: ERROR.REQUEST.MISSING_PARAMS.code,
    }), ERROR.REQUEST.MISSING_PARAMS.status);
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
    const helpLink = "https://monitoring.dployr.io";
    return c.json(createErrorResponse({
      message: "Failed to retrieve events",
      code: ERROR.RUNTIME.INTERNAL_SERVER_ERROR.code,
      helpLink,
    }), ERROR.RUNTIME.INTERNAL_SERVER_ERROR.status);
  }
});

export default runtime;
