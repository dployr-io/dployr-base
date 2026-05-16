// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { TraefikService } from "@/services/traefik-router.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("traefik-metrics-scraper");

const MS_HOUR = 60 * 60 * 1000;
const PRUNE_AFTER_MS = 90 * 24 * MS_HOUR;

interface TraefikCounters {
  requests: Record<string, number>;
  bytesIn: Record<string, number>;
  bytesOut: Record<string, number>;
}

export const traefikMetricsScraper: JobFn = async ({ db, kv, adapters, setOutput }) => {
  const cfg = adapters.config.traefik;
  if (!cfg?.enabled || !cfg.metrics_url) {
    log.debug("traefik.metrics_url not configured — skipping metrics scrape");
    return;
  }

  const traefik = new TraefikService(
    cfg.tld ?? "dployr.run",
    adapters.traefikRedis,
    adapters.config.server.base_url,
    cfg.metrics_url,
  );

  const samples = await traefik.scrapeMetrics();

  if (!samples || samples.length === 0) {
    setOutput({ scraped: 0 });
    return;
  }

  const prevStr = await kv.kv.get(KV_KEYS.METRICS.TRAEFIK_COUNTERS);
  const prev: TraefikCounters = prevStr ? JSON.parse(prevStr) : { requests: {}, bytesIn: {}, bytesOut: {} };

  const now = Date.now();
  const bucket = Math.floor(now / MS_HOUR) * MS_HOUR;

  const rows: { serviceName: string; bucket: number; requests: number; bytesIn: number; bytesOut: number }[] = [];

  for (const s of samples) {
    const deltaReq = Math.max(0, s.requests - (prev.requests[s.serviceName] ?? 0));
    const deltaIn = Math.max(0, s.bytesIn - (prev.bytesIn[s.serviceName] ?? 0));
    const deltaOut = Math.max(0, s.bytesOut - (prev.bytesOut[s.serviceName] ?? 0));

    if (deltaReq > 0 || deltaIn > 0 || deltaOut > 0) {
      rows.push({ serviceName: s.serviceName, bucket, requests: deltaReq, bytesIn: deltaIn, bytesOut: deltaOut });
    }
  }

  const next: TraefikCounters = {
    requests: Object.fromEntries(samples.map((s) => [s.serviceName, s.requests])),
    bytesIn: Object.fromEntries(samples.map((s) => [s.serviceName, s.bytesIn])),
    bytesOut: Object.fromEntries(samples.map((s) => [s.serviceName, s.bytesOut])),
  };
  await kv.kv.put(KV_KEYS.METRICS.TRAEFIK_COUNTERS, JSON.stringify(next));

  if (rows.length > 0) {
    await db.serviceMetrics.addMetrics(rows);
    await Promise.all(
      rows
        .filter((r) => r.requests > 0)
        .map((r) => kv.kv.put(KV_KEYS.SERVICE.LAST_ACTIVE(r.serviceName), String(now))),
    );
  }

  await db.serviceMetrics.prune(now - PRUNE_AFTER_MS);

  setOutput({ scraped: rows.length, services: rows.map((r) => r.serviceName) });
  log.debug(`Scraped ${rows.length} service metric deltas`);
};
