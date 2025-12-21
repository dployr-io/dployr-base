// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Config } from "./loader.js";
import { IKVAdapter, RedisKV, MemoryKV } from "@/lib/storage/kv.interface.js";
import { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { WebSocketHandler } from "@/lib/websocket/instance-handler.js";

/**
 * Create KV adapter from config
 */
export async function createKVFromConfig(
  config: Config
): Promise<IKVAdapter> {
  switch (config.kv.type) {
    case "redis": {
      if (!config.kv.host || !config.kv.port) {
        throw new Error("Redis connection requires kv.host and kv.port in config.toml");
      }
      const { createClient } = await import("redis");
      
      const client = createClient({
        socket: {
          host: config.kv.host,
          port: config.kv.port,
        },
        ...(config.kv.username ? { username: config.kv.username } : {}),
        ...(config.kv.password ? { password: config.kv.password } : {}),
      });

      client.on('error', (err: any) => console.log('Redis Client Error', err));
      
      await client.connect();

      return new RedisKV(client);
    }

    case "upstash": {
      if (!config.kv.rest_url || !config.kv.rest_token) {
        throw new Error(
          "Upstash credentials required: kv.rest_url and kv.rest_token"
        );
      }
      const { Redis } = await import("@upstash/redis");
      const client = new Redis({
        url: config.kv.rest_url,
        token: config.kv.rest_token,
      });
      return new RedisKV(client);
    }

    case "memory":
      console.warn(
        "Using in-memory KV; data will not persist across restarts. " +
        "For production deployments, configure Upstash or another managed Redis service."
      );
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
  return new PostgresAdapter(url);
}

/**
 * Create storage adapter from config
 */
export async function createStorageFromConfig(
  config: Config,
): Promise<any> {
  switch (config.storage.type) {
    case "filesystem": {
      if (!config.storage.path) {
        throw new Error("Filesystem path required: storage.path");
      }
      const { mkdir } = await import("fs/promises");
      await mkdir(config.storage.path, { recursive: true });
      return { type: "filesystem", path: config.storage.path };
    }

    case "s3":
    case "digitalocean": {
      if (!config.storage.bucket || !config.storage.region) {
        throw new Error("S3 config required: storage.bucket, storage.region");
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
      throw new Error(`Unknown storage type: ${(config.storage as any).type}`);
  }
}

/**
 * Initialize all adapters from config (one-liner setup)
 */
export async function initializeFromConfig(config: Config) {
  const kv = await createKVFromConfig(config);
  const db = await createDatabaseFromConfig(config);
  const storage = await createStorageFromConfig(config);
  const wsHandler = new WebSocketHandler(kv, db as any);

  return { kv, db, storage, ws: wsHandler, config };
}
