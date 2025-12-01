// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { cors } from "hono/cors";
import { Bindings, Variables } from "@/types";
import auth from "@/routes/auth";
import instances from "@/routes/instances";
import integrations from "@/routes/integrations";
import { initializeDatabase } from "@/lib/db/migrate";
import clusters from "@/routes/clusters";
import deployments from "@/routes/deployments";
import users from "@/routes/users";
import runtime from "@/routes/runtime";
import jwks from "@/routes/jwks";
import domains from "@/routes/domains";
import agent from "@/routes/agent";
import notifications from "./routes/notifications";
import { globalRateLimit } from "@/middleware/ratelimit";
import type { AppVariables } from "@/lib/context";

const app = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

// Initialize database and inject adapters on first request
let dbInitialized = false;
app.use("*", async (c, next) => {
  if (!dbInitialized) {
    await initializeDatabase(c.env.BASE_DB);
    dbInitialized = true;
  }
  
  // Inject Cloudflare adapters into context
  // These wrap the native bindings in a consistent interface
  c.set('kvAdapter', {
    get: (key: string) => c.env.BASE_KV.get(key),
    put: (key: string, value: string, options?: { expirationTtl?: number }) => 
      c.env.BASE_KV.put(key, value, options),
    delete: (key: string) => c.env.BASE_KV.delete(key),
    list: async (options: { prefix: string; limit?: number }) => {
      const result = await c.env.BASE_KV.list(options);
      return result.keys;
    },
  });
  
  c.set('dbAdapter', c.env.BASE_DB);
  
  c.set('storageAdapter', {
    put: async (key: string, value: ReadableStream | ArrayBuffer | string) => {
      await c.env.INSTANCE_LOGS.put(key, value);
    },
    get: async (key: string) => {
      const obj = await c.env.INSTANCE_LOGS.get(key);
      return obj?.body || null;
    },
    delete: async (key: string) => {
      await c.env.INSTANCE_LOGS.delete(key);
    },
    list: async (options?: { prefix?: string }) => {
      const result = await c.env.INSTANCE_LOGS.list(options);
      return result.objects.map((obj: any) => ({ key: obj.key }));
    },
  });
  
  await next();
});

// Global rate limiting (100 req/min per user)
app.use("/v1/*", globalRateLimit);

// CORS
app.use(
  "/v1/*",
  cors({
    origin: (origin) => {
      const allowedOrigins = [
        "https://app.dployr.dev",
        "https://api-docs.dployr.dev"
      ];
      return allowedOrigins.includes(origin) ? origin : null;
    },
    credentials: true,
    allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "X-Requested-With"],
  })
);

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
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

export default app;
export { InstanceObject } from "@/durable/instance";
