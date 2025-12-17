// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "@/types/index.js";
import { initializeDatabase } from "@/lib/db/migrate.js";
import { loadConfig, type Config } from "@/lib/config/loader.js";
import { initializeFromConfig } from "@/lib/config/adapters.js";

export interface Adapters {
  kv: any;
  db: any;
  storage: any;
  ws: any;
  config: Config;
}

let adapters: Adapters | null = null;

/**
 * Get the current adapters instance (for use outside middleware context)
 */
export function getAdapters(): Adapters | null {
  return adapters;
}

/**
 * Get CORS config from adapters (for CORS middleware)
 */
export function getCorsConfig(): { allowed_origins?: string } | undefined {
  return adapters?.config?.cors;
}

/**
 * Initialize adapters and database
 */
export async function initializeAdapters(): Promise<Adapters> {
  if (adapters) {
    return adapters;
  }

  const config = loadConfig();
  adapters = await initializeFromConfig(config);

  if (config.database.auto_migrate) {
    await initializeDatabase(adapters.db);
  }

  console.log("Dployr Base initialized");
  return adapters;
}

/**
 * Middleware to inject adapters and environment bindings into Hono context
 */
export async function bootstrapMiddleware(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
): Promise<void | Response> {
  // Initialize adapters on first request (lazy initialization)
  if (!adapters) {
    await initializeAdapters();
  }

  // Inject adapters into context
  c.set("kvAdapter", adapters!.kv);
  c.set("dbAdapter", adapters!.db);
  c.set("storageAdapter", adapters!.storage);
  c.set("wsHandler", adapters!.ws);

  // Build environment bindings from config
  const serverConfig = adapters!.config?.server;
  const emailConfig = adapters!.config?.email;
  const corsConfig = adapters!.config?.cors;
  const integrationsConfig = adapters!.config?.integrations;

  c.env = {
    BASE_URL: serverConfig?.base_url || process.env.BASE_URL || "",
    APP_URL: serverConfig?.app_url || process.env.APP_URL || "",
    EMAIL_FROM: emailConfig?.from_address || process.env.EMAIL_FROM || "",
    ZEPTO_API_KEY: emailConfig?.zepto_api_key || process.env.ZEPTO_API_KEY || "",
    GITHUB_APP_ID: integrationsConfig?.github_app_id || process.env.GITHUB_APP_ID || "",
    GITHUB_APP_PRIVATE_KEY: integrationsConfig?.github_app_private_key || process.env.GITHUB_APP_PRIVATE_KEY || "",
    GITHUB_WEBHOOK_SECRET: integrationsConfig?.github_webhook_secret || process.env.GITHUB_WEBHOOK_SECRET || "",
    GITHUB_TOKEN: integrationsConfig?.github_token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    GITHUB_CLIENT_ID: process.env.GITHUB_CLIENT_ID || "",
    GITHUB_CLIENT_SECRET: process.env.GITHUB_CLIENT_SECRET || "",
    CORS_ALLOWED_ORIGINS: corsConfig?.allowed_origins || process.env.CORS_ALLOWED_ORIGINS || "",
  } as unknown as Bindings;

  await next();
}
