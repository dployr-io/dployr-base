// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { RedisKV } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

const WAKEUP_MIDDLEWARE = "hobby-wakeup";

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
  ) {
    this.redis = new RedisKV(redisClient);
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
