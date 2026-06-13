// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { stream } from "hono/streaming";
import type { Bindings, Variables } from "@/types/index.js";
import { authMiddleware } from "@/middleware/auth.js";
import { ERROR } from "@/lib/constants/index.js";
import { getLokiClient, getDbStore } from "@/lib/config/context.js";
import { fromNanoseconds } from "@/services/loki.js";
import { createErrorResponse } from "@/types/index.js";

const logs = new Hono<{ Bindings: Bindings; Variables: Variables }>();

logs.use("*", authMiddleware);

/**
 * Query Loki for logs by label. Supports batch (JSON array) and streaming (NDJSON) modes.
 *
 * Query params:
 *   clusterId   required  — scopes logs to the cluster the caller has access to
 *   serviceId   optional  — filter by service name
 *   source      optional  — "runtime" | "build" | "deploy" | "build|deploy"
 *   deploymentId optional — filter to a specific deployment run
 *   since       optional  — epoch ms start (default: 24h ago)
 *   until       optional  — epoch ms end (default: now)
 *   limit       optional  — max entries (default 1000, max 5000)
 *   follow      optional  — "true" to stream as NDJSON, polling every 2s
 *   direction   optional  — "forward" (default) | "backward"
 */
logs.get("/", async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);

  const clusterId = c.req.query("clusterId");
  if (!clusterId) {
    return c.json(createErrorResponse({ message: "clusterId is required", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const canRead = await db.clusters.canRead(session.userId, clusterId).catch(() => false);
  if (!canRead) {
    return c.json(createErrorResponse({ message: "Not a member of this cluster", code: ERROR.PERMISSION.FORBIDDEN.code }), ERROR.PERMISSION.FORBIDDEN.status);
  }

  const loki = getLokiClient(c);
  if (!loki || !loki.isEnabled) {
    return c.json(createErrorResponse({ message: "Centralized logs are not available on this server", code: "LOGS_NOT_AVAILABLE" }), 501);
  }

  const serviceId = c.req.query("serviceId");
  const rawSource = c.req.query("source");
  const deploymentId = c.req.query("deploymentId");
  const limitParam = parseInt(c.req.query("limit") ?? "1000", 10);
  const limit = isNaN(limitParam) || limitParam < 1 ? 1000 : Math.min(limitParam, 5000);
  const follow = c.req.query("follow") === "true" || c.req.query("follow") === "1";
  const direction = c.req.query("direction") === "backward" ? "backward" : "forward";

  const sinceMs = parseInt(c.req.query("since") ?? "0", 10) || Date.now() - 24 * 60 * 60 * 1000;
  const untilMs = parseInt(c.req.query("until") ?? "0", 10) || Date.now();

  const startNs = (BigInt(sinceMs) * 1_000_000n).toString();
  const endNs = (BigInt(untilMs) * 1_000_000n).toString();

  const labels: Record<string, string> = { clusterId };
  if (serviceId) labels.serviceId = serviceId;
  if (rawSource) labels.source = rawSource;
  if (deploymentId) labels.deploymentId = deploymentId;

  function entryToChunk(entry: { timestampNs: string; line: string; streamLabels?: Record<string, string> }) {
    const timestamp = fromNanoseconds(entry.timestampNs);
    const entrySource = entry.streamLabels?.source ?? rawSource ?? "unknown";
    let level = "info";
    let message = entry.line;
    try {
      const json = JSON.parse(entry.line);
      if (typeof json.msg === "string") message = json.msg;
      else if (typeof json.message === "string") message = json.message;
      if (typeof json.level === "string") {
        const l = json.level.toLowerCase();
        if (l.startsWith("warn")) level = "warn";
        else if (l.startsWith("err") || l.startsWith("fatal") || l.startsWith("crit")) level = "error";
      }
    } catch {
      // plain text line
    }
    return {
      timestamp,
      source: entrySource,
      level,
      message,
      serviceId: entry.streamLabels?.serviceId,
      deploymentId: entry.streamLabels?.deploymentId,
    };
  }

  if (!follow) {
    const result = await loki.query(labels as any, startNs, endNs, limit, direction);
    return c.json(result.entries.map(entryToChunk));
  }

  c.header("Content-Type", "application/x-ndjson");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Cache-Control", "no-cache");

  return stream(c, async (s) => {
    let cancelled = false;
    s.onAbort(() => { cancelled = true; });

    let cursor = startNs;
    let hasMore = true;
    while (hasMore && !cancelled) {
      const result = await loki.query(labels as any, cursor, endNs, 500, direction);
      for (const entry of result.entries) {
        if (cancelled) return;
        await s.write(JSON.stringify(entryToChunk(entry)) + "\n");
      }
      cursor = result.nextCursor;
      hasMore = result.hasMore;
    }

    while (!cancelled) {
      await new Promise((r) => setTimeout(r, 2000));
      if (cancelled) return;
      const nowNs = (BigInt(Date.now()) * 1_000_000n).toString();
      const result = await loki.query(labels as any, cursor, nowNs, 200, direction);
      for (const entry of result.entries) {
        if (cancelled) return;
        await s.write(JSON.stringify(entryToChunk(entry)) + "\n");
      }
      if (result.entries.length > 0) cursor = result.nextCursor;
    }
  });
});

export default logs;
