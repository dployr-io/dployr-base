// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import type { Context, HonoRequest } from "hono";
import { TrafficRouter, ResolvedRoute } from "@/services/traffic-router.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import type { Bindings, Variables } from "@/types/index.js";

export interface ProxyConfig {
  /** Base domain for routing */
  baseDomain: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
  /** Whether to forward original headers */
  forwardHeaders: boolean;
  /** Headers to strip from forwarded requests */
  stripHeaders: string[];
  /** Custom headers to add to proxied requests */
  addHeaders: Record<string, string>;
}

const DEFAULT_CONFIG: ProxyConfig = {
  baseDomain: "dployr.io",
  timeoutMs: 30000,
  forwardHeaders: true,
  stripHeaders: ["host", "connection", "keep-alive", "transfer-encoding"],
  addHeaders: {
    "X-Forwarded-By": "dployr-proxy",
  },
};

/**
 * Create a proxy handler for routing traffic to services
 */
export function createProxyHandler(config?: Partial<ProxyConfig>) {
  const proxyConfig: ProxyConfig = { ...DEFAULT_CONFIG, ...config };
  
  return async function proxyHandler(
    c: Context<{ Bindings: Bindings; Variables: Variables }>,
    router: TrafficRouter
  ): Promise<Response> {
    const hostname = c.req.header("host") ?? "";
    
    // Resolve the route
    const route = await router.resolveRoute(hostname);
    
    if (!route) {
      return c.json(
        {
          success: false,
          error: {
            message: "Service not found",
            code: "SERVICE_NOT_FOUND",
          },
        },
        404
      );
    }

    // Build target URL
    const targetUrl = buildTargetUrl(c.req.url, route, proxyConfig);

    // Build headers
    const headers = buildProxyHeaders(c.req, route, proxyConfig);

    try {
      // Proxy the request
      const response = await proxyRequest(
        c.req.method,
        targetUrl,
        headers,
        c.req.raw.body,
        proxyConfig.timeoutMs
      );

      return response;
    } catch (error) {
      console.error(`[Proxy] Error proxying request: ${error}`);
      
      return c.json(
        {
          success: false,
          error: {
            message: "Failed to reach service",
            code: "PROXY_ERROR",
          },
        },
        502
      );
    }
  };
}

/**
 * Build the target URL for the proxied request
 */
function buildTargetUrl(
  originalUrl: string,
  route: ResolvedRoute,
  config: ProxyConfig
): string {
  const url = new URL(originalUrl);
  
  // Replace host with instance address
  url.hostname = route.instanceAddress;
  url.port = route.instancePort.toString();
  
  // Keep the path and query string
  return url.toString();
}

/**
 * Build headers for the proxied request
 */
function buildProxyHeaders(
  req: HonoRequest,
  route: ResolvedRoute,
  config: ProxyConfig
): Headers {
  const headers = new Headers();

  if (config.forwardHeaders) {
    // Copy original headers
    for (const [key, value] of Object.entries(req.header() as Record<string, string>)) {
      const lowerKey = key.toLowerCase();
      if (!config.stripHeaders.includes(lowerKey)) {
        headers.set(key, value);
      }
    }
  }

  // Set Host header to target
  headers.set("Host", `${route.instanceAddress}:${route.instancePort}`);

  // Add X-Forwarded headers
  headers.set("X-Forwarded-Host", req.header("host") ?? "");
  headers.set("X-Forwarded-Proto", new URL(req.url).protocol.replace(":", ""));
  headers.set("X-Forwarded-For", req.header("cf-connecting-ip") ?? 
    req.header("x-real-ip") ?? "unknown");

  // Add custom headers
  for (const [key, value] of Object.entries(config.addHeaders)) {
    headers.set(key, value);
  }

  // Add routing context headers
  headers.set("X-Dployr-Service", route.serviceName);
  headers.set("X-Dployr-Cluster", route.clusterName);
  headers.set("X-Dployr-Instance-Id", route.instanceId);

  return headers;
}

/**
 * Execute the proxied request
 */
async function proxyRequest(
  method: string,
  url: string,
  headers: Headers,
  body: ReadableStream<Uint8Array> | null,
  timeoutMs: number
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: method !== "GET" && method !== "HEAD" ? body : undefined,
      signal: controller.signal,
      // @ts-ignore - duplex is needed for streaming bodies
      duplex: "half",
    });

    // Create response with original headers
    const responseHeaders = new Headers(response.headers);
    
    // Add proxy headers to response
    responseHeaders.set("X-Proxied-By", "dployr");

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Create the proxy routes for Hono
 */
export function createProxyRoutes(
  db: DatabaseStore,
  kv: KVStore,
  config?: Partial<ProxyConfig>
): Hono<{ Bindings: Bindings; Variables: Variables }> {
  const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();
  
  const router = new TrafficRouter(db, kv, {
    baseDomain: config?.baseDomain ?? "dployr.io",
  });

  const handler = createProxyHandler(config);

  // Catch-all route for proxying
  app.all("*", async (c) => {
    return handler(c, router);
  });

  return app;
}
