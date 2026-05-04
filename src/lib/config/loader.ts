// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { readFileSync, existsSync } from "fs";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { CONFIG_SCHEMA } from "@/lib/constants/config.js";

export type Config = z.infer<typeof CONFIG_SCHEMA>;

/**
 * Load and validate configuration from TOML file or environment variables
 */
export function loadConfig(path?: string): Config {
  // Try environment variables first (for Docker)
  if (process.env.PLATFORM) {
    return loadConfigFromEnv();
  }

  // Fall back to TOML file
  let defaultPath: string;

  switch (process.env.NODE_ENV) {
    case "development":
      defaultPath = "./config.dev.toml";
      break;
    case "test":
      defaultPath = "./config.test.toml";
      break;
    default:
      defaultPath = "./config.toml";
  }

  const configPath = path || process.env.CONFIG_PATH || defaultPath;

  // If config file doesn't exist, use environment variables instead
  if (!existsSync(configPath)) {
    return loadConfigFromEnv();
  }

  const content = readFileSync(configPath, "utf-8");
  const raw = parseToml(content);

  try {
    const config = CONFIG_SCHEMA.parse(raw);

    // Allow env overrides for test isolation (embedded postgres + random port)
    if (process.env.DATABASE_URL) config.database.url = process.env.DATABASE_URL;
    if (process.env.PORT) config.server.port = parseInt(process.env.PORT);
    if (process.env.REDIS_URL) {
      config.kv.url = process.env.REDIS_URL;
      // For redis type, url takes precedence over individual host/port
      config.kv.host = undefined;
      config.kv.port = undefined;
    }

    return config;
  } catch (err) {
    if (err instanceof z.ZodError) {
      const errors = err.issues.map((e: any) => `  - ${e.path.join(".")}: ${e.message}`).join("\n");
      throw new Error(`Invalid configuration:\n${errors}`);
    }
    throw err;
  }
}

/**
 * Load configuration from environment variables
 */
function loadConfigFromEnv(): Config {
  return CONFIG_SCHEMA.parse({
    server: {
      port: parseInt(process.env.PORT || "7878"),
      host: process.env.HOST || "0.0.0.0",
      base_url: process.env.BASE_URL || "http://localhost:7878",
      app_url: process.env.APP_URL || "http://localhost:5173",
    },
    database: {
      url: process.env.DB_URL || process.env.DATABASE_URL,
      auto_migrate: true,
    },
    kv: {
      type: process.env.KV_TYPE || "redis",
      url: process.env.KV_URL,
      rest_url: process.env.KV_REST_URL,
      rest_token: process.env.KV_REST_TOKEN,
    },
    storage: {
      type: process.env.STORAGE_TYPE || "filesystem",
      path: process.env.STORAGE_PATH,
      bucket: process.env.STORAGE_BUCKET,
      region: process.env.STORAGE_REGION,
      access_key: process.env.STORAGE_ACCESS_KEY,
      secret_key: process.env.STORAGE_SECRET_KEY,
    },
    auth: {
      google_client_id: process.env.GOOGLE_CLIENT_ID,
      google_client_secret: process.env.GOOGLE_CLIENT_SECRET,
      github_client_id: process.env.GITHUB_CLIENT_ID,
      github_client_secret: process.env.GITHUB_CLIENT_SECRET,
      microsoft_client_id: process.env.MICROSOFT_CLIENT_ID,
      microsoft_client_secret: process.env.MICROSOFT_CLIENT_SECRET,
    },
    admin: {
      admin_api_key: process.env.ADMIN_API_KEY,
      allowed_ips: process.env.ALLOWED_DPLOYR_ADMINISTRATORS,
      totp_secret: process.env.ADMIN_TOTP_SECRET,
    },
    integrations: {
      github_app_id: process.env.GITHUB_APP_ID,
      github_app_private_key: process.env.GITHUB_APP_PRIVATE_KEY,
      github_webhook_secret: process.env.GITHUB_WEBHOOK_SECRET,
      github_token: process.env.GITHUB_TOKEN || process.env.GH_TOKEN,
      gitlab_app_id: process.env.GITLAB_APP_ID,
      gitlab_app_secret: process.env.GITLAB_APP_SECRET,
      bitbucket_app_id: process.env.BITBUCKET_APP_ID,
      bitbucket_app_secret: process.env.BITBUCKET_APP_SECRET,
    },
    email: {
      provider: process.env.EMAIL_PROVIDER || "zepto",
      zepto_api_key: process.env.ZEPTO_API_KEY,
      from_address: process.env.EMAIL_FROM,
      smtp_host: process.env.SMTP_HOST,
      smtp_port: process.env.SMTP_PORT ? parseInt(process.env.SMTP_PORT) : undefined,
      smtp_user: process.env.SMTP_USER,
      smtp_pass: process.env.SMTP_PASS,
    },
    security: {
      session_ttl: 86400,
      jwt_algorithm: "RS256",
      global_rate_limit: 100,
      strict_rate_limit: 10,
    },
    cors: {
      allowed_origins: process.env.CORS_ALLOWED_ORIGINS,
    },
    billing: {
      provider: (process.env.BILLING_PROVIDER as "polar") || "polar",
      polar_access_token: process.env.POLAR_ACCESS_TOKEN,
      polar_webhook_secret: process.env.POLAR_WEBHOOK_SECRET,
      environment: (process.env.POLAR_ENVIRONMENT as "sandbox" | "production") || (process.env.NODE_ENV === "production" ? "production" : "sandbox"),
    },
    proxy: {
      enabled: process.env.PROXY_ENABLED === "true",
      port: process.env.PROXY_PORT ? parseInt(process.env.PROXY_PORT) : 8080,
      host: process.env.PROXY_HOST || "0.0.0.0",
      base_domain: process.env.TLD || "dployr.io",
      timeout_ms: process.env.PROXY_TIMEOUT_MS ? parseInt(process.env.PROXY_TIMEOUT_MS) : 30000,
      cache_ttl_seconds: process.env.PROXY_CACHE_TTL_SECONDS ? parseInt(process.env.PROXY_CACHE_TTL_SECONDS) : 30,
    },
    virtual_machines: {
      provider: (process.env.VM_PROVIDER as "digitalocean") || "digitalocean",
      do_api_token: process.env.DO_API_TOKEN,
      ssh_key: process.env.SSH_KEY,
    },
  });
}
