// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * KV storage interface
 */
export interface IKVAdapter {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit?: number }): Promise<Array<{ name: string }>>;
}

/**
 * Cloudflare KV adapter 
 */
export class CloudflareKV implements IKVAdapter {
  constructor(private kv: KVNamespace) {}

  async get(key: string): Promise<string | null> {
    return this.kv.get(key);
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    await this.kv.put(key, value, options);
  }

  async delete(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  async list(options: { prefix: string; limit?: number }): Promise<Array<{ name: string }>> {
    const result = await this.kv.list(options);
    return result.keys;
  }
}

/**
 * Redis adapter (self-hosted redis / Upstash)
 */
export class RedisKV implements IKVAdapter {
  private client: any;

  constructor(client: any) {
    this.client = client;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(key);
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    if (options?.expirationTtl) {
      await this.client.setex(key, options.expirationTtl, value);
    } else {
      await this.client.set(key, value);
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.del(key);
  }

  async list(options: { prefix: string; limit?: number }): Promise<Array<{ name: string }>> {
    const pattern = `${options.prefix}*`;
    const keys: string[] = [];
    
    let cursor = '0';
    do {
      const [newCursor, batch] = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
      cursor = newCursor;
      keys.push(...batch);
      if (options.limit && keys.length >= options.limit) break;
    } while (cursor !== '0');

    return keys.slice(0, options.limit).map(name => ({ name }));
  }
}

/**
 * In-memory adapter (testing & development only)
 */
export class MemoryKV implements IKVAdapter {
  private store = new Map<string, { value: string; expiresAt?: number }>();

  async get(key: string): Promise<string | null> {
    const item = this.store.get(key);
    if (!item) return null;
    if (item.expiresAt && Date.now() > item.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return item.value;
  }

  async put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void> {
    const expiresAt = options?.expirationTtl ? Date.now() + options.expirationTtl * 1000 : undefined;
    this.store.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  async list(options: { prefix: string; limit?: number }): Promise<Array<{ name: string }>> {
    const keys = Array.from(this.store.keys())
      .filter(k => k.startsWith(options.prefix))
      .slice(0, options.limit)
      .map(name => ({ name }));
    return keys;
  }
}
