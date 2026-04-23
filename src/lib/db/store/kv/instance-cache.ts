import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv-keys.js";
import {
  INSTANCE_STATUS_TTL,
  NODE_UPDATE_TTL,
} from "@/lib/constants/index.js";

/**
 * Multi-level instance caching, service state, and process snapshots.
 */
export class InstanceCacheStore {
  constructor(private kv: IKVAdapter) {}

  /**
   * Caches an instance record under three keys for fast lookups by ID,
   * by cluster+tag, and by tag alone. All entries expire after
   * `INSTANCE_STATUS_TTL` (15 minutes).
   *
   * @param instance - The instance to cache, including `clusterId` and `tag`.
   */
  async cacheInstance(instance: { id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number }): Promise<void> {
    const data = JSON.stringify(instance);
    const ttl = INSTANCE_STATUS_TTL;

    await Promise.all([
      this.kv.put(KV_KEYS.INSTANCE_BY_ID(instance.id), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE_BY_NAME(instance.clusterId, instance.tag), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE_BY_TAG(instance.tag), data, { ttl }),
    ]);
  }

  /**
   * Retrieves a cached instance by its UUID. Returns `null` on a cache miss
   * or if the stored value is malformed.
   *
   * @param instanceId - The instance UUID to look up.
   * @returns The cached instance, or `null`.
   */
  async getCachedInstance(instanceId: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_ID(instanceId));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Retrieves a cached instance by its cluster ID and tag combination.
   *
   * @param clusterId - The cluster the instance belongs to.
   * @param tag - The unique tag identifying the instance within the cluster.
   * @returns The cached instance, or `null` on a miss.
   */
  async getCachedInstanceByName({ clusterId, tag }: { clusterId: string; tag: string }): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_NAME(clusterId, tag));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Retrieves a cached instance by tag alone, without knowing the cluster.
   * Used by the WebSocket node handler when an instance connects.
   *
   * @param tag - The instance tag to look up.
   * @returns The cached instance, or `null` on a miss.
   */
  async getCachedInstanceByTag(tag: string): Promise<{ id: string; tag: string; address: string; clusterId: string; metadata: any; createdAt: number; updatedAt: number } | null> {
    try {
      const data = await this.kv.get(KV_KEYS.INSTANCE_BY_TAG(tag));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Invalidates the cached entries for an instance. Always deletes the ID-keyed
   * entry. Deletes the cluster+tag and tag-only entries when the corresponding
   * identifiers are supplied.
   *
   * @param instanceId - The UUID of the instance to evict.
   * @param clusterId - Optional cluster ID, required to evict the name-keyed entry.
   * @param tag - Optional tag, required to evict both the name-keyed and
   *   tag-only entries.
   */
  async invalidateInstanceCache({ instanceId, clusterId, tag }: { instanceId: string; clusterId?: string; tag?: string }): Promise<void> {
    const deletes: Promise<void>[] = [this.kv.delete(KV_KEYS.INSTANCE_BY_ID(instanceId))];

    if (clusterId && tag) {
      deletes.push(this.kv.delete(KV_KEYS.INSTANCE_BY_NAME(clusterId, tag)));
    }

    if (tag) {
      deletes.push(this.kv.delete(KV_KEYS.INSTANCE_BY_TAG(tag)));
    }

    await Promise.all(deletes);
  }

  /**
   * Caches the full list of services for an instance with a short 60-second TTL.
   * Overwritten on each sync from the daemon's update payload.
   *
   * @param instanceId - The UUID of the instance whose services to cache.
   * @param services - The current list of services running on that instance.
   */
  async cacheServices(instanceId: string, services: Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }>): Promise<void> {
    const data = JSON.stringify(services);
    await this.kv.put(KV_KEYS.SERVICES(instanceId), data, { ttl: 60 });
  }

  /**
   * Retrieves the cached service list for an instance. Returns `null` on a miss
   * or if the cached data cannot be parsed.
   *
   * @param instanceId - The UUID of the instance to look up.
   * @returns An array of service objects, or `null`.
   */
  async getCachedServices(instanceId: string): Promise<Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }> | null> {
    try {
      const data = await this.kv.get(KV_KEYS.SERVICES(instanceId));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  /**
   * Evicts the service cache for an instance. Called after any write that
   * changes the service list (create, delete).
   *
   * @param instanceId - The UUID of the instance whose service cache to clear.
   */
  async invalidateServiceCache(instanceId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.SERVICES(instanceId));
  }

  /**
   * Persists the latest status update received from an instance daemon over
   * WebSocket. Overwrites any previous update. Expires after `NODE_UPDATE_TTL`
   * (5 minutes) — if an instance goes silent, its last known state expires.
   *
   * @param instanceId - The instance tag (not UUID) that sent the update.
   * @param update - The raw update payload from the daemon.
   */
  async saveNodeUpdate({ instanceId, update }: { instanceId: string; update: Record<string, unknown> }): Promise<void> {
    const now = Date.now();
    const data = {
      ...update,
      lastUpdated: now,
    };

    await this.kv.put(KV_KEYS.NODE_UPDATE(instanceId), JSON.stringify(data), {
      ttl: NODE_UPDATE_TTL,
    });
  }

  /**
   * Retrieves the last status update stored for an instance.
   *
   * @param instanceId - The instance tag to look up.
   * @returns The update payload, or `null` if none exists or it has expired.
   */
  async getNodeUpdate(instanceId: string): Promise<Record<string, unknown> | null> {
    const data = await this.kv.get(KV_KEYS.NODE_UPDATE(instanceId));
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Saves a point-in-time process snapshot from the daemon's `top` output.
   * Keyed by instance ID and current timestamp so snapshots accumulate over
   * time and can be queried by range. Expires after 2 hours.
   *
   * @param instanceId - The instance the snapshot belongs to.
   * @param seq - The sequence number from the daemon update message.
   * @param snapshot - The raw process list data from the daemon.
   */
  async saveProcessSnapshot({ instanceId, seq, snapshot }: { instanceId: string; seq: number; snapshot: Record<string, unknown> }): Promise<void> {
    const timestamp = Date.now();
    const key = KV_KEYS.PROCESS_SNAPSHOT(instanceId, timestamp);
    await this.kv.put(key, JSON.stringify({ seq, timestamp, data: snapshot }), {
      ttl: 60 * 60 * 2,
    });
  }

  /**
   * Retrieves a single process snapshot by instance ID and exact timestamp.
   *
   * @param instanceId - The instance to look up.
   * @param timestamp - The exact millisecond timestamp used as the key.
   * @returns The snapshot data object, or `null` if not found.
   */
  async getProcessSnapshot({ instanceId, timestamp }: { instanceId: string; timestamp: number }): Promise<Record<string, unknown> | null> {
    const key = KV_KEYS.PROCESS_SNAPSHOT(instanceId, timestamp);
    const data = await this.kv.get(key);
    if (!data) return null;
    const parsed = JSON.parse(data);
    return parsed.data;
  }

  /**
   * Returns the most recent process snapshots for an instance, up to `limit`
   * entries (capped at 1000). Results are sorted newest-first.
   *
   * @param instanceId - The instance to retrieve snapshots for.
   * @param limit - Maximum number of snapshots to return. Defaults to 10.
   * @returns An array of `{ seq, timestamp, data }` objects.
   */
  async getLatestProcessSnapshots({ instanceId, limit = 10 }: { instanceId: string; limit?: number }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const prefix = `process:${instanceId}:snapshot:`;
    const maxLimit = Math.min(limit, 1000);
    const result = await this.kv.list({ prefix, limit: maxLimit });

    const snapshots = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const timestampMatch = key.name.match(/:snapshot:(\d+)$/);
        if (!timestampMatch) return null;
        try {
          const parsed = JSON.parse(data);
          return {
            seq: parsed.seq,
            timestamp: parseInt(timestampMatch[1], 10),
            data: parsed.data,
          };
        } catch {
          return null;
        }
      }),
    );

    return snapshots
      .filter((s): s is { seq: number; timestamp: number; data: Record<string, unknown> } => s !== null)
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, maxLimit);
  }

  /**
   * Returns all process snapshots for an instance within a time range, sorted
   * oldest-first (ascending) for timeline rendering. The range is capped at a
   * maximum of 1 hour regardless of the supplied `endTime`.
   *
   * @param instanceId - The instance to query.
   * @param startTime - Range start in Unix milliseconds.
   * @param endTime - Range end in Unix milliseconds (capped to startTime + 1h).
   * @returns An array of `{ seq, timestamp, data }` objects, sorted ascending.
   */
  async getProcessSnapshotsByTimeRange({ instanceId, startTime, endTime }: { instanceId: string; startTime: number; endTime: number }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const maxRange = 60 * 60 * 1000;
    const cappedEndTime = Math.min(endTime, startTime + maxRange);

    const prefix = `process:${instanceId}:snapshot:`;
    const result = await this.kv.list({ prefix, limit: 10000 });

    const snapshots = await Promise.all(
      result.map(async (key) => {
        const data = await this.kv.get(key.name);
        if (!data) return null;
        const timestampMatch = key.name.match(/:snapshot:(\d+)$/);
        if (!timestampMatch) return null;
        const timestamp = parseInt(timestampMatch[1], 10);

        if (timestamp < startTime || timestamp > cappedEndTime) return null;

        try {
          const parsed = JSON.parse(data);
          return {
            seq: parsed.seq,
            timestamp,
            data: parsed.data,
          };
        } catch {
          return null;
        }
      }),
    );

    return snapshots.filter((s): s is { seq: number; timestamp: number; data: Record<string, unknown> } => s !== null).sort((a, b) => a.timestamp - b.timestamp);
  }
}
