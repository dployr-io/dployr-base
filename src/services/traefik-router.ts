// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { RedisKV } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

const WAKEUP_MIDDLEWARE = "hobby-wakeup";

export interface TraefikMetricsSample {
  serviceName: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

/**
 * Service for managing Traefik routing rules in a separate Redis instance.
 * Writes routing configuration that Traefik instances poll and apply.
 */
export class TraefikService {
  private redis: RedisKV;

  constructor(
    private baseDomain: string,
    redisClient: any,
    private baseUrl?: string,
    private metricsUrl?: string,
  ) {
    this.redis = new RedisKV(redisClient);
  }

  /**
   * Fetches Traefik's Prometheus metrics endpoint and returns per-router
   * request/byte totals. Returns null if metrics_url is not configured or
   * the request fails.
   */
  async scrapeMetrics(): Promise<TraefikMetricsSample[] | null> {
    if (!this.metricsUrl) return null;

    const url = this.metricsUrl.replace(/\/$/, "") + "/metrics";
    let body: string;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      body = await res.text();
    } catch {
      return null;
    }

    return TraefikService.parseMetrics(body);
  }

  static parseMetrics(text: string): TraefikMetricsSample[] {
    const requests = new Map<string, number>();
    const bytesIn = new Map<string, number>();
    const bytesOut = new Map<string, number>();

    for (const line of text.split("\n")) {
      if (line.startsWith("#") || line.trim() === "") continue;

      const spaceIdx = line.lastIndexOf(" ");
      if (spaceIdx === -1) continue;
      const labelPart = line.slice(0, spaceIdx);
      const value = parseFloat(line.slice(spaceIdx + 1));
      if (isNaN(value)) continue;

      const braceOpen = labelPart.indexOf("{");
      if (braceOpen === -1) continue;
      const metricName = labelPart.slice(0, braceOpen);
      const labels = labelPart.slice(braceOpen + 1, -1);

      const routerMatch = labels.match(/router="([^"]+)"/);
      if (!routerMatch) continue;
      // Strip provider suffix: "my-service@redis" → "my-service"
      const name = routerMatch[1].replace(/@[^@]+$/, "");

      if (metricName === "traefik_router_requests_total") {
        requests.set(name, (requests.get(name) ?? 0) + value);
      } else if (metricName === "traefik_router_request_bytes_total") {
        bytesIn.set(name, (bytesIn.get(name) ?? 0) + value);
      } else if (metricName === "traefik_router_response_bytes_total") {
        bytesOut.set(name, (bytesOut.get(name) ?? 0) + value);
      }
    }

    return Array.from(requests.entries()).map(([serviceName, req]) => ({
      serviceName,
      requests: req,
      bytesIn: bytesIn.get(serviceName) ?? 0,
      bytesOut: bytesOut.get(serviceName) ?? 0,
    }));
  }

  /**
   * Writes the hobby-wakeup errors middleware to Redis once.
   * Traefik intercepts `502/503` from sleeping services and serves the loading page.
   * Safe to call multiple times — idempotent.
   */
  async ensureWakeupMiddleware(): Promise<void> {
    if (!this.baseUrl) return;
    const loadingServiceKey = "dployr-base";
    await Promise.all([
      // Point the "dployr-base" Traefik service at base
      this.redis.put(
        KV_KEYS.TRAEFIK.SERVICE_URL(loadingServiceKey),
        `${this.baseUrl}`,
      ),
      // Errors middleware definition
      this.redis.put(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_STATUS(WAKEUP_MIDDLEWARE), "502,503"),
      this.redis.put(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_SERVICE(WAKEUP_MIDDLEWARE), `${loadingServiceKey}@redis`),
      this.redis.put(KV_KEYS.TRAEFIK.MIDDLEWARE_ERRORS_QUERY(WAKEUP_MIDDLEWARE), "/loading.html"),
    ]);
  }

  /**
   * Registers a route with Traefik.
   * Writes routing rules to Redis in the format Traefik expects.
   *
   * @param serviceName     - The service name (e.g., "my-api")
   * @param instanceAddress - The instance private IP to route to
   * @param instancePort    - The port on the instance (typically 80)
   * @param hobby           - When true, attaches the wakeup errors middleware
   */
  async registerRoute({
    serviceName,
    instanceAddress,
    instancePort = 80,
    hobby = false,
  }: {
    serviceName: string;
    instanceAddress: string;
    instancePort?: number;
    hobby?: boolean;
  }): Promise<void> {
    const routeKey = serviceName;
    const hostname = `${serviceName}.${this.baseDomain}`;
    const backendUrl = `http://${instanceAddress}:${instancePort}`;

    const writes: Promise<void>[] = [
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_RULE(routeKey), `Host(\`${hostname}\`)`),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS(routeKey), "websecure"),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_SERVICE(routeKey), routeKey),
      this.redis.put(KV_KEYS.TRAEFIK.SERVICE_URL(routeKey), backendUrl),
    ];

    if (hobby) {
      await this.ensureWakeupMiddleware();
      writes.push(
        this.redis.put(KV_KEYS.TRAEFIK.ROUTER_MIDDLEWARE(routeKey, 0), WAKEUP_MIDDLEWARE),
      );
    }

    await Promise.all(writes);
  }

  /**
   * Returns the currently registered backend URL for a service, or null if not registered.
   * Used to detect missing or stale routes without doing a full re-register.
   */
  async getRouteBackendUrl(serviceName: string): Promise<string | null> {
    return this.redis.get(KV_KEYS.TRAEFIK.SERVICE_URL(serviceName));
  }

  async unregisterRoute(serviceName: string): Promise<void> {
    const routeKey = serviceName;

    await Promise.all([
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_RULE(routeKey)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS(routeKey)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_SERVICE(routeKey)),
      this.redis.delete(KV_KEYS.TRAEFIK.SERVICE_URL(routeKey)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_MIDDLEWARE(routeKey, 0)),
    ]);
  }
}
