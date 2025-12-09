// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Hono } from "hono";
import type { Bindings, Variables } from "@/types/index.js";

import auth from "./auth.js";
import instances from "./instances.js";
import integrations from "./integrations.js";
import clusters from "./clusters.js";
import deployments from "./deployments.js";
import users from "./users.js";
import runtime from "./runtime.js";
import jwks from "./jwks.js";
import domains from "./domains.js";
import agent from "./agent.js";
import notifications from "./notifications.js";

const VERSION = process.env.BASE_VERSION || "unknown";

/**
 * Register all API routes on the Hono app
 */
export function registerRoutes(app: Hono<{ Bindings: Bindings; Variables: Variables }>): void {
  // API routes
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

  // Health check endpoint
  app.get("/v1/health", (c) => {
    return c.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      version: VERSION,
    });
  });
}
