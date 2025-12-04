// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * LazyMap is a Map with automatic TTL-based expiration for memory management.
 * Entries are automatically removed after the specified TTL.
 */
export class LazyMap<K, V> {
  private map: Map<K, { value: V; expiresAt: number }> = new Map();
  private ttl: number;

  constructor(ttlMs: number) {
    this.ttl = ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }

    return entry.value;
  }

  set(key: K, value: V): void {
    this.map.set(key, {
      value,
      expiresAt: Date.now() + this.ttl,
    });

    // Probabilistic cleanup (1% chance)
    if (Math.random() < 0.01) {
      this.cleanup();
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  has(key: K): boolean {
    const entry = this.map.get(key);
    if (!entry) return false;

    // Check if expired
    if (Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return false;
    }

    return true;
  }

  entries(): IterableIterator<[K, V]> {
    this.cleanup();
    return Array.from(this.map.entries())
      .map(([k, entry]) => [k, entry.value] as [K, V])
      [Symbol.iterator]();
  }

  clear(): void {
    this.map.clear();
  }

  get size(): number {
    this.cleanup();
    return this.map.size;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.map.entries()) {
      if (now > entry.expiresAt) {
        this.map.delete(key);
      }
    }
  }
}
