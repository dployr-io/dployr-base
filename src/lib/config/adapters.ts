// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Config } from "./loader.js";
import { IKVAdapter, RedisKV, MemoryKV } from "@/lib/storage/kv.interface.js";
import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { WebSocketHandler } from "@/services/websocket/instance-handler.js";
import type { BillingProvider } from "@/services/billing/provider.js";
import type { Bindings } from "@/types/index.js";
import { PolarService } from "@/services/billing/polar.js";
import { DigitalOceanVMService } from "@/services/vm/index.js";
import { EmailProvider, ZeptoProvider } from "@/services/notifications/email/index.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("adapters");

/**
 * Create KV adapter from config
 */
export async function createKVFromConfig(config: Config): Promise<IKVAdapter> {
   switch (config.kv.type) {
     case "redis": {
       // Support both host/port and URL formats for Redis connection
       let host: string | undefined = config.kv.host;
       let port: number | undefined = config.kv.port;
       
       // If URL is provided, parse it to extract host and port
       if (!host || !port) {
         if (config.kv.url) {
           // Ensure URL has a protocol; if not, prepend redis://
           let urlString = config.kv.url;
           if (!urlString.includes("://")) {
             urlString = `redis://${urlString}`;
           }
           const url = new URL(urlString);
           host = url.hostname;
           port = parseInt(url.port) || 6379;
           // Handle authentication from URL if present
           if (url.username) {
             config.kv.username = url.username;
           }
           if (url.password) {
             config.kv.password = url.password;
           }
         } else {
           throw new Error("Redis connection requires either kv.host and kv.port or kv.url in config");
         }
       }
       
       const { createClient } = await import("redis");

       const client = createClient({
         socket: {
           host: host!,
           port: port!,
         },
         ...(config.kv.username ? { username: config.kv.username } : {}),
         ...(config.kv.password ? { password: config.kv.password } : {}),
       });

       client.on("error", (err: any) => log.error("Redis Client Error", { error: String(err) }));

       await client.connect();

       return new RedisKV(client);
     }

    case "upstash": {
      if (!config.kv.rest_url || !config.kv.rest_token) {
        throw new Error("Upstash credentials required: kv.rest_url and kv.rest_token");
      }
      const { Redis } = await import("@upstash/redis");
      const client = new Redis({
        url: config.kv.rest_url,
        token: config.kv.rest_token,
      });
      return new RedisKV(client);
    }

    case "memory":
      log.warn("Using in-memory KV; data will not persist across restarts. For production deployments, configure Upstash or another managed Redis service.");
      return new MemoryKV();

    default:
      throw new Error(`Unknown KV type: ${(config.kv as any).type}`);
  }
}

/**
 * Create database connection from config
 */
export async function createDatabaseFromConfig(config: Config): Promise<PostgresAdapter> {
  const url = config.database.url || process.env.DATABASE_URL;
  if (!url) {
    throw new Error("PostgreSQL URL required in config.toml: database.url or env.DATABASE_URL");
  }
  return new PostgresAdapter(url, {
    max: config.database.pool_max,
    min: config.database.pool_min,
    idleTimeoutMillis: config.database.pool_idle_timeout_ms,
    connectionTimeoutMillis: config.database.pool_connection_timeout_ms,
    keepAlive: config.database.pool_keep_alive,
    keepAliveInitialDelayMillis: 10_000,
    ssl: config.database.pool_ssl === "no-verify" ? { rejectUnauthorized: false } : config.database.pool_ssl || { rejectUnauthorized: false },
  });
}

/**
 * Create storage adapter from config
 */
export async function createStorageFromConfig(config: Config): Promise<any> {
  const isProd = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "prod";

  switch (config.storage.type) {
    case "filesystem": {
      if (!config.storage.path) {
        if (isProd) {
          throw new Error("Filesystem path required in production: storage.path");
        }
        log.warn("Storage not configured; skipping filesystem storage initialization");
        return null;
      }
      const { mkdir } = await import("fs/promises");
      await mkdir(config.storage.path, { recursive: true });
      return { type: "filesystem", path: config.storage.path };
    }

    case "s3":
    case "digitalocean": {
      if (!config.storage.bucket || !config.storage.region) {
        if (isProd) {
          throw new Error("S3/DigitalOcean storage requires bucket and region in production");
        }
        log.warn("S3/DigitalOcean storage not fully configured; skipping storage initialization");
        return null;
      }
      const { S3Client } = await import("@aws-sdk/client-s3");
      return new S3Client({
        region: config.storage.region,
        ...(config.storage.access_key && {
          credentials: {
            accessKeyId: config.storage.access_key,
            secretAccessKey: config.storage.secret_key!,
          },
        }),
      });
    }

    default:
      if (isProd) {
        throw new Error(`Unknown storage type in production: ${(config.storage as any).type}`);
      }
      log.warn(`Unknown storage type: ${(config.storage as any).type}; skipping storage initialization`);
      return null;
  }
}

  /**
   * Create email provider from config
   */
  export function createEmailProvider(config: Config): EmailProvider | null {
    const isProd = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "prod";

    if (!config.email?.zepto_api_key) {
      if (isProd) {
        throw new Error("Email provider requires API key in production");
      }
      return null;
    }

    switch (config.email?.provider ?? "zepto") {
      case "zepto": {
        const env: Partial<Bindings> = {
          ZEPTO_API_KEY: config.email.zepto_api_key,
          EMAIL_FROM: config.email.from_address,
        };
        return new ZeptoProvider(env as Bindings);
       }
       default:
         if (isProd) {
           throw new Error(`Unknown email provider in production: ${config.email?.provider}`);
         }
         log.warn(`Unknown email provider: ${config.email?.provider}; email notifications will be disabled`);
         return null;
     }
   }


/**
 * Create billing provider from config
 */
export function createBillingProvider(config: Config): BillingProvider | null {
  const isProd = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "prod";

  if (!config.billing?.polar_access_token) {
    if (isProd) {
      throw new Error("Billing provider requires API token in production");
    }
    return null;
  }

  switch (config.billing?.provider ?? "polar") {
    case "polar": {
      const env: Partial<Bindings> = {
        POLAR_ACCESS_TOKEN: config.billing.polar_access_token,
        POLAR_WEBHOOK_SECRET: config.billing.polar_webhook_secret,
        POLAR_ENVIRONMENT: config.billing.environment,
        BILLING_CHECKOUT_URLS: config.billing.checkout_urls,
      };
      return new PolarService(env as Bindings);
    }
    default:
      if (isProd) {
        throw new Error(`Unknown billing provider in production: ${config.billing?.provider}`);
      }
      log.warn(`Unknown billing provider: ${config.billing?.provider}; billing will be disabled`);
      return null;
  }
}

export function createVmProvider(config: Config): DigitalOceanVMService | null {
  const isProd = process.env.NODE_ENV === "production" || process.env.NODE_ENV === "prod";

  if (!config.virtual_machines?.do_api_token) {
    if (isProd) {
      throw new Error("VM provider requires API token in production");
    }
    return null;
  }

  switch (config.virtual_machines?.provider ?? "digitalocean") {
    case "digitalocean": {
      const apiToken = config.virtual_machines.do_api_token;
      if (apiToken) {
        return new DigitalOceanVMService(apiToken);
      }
      return null;
    }
    default:
      if (isProd) {
        throw new Error(`Unknown VM provider in production: ${config.virtual_machines?.provider}`);
      }
      log.warn(`Unknown VM provider: ${config.virtual_machines?.provider}; VM provisioning will be disabled`);
      return null;
  }
}

/**
 * Create Traefik Redis client from config
 */
export async function createTraefikRedisFromConfig(config: Config): Promise<any | null> {
  if (!config.traefik?.enabled) {
    return null;
  }

  let host: string | undefined = config.traefik.redis_host;
  let port: number | undefined = config.traefik.redis_port;

  // If URL is provided, parse it to extract host and port
  if (!host || !port) {
    if (config.traefik.redis_url) {
      let urlString = config.traefik.redis_url;
      if (!urlString.includes("://")) {
        urlString = `redis://${urlString}`;
      }
      const url = new URL(urlString);
      host = url.hostname;
      port = parseInt(url.port) || 6379;
      // Handle authentication from URL if present
      if (url.username && !config.traefik.redis_username) {
        config.traefik.redis_username = url.username;
      }
      if (url.password && !config.traefik.redis_password) {
        config.traefik.redis_password = url.password;
      }
    } else {
      log.warn("Traefik enabled but no Redis configuration found; Traefik routing will be disabled");
      return null;
    }
  }

  const { createClient } = await import("redis");

  const client = createClient({
    socket: {
      host: host!,
      port: port!,
    },
    ...(config.traefik.redis_username ? { username: config.traefik.redis_username } : {}),
    ...(config.traefik.redis_password ? { password: config.traefik.redis_password } : {}),
  });

  client.on("error", (err: any) => log.error("Traefik Redis Client Error", { error: String(err) }));

  await client.connect();
  log.info(`Connected to Redis at ${host}:${port}`);

  return client;
}

/**
 * Initialize all adapters from config (one-liner setup)
 */
export async function initializeFromConfig(config: Config) {
  if (config.security?.encryption_key) {
    process.env.ENCRYPTION_KEY = config.security.encryption_key;
  }

  const kv = await createKVFromConfig(config);
  const db = await createDatabaseFromConfig(config);
  const storage = await createStorageFromConfig(config);
  const email = createEmailProvider(config);
  const billingProvider = createBillingProvider(config);
  const vmProvider = createVmProvider(config);
  const traefikRedis = await createTraefikRedisFromConfig(config);
  const wsHandler = new WebSocketHandler(kv, db);

  return { kv, db, storage, ws: wsHandler, email, config, billingProvider, vmProvider, traefikRedis };
}
