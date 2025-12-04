// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Config } from './loader';
import { IKVAdapter, CloudflareKV, RedisKV, MemoryKV } from '@/lib/storage/kv.interface';
import { NodeDurableObjectAdapter } from '@/lib/durable/node-adapter';
import { Bindings } from '@/types';

/**
 * Create KV adapter from config (type-safe, zero manual wiring)
 */
export async function createKVFromConfig(config: Config, env?: any): Promise<IKVAdapter> {
  switch (config.kv.type) {
    case 'cloudflare':
      if (!env?.BASE_KV) {
        throw new Error('Cloudflare KV binding not found. Check wrangler.toml');
      }
      return new CloudflareKV(env.BASE_KV);

    case 'redis': {
      if (!config.kv.url) {
        throw new Error('Redis URL required in config.toml: kv.url');
      }
      const { createClient } = await import('redis');
      const client = createClient({ url: config.kv.url });
      await client.connect();
      return new RedisKV(client);
    }

    case 'upstash': {
      if (!config.kv.rest_url || !config.kv.rest_token) {
        throw new Error('Upstash credentials required: kv.rest_url and kv.rest_token');
      }
      const { Redis } = await import('@upstash/redis');
      const client = new Redis({
        url: config.kv.rest_url,
        token: config.kv.rest_token,
      });
      return new RedisKV(client);
    }

    case 'memory':
      console.warn('⚠️  Using in-memory KV (data will be lost on restart)');
      return new MemoryKV();

    default:
      throw new Error(`Unknown KV type: ${(config.kv as any).type}`);
  }
}

/**
 * Create database connection from config
 */
export async function createDatabaseFromConfig(config: Config, env?: any): Promise<any> {
  switch (config.database.type) {
    case 'd1':
      if (!env?.BASE_DB) {
        throw new Error('Cloudflare D1 binding not found. Check wrangler.toml');
      }
      return env.BASE_DB;

    case 'sqlite': {
      if (!config.database.path) {
        throw new Error('SQLite path required in config.toml: database.path');
      }
      // Ensure directory exists
      const { dirname } = await import('path');
      const { mkdir } = await import('fs/promises');
      const dir = dirname(config.database.path);
      await mkdir(dir, { recursive: true });
      
      // Create D1-compatible wrapper for better-sqlite3
      const Database = (await import('better-sqlite3')).default;
      const db = new Database(config.database.path);
      
      // Wrap in D1-like API
      return {
        prepare: (query: string) => {
          const stmt = db.prepare(query);
          return {
            bind: (...params: any[]) => ({
              all: async () => {
                const results = stmt.all(...params);
                return { results };
              },
              first: async () => {
                return stmt.get(...params);
              },
              run: async () => {
                const info = stmt.run(...params);
                return { 
                  success: true,
                  meta: {
                    changes: info.changes,
                    last_row_id: info.lastInsertRowid,
                  }
                };
              },
            }),
            all: async () => {
              const results = stmt.all();
              return { results };
            },
            first: async () => {
              return stmt.get();
            },
            run: async () => {
              const info = stmt.run();
              return { 
                success: true,
                meta: {
                  changes: info.changes,
                  last_row_id: info.lastInsertRowid,
                }
              };
            },
          };
        },
        batch: async (statements: any[]) => {
          const transaction = db.transaction(() => {
            return statements.map(stmt => stmt.run());
          });
          return transaction();
        },
        exec: async (query: string) => {
          db.exec(query);
          return { success: true };
        },
      };
    }

    default:
      throw new Error(`Unknown database type: ${(config.database as any).type}`);
  }
}

/**
 * Create storage adapter from config
 */
export async function createStorageFromConfig(config: Config, env?: any): Promise<any> {
  switch (config.storage.type) {
    case 'r2':
      if (!env?.INSTANCE_LOGS) {
        throw new Error('Cloudflare R2 binding not found. Check wrangler.toml');
      }
      return env.INSTANCE_LOGS;

    case 'filesystem': {
      if (!config.storage.path) {
        throw new Error('Filesystem path required: storage.path');
      }
      const { mkdir } = await import('fs/promises');
      await mkdir(config.storage.path, { recursive: true });
      return { type: 'filesystem', path: config.storage.path };
    }

    case 's3':
    case 'digitalocean': {
      if (!config.storage.bucket || !config.storage.region) {
        throw new Error('S3 config required: storage.bucket, storage.region');
      }
      const { S3Client } = await import('@aws-sdk/client-s3');
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
export async function initializeFromConfig(config: Config, env?: any) {
  const kv = await createKVFromConfig(config, env);
  const db = await createDatabaseFromConfig(config, env);
  const storage = await createStorageFromConfig(config, env);
  
  // Initialize Durable Object adapter for Node.js
  // Pass minimal env bindings needed by the DO adapter
  const doEnv: Partial<Bindings> = {
    BASE_KV: env?.BASE_KV,
    ...env,
  };
  const doAdapter = new NodeDurableObjectAdapter(doEnv as Bindings, kv);

  return { kv, db, storage, do: doAdapter, config };
}
