// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Bindings, Variables } from "@/types/index.js";
import { Hono } from "hono";
import { WebSocketService } from "@/services/websocket/index.js";
import { bootstrapMiddleware, getCorsConfig } from "@/lib/bootstrap.js";
import { createCorsMiddleware } from "@/middleware/cors.js";
import { globalRateLimit } from "@/middleware/ratelimit.js";
import { registerRoutes } from "@/routes/index.js";
import admin from "@/routes/admin/index.js";
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

app.use("*", bootstrapMiddleware);

// Restricted admin API - for management
app.route("/v1/admin", admin);

// Global rate limiting
app.use("/v1/*", globalRateLimit);

// CORS middleware
app.use("/v1/*", createCorsMiddleware(getCorsConfig));

// Register all API routes
registerRoutes(app);

// Node.js server startup
if (isNode) {
  const wsService = new WebSocketService(app);
  wsService.start();
}

export default app;