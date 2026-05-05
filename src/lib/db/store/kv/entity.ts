// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { ENTITY_TOMBSTONE_TTL } from "@/lib/constants/duration.js";

interface VersionedValue<T> {
  data: T;
  version: number;
  timestamp: number;
  seq: number;
}

interface VersionInfo {
  version: number;
  timestamp: number;
}

interface EntityOptions {
  ttl?: number;
}

/**
 * Stores versioned entities with automatic Lamport clock management.
 * All versioning is transparent to callers—just use setEntity() and getEntity().
 *
 * Entity IDs must match: type:identifier (e.g., "cluster:123", "deployment:abc-def")
 * This ensures entities are clearly distinguished from regular KV cache keys.
 */
export class EntityStore {
  private static readonly ENTITY_ID_PATTERN = /^[a-z][a-z0-9]*:[a-z0-9\-_.]+$/i;
  private static readonly TOMBSTONE_SUFFIX = ":deleted";

  constructor(private kv: IKVAdapter) {}

  /**
   * Store a versioned entity. Versioning is automatic and transparent.
   * Returns version info for protocol use (client sync tracking).
   *
   * @throws If entity ID doesn't match type:identifier format
   */
  async setEntity<T>(
    id: string,
    data: T,
    options?: EntityOptions,
  ): Promise<VersionInfo> {
    this.validateEntityId(id);

    const current = await this.getRawEntity<T>(id);
    const now = Date.now();

    // Lamport clock: always increment, monotonically increasing
    const nextVersion = (current?.version ?? 0) + 1;

    // Sequence number for multiple updates in same millisecond (precision)
    const nextSeq = current?.timestamp === now ? current.seq + 1 : 1;

    const versioned: VersionedValue<T> = {
      data,
      version: nextVersion,
      timestamp: now,
      seq: nextSeq,
    };

    await this.kv.put(id, JSON.stringify(versioned), {ttl: options?.ttl});

    return {
      version: nextVersion,
      timestamp: now,
    };
  }

  /**
   * Get a versioned entity with version info.
   * Returns null if entity doesn't exist.
   */
  async getEntity<T>(id: string): Promise<{
    data: T;
    version: number;
    timestamp: number;
  } | null> {
    const stored = await this.getRawEntity<T>(id);
    if (!stored) return null;

    return {
      data: stored.data,
      version: stored.version,
      timestamp: stored.timestamp,
    };
  }

  private async getRawEntity<T>(id: string): Promise<VersionedValue<T> | null> {
    const raw = await this.kv.get(id);
    if (!raw) return null;
    try {
      return JSON.parse(raw) as VersionedValue<T>;
    } catch {
      return null;
    }
  }

  /**
   * Get only version info without fetching data.
   * Useful for sync protocols to check if client has latest version.
   * Returns null if entity doesn't exist.
   */
  async getEntityVersion(id: string): Promise<VersionInfo | null> {
    const stored = await this.getRawEntity(id);
    if (stored) {
      return {
        version: stored.version,
        timestamp: stored.timestamp,
      };
    }

    // Check tombstone (entity was deleted)
    const tombstone = await this.getRawEntity<null>(`${id}${EntityStore.TOMBSTONE_SUFFIX}`);
    if (tombstone) {
      return {
        version: tombstone.version,
        timestamp: tombstone.timestamp,
      };
    }

    return null;
  }

  /**
   * Delete an entity. Creates a tombstone with TTL (default 7 days).
   * Tombstone proves entity existed and when it was deleted.
   * After TTL expires, the tombstone is removed (clients can't tell "never existed" vs "deleted long ago").   
   * Returns version info for protocol use.
   */
  async deleteEntity(id: string): Promise<VersionInfo> {
    this.validateEntityId(id);

    const current = await this.getRawEntity(id);
    const nextVersion = (current?.version ?? 0) + 1;
    const now = Date.now();

    // Tombstone: proves entity was deleted at this version
    const tombstone: VersionedValue<null> = {
      data: null,
      version: nextVersion,
      timestamp: now,
      seq: 1,
    };

    // Store tombstone for audit trail with TTL (7 days)
    await this.kv.put(
      `${id}${EntityStore.TOMBSTONE_SUFFIX}`,
      JSON.stringify(tombstone),
      {ttl: ENTITY_TOMBSTONE_TTL},
    );

    // Remove current value
    await this.kv.delete(id);

    return {
      version: nextVersion,
      timestamp: now,
    };
  }

  /**
   * Check if entity exists (not deleted).
   */
  async exists(id: string): Promise<boolean> {
    const stored = await this.kv.get(id);
    return stored !== null;
  }

  private validateEntityId(id: string): void {
    if (!EntityStore.ENTITY_ID_PATTERN.test(id)) {
      throw new Error(
        `Invalid entity ID format: "${id}". ` +
        `Expected "type:identifier" (e.g., "cluster:123", "deployment:abc-def", "service:my-api")`,
      );
    }
  }
}
