// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Hono } from "hono";
import type { Bindings, Variables } from "@/types/index.js";
import auth from "./auth.js";
import instances from "./instances.js";
import integrations from "./integrations.js";
import clusters from "./clusters.js";
import deployments from "./deployments.js";
import services from "./services.js";
import users from "./users.js";
import runtime from "./runtime.js";
import jwks from "./jwks.js";
import domains from "./domains.js";
import node from "./node.js";
import notifications from "./notifications.js";
import proxy from "./proxy.js";
import billing from "./billing.js";
import webhooks from "./webhooks.js";
import oidc from "./oidc.js";
import authTokens from "./auth-tokens.js";
import twofa from "./twofa.js";
import logs from "./logs.js";
import { getWS } from "@/lib/config/context.js";

const VERSION = process.env.BASE_VERSION || "unknown";

/**
 * Register all API routes on the Hono app
 */
export function registerRoutes(app: Hono<{ Bindings: Bindings; Variables: Variables }>): void {
  // API routes
  app.route("/v1/auth", auth);
  app.route("/v1/auth/2fa", twofa);
  app.route("/v1/auth/oidc", oidc);
  app.route("/v1/auth/tokens", authTokens);
  app.route("/v1/users", users);
  app.route("/v1/instances", instances);
  app.route("/v1/clusters", clusters);
  app.route("/v1/deployments", deployments);
  app.route("/v1/services", services);
  app.route("/v1/integrations", integrations);
  app.route("/v1/notifications", notifications);
  app.route("/v1/runtime", runtime);
  app.route("/v1/jwks", jwks);
  app.route("/v1/domains", domains);
  app.route("/v1/node", node);
  app.route("/v1/proxy", proxy);
  app.route("/v1/billing", billing);
  app.route("/v1/logs", logs);
  app.route("/webhooks", webhooks);

  // Health check endpoint
  app.get("/v1/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: VERSION,
    });
  });

  // WebSocket stats endpoint (for monitoring/observability)
  app.get("/v1/ws/stats", (c) => {
    try {
      const ws = getWS(c);
      const stats = ws.getStats();
      return c.json({
        success: true,
        data: stats,
        timestamp: new Date().toISOString(),
      });
    } catch (err) {
      return c.json(
        {
          success: false,
          error: "WebSocket handler not available",
        },
        503,
      );
    }
  });
}
