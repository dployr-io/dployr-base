// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * KV storage interface
 */
export interface IKVAdapter {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { ttl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string; limit?: number }): Promise<Array<{ name: string }>>;
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

  async put(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    if (options?.ttl) {
      await this.client.set(key, value, { EX: options.ttl });
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

    try {
      let cursor = '0';
      do {
        const res: any = await this.client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        
        // Handle both [cursor, keys] and { cursor, keys } shapes
        const [newCursor, batch] = Array.isArray(res) 
          ? [res[0] ?? '0', res[1] ?? []]
          : [res?.cursor ?? '0', res?.keys ?? []];

        cursor = String(newCursor);
        keys.push(...batch);
        
        if (options.limit && keys.length >= options.limit) break;
      } while (cursor !== '0');
    } catch (error) {
      console.error('[RedisKV] scan failed:', error);
    }

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

  async put(key: string, value: string, options?: { ttl?: number }): Promise<void> {
    const expiresAt = options?.ttl ? Date.now() + options.ttl * 1000 : undefined;
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
