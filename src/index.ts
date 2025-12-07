// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Bindings, Variables } from "@/types/index.js";
import { initializeDatabase } from "@/lib/db/migrate.js";
import type { IncomingMessage } from "http";
import type { Socket } from "net";
import { Buffer } from "buffer";
import type { WebSocket } from "ws";

// Routes
import auth from "@/routes/auth.js";
import instances from "@/routes/instances.js";
import integrations from "@/routes/integrations.js";
import clusters from "@/routes/clusters.js";
import deployments from "@/routes/deployments.js";
import users from "@/routes/users.js";
import runtime from "@/routes/runtime.js";
import jwks from "@/routes/jwks.js";
import domains from "@/routes/domains.js";
import agent from "@/routes/agent.js";
import notifications from "./routes/notifications.js";
import { globalRateLimit } from "@/middleware/ratelimit.js";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const VERSION = process.env.BASE_VERSION || "unknown";

const isNode = typeof process !== 'undefined' && process.versions?.node;

let adapters: any = null;

app.use("*", async (c, next) => {
  if (!adapters) {
    const { loadConfig } = await import('@/lib/config/loader.js');
    const { initializeFromConfig } = await import('@/lib/config/adapters.js');
    
    const config = loadConfig();
    adapters = await initializeFromConfig(config);
    
    if (config.database.auto_migrate) {
      await initializeDatabase(adapters.db);
    }
    
    console.log("Dployr Base initialized");
  }

  // Inject adapters into context
  c.set('kvAdapter', adapters.kv);
  c.set('dbAdapter', adapters.db);
  c.set('storageAdapter', adapters.storage);
  c.set('wsHandler', adapters.ws);
  
  c.env = {
    BASE_URL: process.env.BASE_URL || '',
    EMAIL_FROM: process.env.EMAIL_FROM || '',
    ZEPTO_API_KEY: process.env.ZEPTO_API_KEY || '',
    GITHUB_APP_ID: process.env.GITHUB_APP_ID || '',
    GITHUB_APP_PRIVATE_KEY: process.env.GITHUB_APP_PRIVATE_KEY || '',
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || '',
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || '',
    CORS_ALLOWED_ORIGINS: process.env.CORS_ALLOWED_ORIGINS || '',
  } as unknown as Bindings;
  
  await next();
});

// Global rate limiting
app.use("/v1/*", globalRateLimit);

// CORS
app.use(
  "/v1/*",
  cors({
    origin: (origin, c) => {
      const raw = adapters?.config?.cors?.allowed_origins || process.env.CORS_ALLOWED_ORIGINS;
      if (!raw) {
        console.error("CORS allowed origins are not configured; refusing cross-origin requests.");
        console.error("Debug: adapters.config.cors =", JSON.stringify(adapters?.config?.cors));
        console.error("Debug: process.env.CORS_ALLOWED_ORIGINS =", process.env.CORS_ALLOWED_ORIGINS);
        return null;
      }

      if (!origin) {
        console.warn("CORS check received request with no Origin header; skipping CORS.");
        return null;
      }

      const patterns = raw
        .split(",")
        .map((o: string) => o.trim())
        .filter((o: string) => o.length > 0);

      // Always allow *.dployr.io by default
      if (!patterns.includes("*.dployr.io")) {
        patterns.push("*.dployr.io");
      }

      const host = origin
        .replace(/^https?:\/\//, "")
        .replace(/\/.*$/, "");

      const isAllowed = patterns.some((pattern: string) => {
        if (pattern.startsWith("*.") && pattern.length > 2) {
          const domain = pattern.slice(2);
          return host === domain || host.endsWith(`.${domain}`);
        }

        const normalizedPatternHost = pattern
          .replace(/^https?:\/\//, "")
          .replace(/\/.*$/, "");
        return host === normalizedPatternHost;
      });

      if (!isAllowed) {
        console.warn(`CORS origin not allowed: ${origin}`);
        return null;
      }

      return origin;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

// Routes
app.route("/v1/auth", auth);
app.route("/v1/users", users);
app.route("/v1/instances", instances);
app.route("/v1/clusters", clusters);
app.route("/v1/deployments", deployments);
app.route("/v1/integrations", integrations);
app.route("/v1/notifications", notifications);
app.route("/v1/runtime", runtime);
app.route("/v1/jwks", jwks);
app.route("/v1/domains", domains);
app.route("/v1/agent", agent);

app.get("/v1/health", (c) => {
  return c.json({ 
    status: "ok", 
    timestamp: new Date().toISOString(),
    version: VERSION,
  });
});

export default app;

// Node.js server
// In self-hosted mode (Node), always start the HTTP server.
// The previous guard comparing import.meta.url to process.argv[1]
// breaks on Windows due to path vs URL differences, so we only
// check that we're running under Node.
if (isNode) {
  const { createServer } = await import('http');
  const { loadConfig } = await import('@/lib/config/loader.js');
  const { WebSocketServer } = await import('ws');
  
  const config = loadConfig();
  
  // Create HTTP server to handle WebSocket upgrades
  const server = createServer(async (req, res) => {
    const upgradeHeader = req.headers['upgrade'];
    if (upgradeHeader && upgradeHeader.toLowerCase() === 'websocket') {
      console.log('WebSocket upgrade request detected, deferring to upgrade handler');
      return;
    }

    // Collect request body for non-GET/HEAD requests
    let body: Uint8Array | undefined;
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      const chunks: Uint8Array[] = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      body = Buffer.concat(chunks);
    }

    const response = await app.fetch(
      new Request(`http://${req.headers.host}${req.url}`, {
        method: req.method,
        headers: req.headers as any,
        body: body,
      })
    );

    res.statusCode = response.status;
    response.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    }
    res.end();
  });

  // WebSocket server for instance streaming
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', async (message: IncomingMessage, socket: Socket, head: Buffer) => {
    const url = new URL(message.url || '', `http://${message.headers.host}`);
    
    // Handle instance WebSocket streams
    // Matches: /v1/instances/{id}/stream OR /v1/agent/instances/{id}/ws
    if (url.pathname.match(/\/v1\/(instances\/[^\/]+\/stream|agent\/instances\/[^\/]+\/ws)$/)) {
      const pathParts = url.pathname.split('/');
      const instanceIdIndex = pathParts.indexOf('instances') + 1;
      const instanceId = pathParts[instanceIdIndex];
      
      if (!instanceId || !adapters?.ws) {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }

      // Determine role: agent daemon uses /ws, clients use /stream
      const role = url.pathname.includes('/ws') ? 'agent' : 'client';

      // Validate auth token for agent endpoint
      if (role === 'agent') {
        const authHeader = message.headers['authorization'] || message.headers['Authorization'];
        const auth = Array.isArray(authHeader) ? authHeader[0] : authHeader;
        if (!auth || !auth.startsWith('Bearer ')) {
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
      }

      wss.handleUpgrade(message, socket, head, (ws: WebSocket) => {
        adapters.ws.acceptWebSocket(instanceId, ws, role);
      });
    } else {
      socket.destroy();
    }
  });

  server.listen(config.server.port, config.server.host, () => {
    console.log(`Dployr Base running on http://${config.server.host}:${config.server.port}`);
  });
}
