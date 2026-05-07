// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { RedisKV } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

/**
 * Service for managing Traefik routing rules in a separate Redis instance.
 * Writes routing configuration that Traefik instances poll and apply.
 */
export class TraefikService {
  private redis: RedisKV;

  constructor(
    private baseDomain: string,
    redisClient: any,
  ) {
    this.redis = new RedisKV(redisClient);
  }

  /**
   * Registers a route with Traefik.
   * Writes routing rules to Redis in the format Traefik expects.
   *
   * @param serviceName - The service name (e.g., "my-api")
   * @param instanceAddress - The instance private IP to route to
   * @param instancePort - The port on the instance (typically 80)
   */
  async registerRoute({
    serviceName,
    instanceAddress,
    instancePort = 80,
  }: {
    serviceName: string;
    instanceAddress: string;
    instancePort?: number;
  }): Promise<void> {
    const routeKey = serviceName;
    const hostname = `${serviceName}.${this.baseDomain}`;
    const backendUrl = `http://${instanceAddress}:${instancePort}`;

    await Promise.all([
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_RULE(routeKey), `Host(\`${hostname}\`)`),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS(routeKey), "websecure"),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_SERVICE(routeKey), routeKey),
      this.redis.put(KV_KEYS.TRAEFIK.SERVICE_URL(routeKey), backendUrl),
    ]);
  }

  /**
   * Unregisters a route from Traefik.
   * Deletes all routing rules associated with the service.
   *
   * @param serviceName - The service name
   */
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
    ]);
  }
}
