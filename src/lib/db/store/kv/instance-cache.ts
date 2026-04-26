import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { INSTANCE_STATUS_TTL, NODE_UPDATE_TTL } from "@/lib/constants/index.js";
import type { Instance } from "@/types/index.js";

type CachedInstance = Instance & { clusterId: string };

type InstanceCacheFilter =
  | { id: string }
  | { clusterId: string; tag: string }
  | { tag: string };

export class InstanceCacheStore {
  constructor(private kv: IKVAdapter) {}

  async cacheInstance(instance: CachedInstance & { metadata: any }): Promise<void> {
    const data = JSON.stringify(instance);
    const ttl = INSTANCE_STATUS_TTL;

    await Promise.all([
      this.kv.put(KV_KEYS.INSTANCE_BY_ID(instance.id), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE_BY_NAME(instance.clusterId, instance.tag), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE_BY_TAG(instance.tag), data, { ttl }),
    ]);
  }

  /**
   * Retrieve a cached instance by ID, by cluster+tag, or by tag alone.
   * Priority: id → clusterId+tag → tag.
   */
  async getCachedInstance(filter: InstanceCacheFilter): Promise<CachedInstance | null> {
    let key: string;

    if ("id" in filter) {
      key = KV_KEYS.INSTANCE_BY_ID(filter.id);
    } else if ("clusterId" in filter) {
      key = KV_KEYS.INSTANCE_BY_NAME(filter.clusterId, filter.tag);
    } else {
      key = KV_KEYS.INSTANCE_BY_TAG(filter.tag);
    }

    try {
      const data = await this.kv.get(key);
      if (!data) return null;
      return JSON.parse(data) as CachedInstance;
    } catch {
      return null;
    }
  }

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

  async cacheServices(instanceId: string, services: Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }>): Promise<void> {
    await this.kv.put(KV_KEYS.SERVICES(instanceId), JSON.stringify(services), { ttl: 60 });
  }

  async getCachedServices(instanceId: string): Promise<Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }> | null> {
    try {
      const data = await this.kv.get(KV_KEYS.SERVICES(instanceId));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async invalidateServiceCache(instanceId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.SERVICES(instanceId));
  }

  async saveNodeUpdate({ instanceId, update }: { instanceId: string; update: Record<string, unknown> }): Promise<void> {
    const data = { ...update, lastUpdated: Date.now() };
    await this.kv.put(KV_KEYS.NODE_UPDATE(instanceId), JSON.stringify(data), { ttl: NODE_UPDATE_TTL });
  }

  async getNodeUpdate(instanceId: string): Promise<Record<string, unknown> | null> {
    const data = await this.kv.get(KV_KEYS.NODE_UPDATE(instanceId));
    if (!data) return null;
    return JSON.parse(data);
  }

  async saveProcessSnapshot({ instanceId, seq, snapshot }: { instanceId: string; seq: number; snapshot: Record<string, unknown> }): Promise<void> {
    const timestamp = Date.now();
    await this.kv.put(
      KV_KEYS.PROCESS_SNAPSHOT(instanceId, timestamp),
      JSON.stringify({ seq, timestamp, data: snapshot }),
      { ttl: 60 * 60 * 2 },
    );
  }

  async getProcessSnapshot({ instanceId, timestamp }: { instanceId: string; timestamp: number }): Promise<Record<string, unknown> | null> {
    const data = await this.kv.get(KV_KEYS.PROCESS_SNAPSHOT(instanceId, timestamp));
    if (!data) return null;
    return JSON.parse(data).data;
  }

  async getLatestProcessSnapshots({ instanceId, limit = 10 }: { instanceId: string; limit?: number }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const prefix = KV_KEYS.PROCESS_SNAPSHOT(instanceId);
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
          return { seq: parsed.seq, timestamp: parseInt(timestampMatch[1], 10), data: parsed.data };
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

  async getProcessSnapshotsByTimeRange({
    instanceId,
    startTime,
    endTime,
  }: {
    instanceId: string;
    startTime: number;
    endTime: number;
  }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const maxRange = 60 * 60 * 1000;
    const cappedEndTime = Math.min(endTime, startTime + maxRange);
    const prefix = KV_KEYS.PROCESS_SNAPSHOT(instanceId);
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
          return { seq: parsed.seq, timestamp, data: parsed.data };
        } catch {
          return null;
        }
      }),
    );

    return snapshots
      .filter((s): s is { seq: number; timestamp: number; data: Record<string, unknown> } => s !== null)
      .sort((a, b) => a.timestamp - b.timestamp);
  }
}
