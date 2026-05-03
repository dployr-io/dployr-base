// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context, Next } from "hono";
import type { Bindings, Variables } from "@/types/index.js";
import { initializeDatabase } from "@/lib/db/migrate.js";
import { loadConfig, type Config } from "@/lib/config/loader.js";
import { initializeFromConfig } from "@/lib/config/adapters.js";
import type { BillingProvider } from "@/services/billing/provider.js";
import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { IStorageAdapter } from "./context.js";
import { WebSocketHandler } from "@/services/websocket/instance-handler.js";
import { VmProvider } from "@/services/vm/index.js";
import { EmailProvider } from "@/services/notifications/email/index.js";

export interface Adapters {
  kv: IKVAdapter;
  db: PostgresAdapter;
  storage: IStorageAdapter;
  ws: WebSocketHandler;
  email: EmailProvider | null;
  config: Config;
  billingProvider: BillingProvider | null;
  vmProvider: VmProvider | null;
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

export function buildBindings(a: Adapters): Bindings {
  const serverConfig = a.config?.server;
  const emailConfig = a.config?.email;
  const corsConfig = a.config?.cors;
  const integrationsConfig = a.config?.integrations;
  const authConfig = a.config?.auth;
  const adminConfig = a.config?.admin;
  const billingConfig = a.config?.billing;
  const vmConfig = a.config?.virtual_machines;
  const securityConfig = a.config?.security;

  return {
    BASE_URL: serverConfig?.base_url || process.env.BASE_URL || "",
    APP_URL: serverConfig?.app_url || process.env.APP_URL || "",
    EMAIL_FROM: emailConfig?.from_address || process.env.EMAIL_FROM || "",
    ZEPTO_API_KEY: emailConfig?.zepto_api_key || process.env.ZEPTO_API_KEY || "",
    GITHUB_APP_ID: integrationsConfig?.github_app_id || process.env.GITHUB_APP_ID || "",
    GITHUB_APP_PRIVATE_KEY: integrationsConfig?.github_app_private_key || process.env.GITHUB_APP_PRIVATE_KEY || "",
    GITHUB_WEBHOOK_SECRET: integrationsConfig?.github_webhook_secret || process.env.GITHUB_WEBHOOK_SECRET || "",
    GITHUB_TOKEN: integrationsConfig?.github_token || process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "",
    GOOGLE_CLIENT_ID: authConfig?.google_client_id || process.env.GOOGLE_CLIENT_ID || "",
    GOOGLE_CLIENT_SECRET: authConfig?.google_client_secret || process.env.GOOGLE_CLIENT_SECRET || "",
    GITHUB_CLIENT_ID: authConfig?.github_client_id || process.env.GITHUB_CLIENT_ID || "",
    GITHUB_CLIENT_SECRET: authConfig?.github_client_secret || process.env.GITHUB_CLIENT_SECRET || "",
    MICROSOFT_CLIENT_ID: authConfig?.microsoft_client_id || process.env.MICROSOFT_CLIENT_ID || "",
    MICROSOFT_CLIENT_SECRET: authConfig?.microsoft_client_secret || process.env.MICROSOFT_CLIENT_SECRET || "",
    CORS_ALLOWED_ORIGINS: corsConfig?.allowed_origins || process.env.CORS_ALLOWED_ORIGINS || "",
    ENCRYPTION_KEY: securityConfig?.encryption_key || process.env.ENCRYPTION_KEY || "",
    ADMIN_API_KEY: adminConfig?.admin_api_key || process.env.ADMIN_API_KEY || "",
    ALLOWED_DPLOYR_ADMINISTRATORS: Array.isArray(adminConfig?.allowed_ips) ? adminConfig.allowed_ips.join(",") : adminConfig?.allowed_ips || process.env.ALLOWED_DPLOYR_ADMINISTRATORS || "",
    ADMIN_TOTP_SECRET: adminConfig?.totp_secret || process.env.ADMIN_TOTP_SECRET || "",
    POLAR_ACCESS_TOKEN: billingConfig?.polar_access_token || process.env.POLAR_ACCESS_TOKEN || "",
    POLAR_WEBHOOK_SECRET: billingConfig?.polar_webhook_secret || process.env.POLAR_WEBHOOK_SECRET || "",
    POLAR_ENVIRONMENT: billingConfig?.environment || process.env.POLAR_ENVIRONMENT || (process.env.NODE_ENV === "production" ? "production" : "sandbox"),
    BILLING_CHECKOUT_URLS: billingConfig?.checkout_urls,
    DO_API_TOKEN: vmConfig?.do_api_token,
    SSH_KEY: vmConfig?.ssh_key,
  };
}

/**
 * Middleware to inject adapters and environment bindings into Hono context
 */
export async function bootstrapMiddleware(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next): Promise<void | Response> {
  // Initialize adapters on first request (lazy initialization)
  if (!adapters) {
    await initializeAdapters();
  }

  // Inject adapters into context
  c.set("kvAdapter", adapters!.kv);
  c.set("dbAdapter", adapters!.db);
  c.set("storageAdapter", adapters!.storage);
  c.set("wsHandler", adapters!.ws);
  c.set("billingProvider", adapters!.billingProvider);
  c.set("vmProvider", adapters!.vmProvider);
  c.set("emailProvider", adapters!.email);

  c.env = buildBindings(adapters!) as unknown as Bindings;

  await next();
}
