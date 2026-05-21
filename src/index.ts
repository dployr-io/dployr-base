// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Bindings, Variables } from "@/types/index.js";
import { Hono } from "hono";
import { WebSocketService } from "@/services/websocket/index.js";
import { worker } from "@/services/background/index.js";
import { registerJobs } from "@/services/background/jobs/index.js";
import { bootstrapMiddleware, getCorsConfig, initializeAdapters } from "@/lib/config/bootstrap.js";
import { createCorsMiddleware } from "@/middleware/cors.js";
import { globalRateLimit } from "@/middleware/ratelimit.js";
import { loadSession } from "@/middleware/auth.js";
import { registerRoutes } from "@/routes/index.js";
import admin from "@/routes/admin/index.js";
import metrics from "@/routes/metrics.js";
import { readFileSync } from "fs";
import { join } from "path";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const isNode = typeof process !== "undefined" && process.versions?.node;

app.get("/icon.png", async (c) => {
  const icon = readFileSync(join(process.cwd(), "public/icon.png"));
  return c.newResponse(icon, {
    headers: { "Content-Type": "image/png" },
  });
});

app.get("/favicon.ico", async (c) => {
  const icon = readFileSync(join(process.cwd(), "public/favicon.ico"));
  return c.newResponse(icon, {
    headers: { "Content-Type": "image/x-icon" },
  });
});

app.get("/loading.html", (c) => {
  const html = readFileSync(join(process.cwd(), "public/loading.html"), "utf-8");
  return c.html(html, 200, { "Cache-Control": "no-store", "X-Dployr-Loading": "1" });
});

app.use("*", bootstrapMiddleware);

// Restricted admin API - for management
app.route("/v1/admin", admin);

// Prometheus-format metrics 
app.route("/metrics", metrics);

// Load session before rate limiting so authenticated users get per-user buckets
app.use("/v1/*", loadSession);

// Global rate limiting
app.use("/v1/*", globalRateLimit);

// CORS middleware
app.use("/v1/*", createCorsMiddleware(getCorsConfig));

// Register all API routes
registerRoutes(app);

// Node.js server startup
if (isNode) {
  (async () => {
    await initializeAdapters();
    const wsService = new WebSocketService(app);
    wsService.start();
    if (process.env.NODE_ENV !== "test") {
      registerJobs(worker);
      worker.start();
    }
  })().catch((err) => {
    console.error("Fatal: failed to initialize", err);
    process.exit(1);
  });
}

export default app;
