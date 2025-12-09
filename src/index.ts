// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables } from "@/types/index.js";
import { WebSocketService } from "@/services/websocket.js";
import { bootstrapMiddleware, getCorsConfig } from "@/lib/bootstrap.js";
import { createCorsMiddleware } from "@/middleware/cors.js";
import { globalRateLimit } from "@/middleware/ratelimit.js";
import { registerRoutes } from "@/routes/index.js";

const app = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const isNode = typeof process !== "undefined" && process.versions?.node;

// Bootstrap middleware - initializes adapters and injects context
app.use("*", bootstrapMiddleware);

// Global rate limiting
app.use("/v1/*", globalRateLimit);

// CORS middleware
app.use("/v1/*", createCorsMiddleware(getCorsConfig));

// Register all API routes
registerRoutes(app);

export default app;

// Node.js server startup
if (isNode) {
  const wsService = new WebSocketService(app);
  wsService.start();
}
