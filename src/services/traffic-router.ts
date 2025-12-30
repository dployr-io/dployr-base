// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";

/**
 * Traffic routing configuration
 */
export interface RouterConfig {
  /** Base domain for routing (e.g., "dployr.io") */
  baseDomain: string;
  /** Default port for proxying to instances */
  defaultPort: number;
  /** Cache TTL for route lookups in seconds */
  cacheTtlSeconds: number;
}

/**
 * Resolved route information
 */
export interface ResolvedRoute {
  serviceName: string;
  clusterName: string;
  instanceAddress: string;
  instancePort: number;
  serviceId: string;
  instanceId: string;
}

/**
 * Traffic router service for routing requests based on wildcard subdomains.
 * 
 * Routes traffic using pattern: service-name.cluster-name.{baseDomain}
 * Example: my-api.production.dployr.io -> instance IP running "my-api" service
 */
export class TrafficRouter {
  private config: RouterConfig;
  private routeCache: Map<string, { route: ResolvedRoute | null; expiresAt: number }> = new Map();

  constructor(
    private db: DatabaseStore,
    private kv: KVStore,
    config?: Partial<RouterConfig>
  ) {
    this.config = {
      baseDomain: config?.baseDomain ?? "dployr.io",
      defaultPort: config?.defaultPort ?? 80,
      cacheTtlSeconds: config?.cacheTtlSeconds ?? 30,
    };
  }

  /**
   * Parse hostname to extract service and cluster names
   * Format: service-name.cluster-name.dployr.io
   */
  parseHostname(hostname: string): { serviceName: string; clusterName: string } | null {
    const baseDomain = this.config.baseDomain.toLowerCase();
    const host = hostname.toLowerCase();

    // Check if hostname ends with base domain
    if (!host.endsWith(`.${baseDomain}`)) {
      return null;
    }

    // Remove base domain suffix
    const subdomain = host.slice(0, -(baseDomain.length + 1));
    
    // Split into parts (service.cluster)
    const parts = subdomain.split(".");
    
    if (parts.length !== 2) {
      return null;
    }

    const [serviceName, clusterName] = parts;

    // Validate names (alphanumeric, hyphens, underscores)
    const validName = /^[a-z0-9][a-z0-9_-]*[a-z0-9]$|^[a-z0-9]$/;
    if (!validName.test(serviceName) || !validName.test(clusterName)) {
      return null;
    }

    return { serviceName, clusterName };
  }

  /**
   * Resolve a hostname to its target instance
   */
  async resolveRoute(hostname: string): Promise<ResolvedRoute | null> {
    const parsed = this.parseHostname(hostname);
    if (!parsed) {
      return null;
    }

    const cacheKey = `${parsed.serviceName}.${parsed.clusterName}`;

    // Check cache first
    const cached = this.routeCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.route;
    }

    // Look up route from database
    const route = await this.lookupRoute(parsed.serviceName, parsed.clusterName);

    // Cache the result (even null results to prevent repeated lookups)
    this.routeCache.set(cacheKey, {
      route,
      expiresAt: Date.now() + this.config.cacheTtlSeconds * 1000,
    });

    return route;
  }

  /**
   * Look up route from database using optimized single-query validation
   */
  private async lookupRoute(
    serviceName: string,
    clusterName: string
  ): Promise<ResolvedRoute | null> {
    try {
      // Use the optimized validation method that does a single JOIN query
      const validation = await this.db.clusters.validateServiceCluster?.(
        serviceName,
        clusterName
      );

      if (validation?.valid) {
        return {
          serviceName,
          clusterName,
          instanceAddress: validation.instanceAddress!,
          instancePort: this.config.defaultPort,
          serviceId: validation.serviceId!,
          instanceId: validation.instanceId!,
        };
      }

      // Fall back to step-by-step lookup if validateServiceCluster not available
      return this.lookupRouteStepByStep(serviceName, clusterName);
    } catch (error) {
      console.error(`[TrafficRouter] Error looking up route: ${error}`);
      return null;
    }
  }

  /**
   * Fallback lookup using step-by-step queries
   * Used when validateServiceCluster is not available
   */
  private async lookupRouteStepByStep(
    serviceName: string,
    clusterName: string
  ): Promise<ResolvedRoute | null> {
    try {
      // Get service by name
      const service = await this.db.services.getByName(serviceName);
      if (!service) {
        console.debug(`[TrafficRouter] Service not found: ${serviceName}`);
        return null;
      }

      // Get the instance
      const instance = await this.db.instances.get(service.instanceId);
      if (!instance) {
        console.debug(`[TrafficRouter] Instance not found for service: ${serviceName}`);
        return null;
      }

      // Verify the instance belongs to the correct cluster
      // This requires the cluster relationship - try getByInstanceId if available
      const cluster = await this.db.clusters.getByInstanceId?.(instance.id);
      
      if (cluster && cluster.name.toLowerCase() !== clusterName.toLowerCase()) {
        console.debug(
          `[TrafficRouter] Cluster mismatch: expected ${clusterName}, got ${cluster.name}`
        );
        return null;
      }

      return {
        serviceName,
        clusterName,
        instanceAddress: instance.address,
        instancePort: this.config.defaultPort,
        serviceId: service.id,
        instanceId: instance.id,
      };
    } catch (error) {
      console.error(`[TrafficRouter] Error in step-by-step lookup: ${error}`);
      return null;
    }
  }

  /**
   * Invalidate cache for a specific route
   */
  invalidateRoute(serviceName: string, clusterName: string): void {
    const cacheKey = `${serviceName}.${clusterName}`;
    this.routeCache.delete(cacheKey);
  }

  /**
   * Invalidate all cached routes for a cluster
   */
  invalidateCluster(clusterName: string): void {
    for (const key of this.routeCache.keys()) {
      if (key.endsWith(`.${clusterName}`)) {
        this.routeCache.delete(key);
      }
    }
  }

  /**
   * Clear all cached routes
   */
  clearCache(): void {
    this.routeCache.clear();
  }

  /**
   * Get router statistics
   */
  getStats(): { cacheSize: number; baseDomain: string } {
    return {
      cacheSize: this.routeCache.size,
      baseDomain: this.config.baseDomain,
    };
  }
}
