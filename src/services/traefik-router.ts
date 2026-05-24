// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { RedisKV } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { SERVICE_STUB_ADDRESS } from "@/lib/constants/index.js";

export interface TraefikMetricsSample {
  serviceName: string;
  requests: number;
  bytesIn: number;
  bytesOut: number;
}

export class TraefikService {
  private redis: RedisKV;

  constructor(
    private baseDomain: string,
    redisClient: any,
    private metricsUrl?: string,
  ) {
    this.redis = new RedisKV(redisClient);
  }

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

      const serviceMatch = labels.match(/service="([^"]+@redis)"/);
      if (!serviceMatch) continue;
      const name = serviceMatch[1].replace(/@redis$/, "");

      if (metricName === "traefik_service_requests_total") {
        requests.set(name, (requests.get(name) ?? 0) + value);
      } else if (metricName === "traefik_service_requests_bytes_total") {
        bytesIn.set(name, (bytesIn.get(name) ?? 0) + value);
      } else if (metricName === "traefik_service_responses_bytes_total") {
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

  async registerRoute({ serviceName, instanceAddress, instancePort = 80 }: { serviceName: string; instanceAddress: string; instancePort?: number }): Promise<void> {
    const hostname = `${serviceName}.${this.baseDomain}`;
    await Promise.all([
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_RULE(serviceName), `Host(\`${hostname}\`)`),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS(serviceName), "websecure"),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_SERVICE(serviceName), serviceName),
      this.redis.put(KV_KEYS.TRAEFIK.SERVICE_URL(serviceName), `http://${instanceAddress}:${instancePort}`),
    ]);
  }

  async setLoadingMode(serviceName: string): Promise<void> {
    await this.redis.put(KV_KEYS.TRAEFIK.SERVICE_URL(serviceName), SERVICE_STUB_ADDRESS);
  }

  async getRouteBackendUrl(serviceName: string): Promise<string | null> {
    return this.redis.get(KV_KEYS.TRAEFIK.SERVICE_URL(serviceName));
  }

  async unregisterRoute(serviceName: string): Promise<void> {
    await Promise.all([
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_RULE(serviceName)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS(serviceName)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_SERVICE(serviceName)),
      this.redis.delete(KV_KEYS.TRAEFIK.SERVICE_URL(serviceName)),
    ]);
  }

  async registerCustomDomain(domain: string, serviceName: string): Promise<void> {
    await Promise.all([
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_RULE(domain), `Host(\`${domain}\`)`),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS(domain), "websecure"),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_SERVICE(domain), serviceName),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_TLS(domain), "true"),
      this.redis.put(KV_KEYS.TRAEFIK.ROUTER_TLS_CERTRESOLVER(domain), "letsencrypt"),
    ]);
  }

  async unregisterCustomDomain(domain: string): Promise<void> {
    await Promise.all([
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_RULE(domain)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_ENTRYPOINTS(domain)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_SERVICE(domain)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_TLS(domain)),
      this.redis.delete(KV_KEYS.TRAEFIK.ROUTER_TLS_CERTRESOLVER(domain)),
    ]);
  }
}
