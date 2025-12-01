// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * Unified entry point - works on Cloudflare AND self-hosted
 * Platform is auto-detected or configured via config.toml
 */

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Bindings, Variables } from "@/types";
import { KVStore } from "@/lib/db/store/kv";
import { D1Store } from "@/lib/db/store";
import { initializeDatabase } from "@/lib/db/migrate";

// Routes
import auth from "@/routes/auth";
import instances from "@/routes/instances";
import integrations from "@/routes/integrations";
import clusters from "@/routes/clusters";
import deployments from "@/routes/deployments";
import users from "@/routes/users";
import runtime from "@/routes/runtime";
import jwks from "@/routes/jwks";
import domains from "@/routes/domains";
import agent from "@/routes/agent";
import notifications from "./routes/notifications";
import { globalRateLimit } from "@/middleware/ratelimit";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Platform detection
const isCloudflare = typeof caches !== 'undefined';
const isNode = typeof process !== 'undefined' && process.versions?.node;

let dbInitialized = false;
let adapters: any = null;

/**
 * Initialize adapters based on platform
 */
app.use("*", async (c, next) => {
  // Cloudflare Workers - use bindings directly
  if (isCloudflare) {
    if (!dbInitialized) {
      await initializeDatabase(c.env.BASE_DB);
      dbInitialized = true;
    }
    await next();
    return;
  }

  // Self-hosted - load from config.toml
  if (!adapters) {
    const { loadConfig } = await import('@/lib/config/loader');
    const { initializeFromConfig } = await import('@/lib/config/adapters');
    
    const config = loadConfig();
    adapters = await initializeFromConfig(config);
    
    if (config.database.auto_migrate) {
      await initializeDatabase(adapters.db);
    }
    
    console.log(`Dployr Base initialized (${config.deployment.platform})`);
  }

  // Inject adapters into context
  c.set('kvAdapter', adapters.kv);
  c.set('dbAdapter', adapters.db);
  c.set('storageAdapter', adapters.storage);
  
  await next();
});

// Global rate limiting
app.use("/v1/*", globalRateLimit);

// CORS
app.use(
  "/v1/*",
  cors({
    origin: (origin) => {
      const allowedOrigins = [
        "https://app.dployr.dev",
        "https://api-docs.dployr.dev",
        "http://localhost:5173", // Dev
      ];
      return allowedOrigins.includes(origin) ? origin : null;
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
    platform: isCloudflare ? 'cloudflare' : 'self-hosted',
    timestamp: new Date().toISOString() 
  });
});

// Export for Cloudflare Workers
export default app;

// Export Durable Object (Cloudflare only)
export { InstanceObject } from "@/durable/instance";

// Node.js server (self-hosted)
if (isNode && import.meta.url === `file://${process.argv[1]}`) {
  const { serve } = await import('@hono/node-server');
  const { loadConfig } = await import('@/lib/config/loader');
  
  const config = loadConfig();
  
  serve({
    fetch: app.fetch,
    port: config.server.port,
    hostname: config.server.host,
  }, (info) => {
    console.log(`Dployr Base running on http://${info.address}:${info.port}`);
  });
}
