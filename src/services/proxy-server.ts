// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { createServer, IncomingMessage, ServerResponse } from "http";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { TrafficRouter, ResolvedRoute } from "@/services/traffic-router.js";
import { loadConfig } from "@/lib/config/loader.js";
import { createDatabaseFromConfig, createKVFromConfig } from "@/lib/config/adapters.js";

/**
 * Proxy server configuration
 */
export interface ProxyServerConfig {
  /** Port to listen on */
  port: number;
  /** Host to bind to */
  host: string;
  /** Base domain for routing */
  baseDomain: string;
  /** Request timeout in milliseconds */
  timeoutMs: number;
}

const DEFAULT_PROXY_CONFIG: ProxyServerConfig = {
  port: 8080,
  host: "0.0.0.0",
  baseDomain: "dployr.io",
  timeoutMs: 30000,
};

/**
 * Standalone proxy server for routing traffic to services
 * 
 * This server handles wildcard domain routing:
 * service-name.cluster-name.dployr.io -> instance address
 */
export class ProxyServer {
  private server: ReturnType<typeof createServer> | null = null;
  private router: TrafficRouter;
  private config: ProxyServerConfig;

  constructor(
    private db: DatabaseStore,
    private kv: KVStore,
    config?: Partial<ProxyServerConfig>
  ) {
    this.config = { ...DEFAULT_PROXY_CONFIG, ...config };
    this.router = new TrafficRouter(db, kv, {
      baseDomain: this.config.baseDomain,
    });
  }

  /**
   * Start the proxy server
   */
  async start(): Promise<void> {
    this.server = createServer(this.handleRequest.bind(this));

    return new Promise((resolve, reject) => {
      this.server!.listen(this.config.port, this.config.host, () => {
        console.log(
          `[ProxyServer] Listening on ${this.config.host}:${this.config.port}`
        );
        console.log(
          `[ProxyServer] Routing *.*.${this.config.baseDomain} traffic`
        );
        resolve();
      });

      this.server!.on("error", reject);
    });
  }

  /**
   * Stop the proxy server
   */
  async stop(): Promise<void> {
    if (!this.server) return;

    return new Promise((resolve) => {
      this.server!.close(() => {
        console.log("[ProxyServer] Stopped");
        resolve();
      });
    });
  }

  /**
   * Handle incoming HTTP request
   */
  private async handleRequest(
    req: IncomingMessage,
    res: ServerResponse
  ): Promise<void> {
    const startTime = Date.now();
    const hostname = req.headers.host ?? "";

    try {
      // Resolve the route
      const route = await this.router.resolveRoute(hostname);

      if (!route) {
        this.sendError(res, 404, "Service not found", {
          hostname,
          message: `No service found for ${hostname}`,
        });
        return;
      }

      // Proxy the request
      await this.proxyRequest(req, res, route);

      const duration = Date.now() - startTime;
      console.log(
        `[Proxy] ${req.method} ${hostname}${req.url} -> ${route.instanceAddress}:${route.instancePort} (${duration}ms)`
      );
    } catch (error) {
      console.error(`[Proxy] Error handling request: ${error}`);
      this.sendError(res, 502, "Proxy error", {
        message: "Failed to reach upstream service",
      });
    }
  }

  /**
   * Proxy request to the target instance
   */
  private async proxyRequest(
    req: IncomingMessage,
    res: ServerResponse,
    route: ResolvedRoute
  ): Promise<void> {
    const targetUrl = `http://${route.instanceAddress}:${route.instancePort}${req.url}`;

    // Build headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
      if (value && !this.isHopByHopHeader(key)) {
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
      }
    }

    // Set forwarding headers
    headers["Host"] = `${route.instanceAddress}:${route.instancePort}`;
    headers["X-Forwarded-Host"] = req.headers.host ?? "";
    headers["X-Forwarded-Proto"] = "https";
    headers["X-Forwarded-For"] =
      req.headers["x-forwarded-for"]?.toString() ??
      req.socket.remoteAddress ??
      "";
    headers["X-Dployr-Service"] = route.serviceName;
    headers["X-Dployr-Cluster"] = route.clusterName;
    headers["X-Dployr-Instance-Id"] = route.instanceId;

    // Collect request body
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);

    // Make the proxied request
    const controller = new AbortController();
    const timeoutId = setTimeout(
      () => controller.abort(),
      this.config.timeoutMs
    );

    try {
      const response = await fetch(targetUrl, {
        method: req.method ?? "GET",
        headers,
        body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
        signal: controller.signal,
      });

      // Write response status and headers
      res.writeHead(response.status, response.statusText, 
        Object.fromEntries(response.headers.entries())
      );

      // Stream response body
      if (response.body) {
        const reader = response.body.getReader();
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      }
      res.end();
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Check if header is hop-by-hop (should not be forwarded)
   */
  private isHopByHopHeader(header: string): boolean {
    const hopByHop = [
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
    ];
    return hopByHop.includes(header.toLowerCase());
  }

  /**
   * Send error response
   */
  private sendError(
    res: ServerResponse,
    status: number,
    message: string,
    details?: Record<string, unknown>
  ): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        success: false,
        error: {
          message,
          code: status === 404 ? "SERVICE_NOT_FOUND" : "PROXY_ERROR",
          ...details,
        },
      })
    );
  }

  /**
   * Get server statistics
   */
  getStats(): { listening: boolean; config: ProxyServerConfig; router: ReturnType<TrafficRouter["getStats"]> } {
    return {
      listening: this.server?.listening ?? false,
      config: this.config,
      router: this.router.getStats(),
    };
  }
}

/**
 * Start the proxy server as a standalone process
 */
export async function startProxyServer(
  config?: Partial<ProxyServerConfig>
): Promise<ProxyServer> {
  const appConfig = loadConfig();
  
  // Initialize database and KV
  const dbAdapter = await createDatabaseFromConfig(appConfig);
  const kvAdapter = await createKVFromConfig(appConfig);
  
  const db = new DatabaseStore(dbAdapter);
  const kv = new KVStore(kvAdapter, appConfig.integrations?.github_token);

  const proxyConfig: Partial<ProxyServerConfig> = {
    ...config,
    baseDomain: appConfig.proxy?.base_domain ?? config?.baseDomain ?? "dployr.io",
    port: appConfig.proxy?.port ?? config?.port ?? 8080,
  };

  const server = new ProxyServer(db, kv, proxyConfig);
  await server.start();

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[ProxyServer] Shutting down...");
    await server.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  return server;
}

// Run if this is the main module
const isMainModule = import.meta.url === `file://${process.argv[1]}`;
if (isMainModule) {
  startProxyServer().catch((error) => {
    console.error("[ProxyServer] Failed to start:", error);
    process.exit(1);
  });
}
