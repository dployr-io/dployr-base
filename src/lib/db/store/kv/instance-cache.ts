import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { INSTANCE_STATUS_TTL, NODE_UPDATE_TTL, NODE_CONNECTED_TTL, INSTANCE_DECOMMISSION_RECOVERY_WINDOW_MS } from "@/lib/constants/index.js";
import type { Instance } from "@/types/index.js";

type CachedInstance = Instance & { clusterId: string };

type InstanceCacheFilter = { id: string } | { clusterId: string; tag: string } | { tag: string };

export class InstanceCacheStore {
  constructor(private kv: IKVAdapter) {}

  async cacheInstance(instance: CachedInstance & { metadata: any }): Promise<void> {
    const data = JSON.stringify(instance);
    const ttl = INSTANCE_STATUS_TTL;

    await Promise.all([
      this.kv.put(KV_KEYS.INSTANCE.BY_ID(instance.id), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE.BY_NAME(instance.clusterId, instance.tag), data, { ttl }),
      this.kv.put(KV_KEYS.INSTANCE.BY_TAG(instance.tag), data, { ttl }),
    ]);
  }

  /**
   * Retrieve a cached instance by ID, by cluster+tag, or by tag alone.
   * Priority: id → clusterId+tag → tag.
   */
  async getCachedInstance(filter: InstanceCacheFilter): Promise<CachedInstance | null> {
    let key: string;

    if ("id" in filter) {
      key = KV_KEYS.INSTANCE.BY_ID(filter.id);
    } else if ("clusterId" in filter) {
      key = KV_KEYS.INSTANCE.BY_NAME(filter.clusterId, filter.tag);
    } else {
      key = KV_KEYS.INSTANCE.BY_TAG(filter.tag);
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
    const deletes: Promise<void>[] = [this.kv.delete(KV_KEYS.INSTANCE.BY_ID(instanceId))];

    if (clusterId && tag) {
      deletes.push(this.kv.delete(KV_KEYS.INSTANCE.BY_NAME(clusterId, tag)));
    }

    if (tag) {
      deletes.push(this.kv.delete(KV_KEYS.INSTANCE.BY_TAG(tag)));
    }

    await Promise.all(deletes);
  }

  async cacheServices(tag: string, services: Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }>): Promise<void> {
    await this.kv.put(KV_KEYS.SERVICES.BY_INSTANCE(tag), JSON.stringify(services), { ttl: 60 });
  }

  async getCachedServices(tag: string): Promise<Array<{ id: string; name: string; instanceId: string; createdAt: number; updatedAt: number }> | null> {
    try {
      const data = await this.kv.get(KV_KEYS.SERVICES.BY_INSTANCE(tag));
      if (!data) return null;
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  async invalidateServiceCache(tag: string): Promise<void> {
    await this.kv.delete(KV_KEYS.SERVICES.BY_INSTANCE(tag));
  }

  async setNodeConnected(tag: string): Promise<void> {
    await this.kv.put(KV_KEYS.NODE.CONNECTED(tag), "1", { ttl: NODE_CONNECTED_TTL });
  }

  async refreshNodeConnected(tag: string): Promise<void> {
    await this.kv.put(KV_KEYS.NODE.CONNECTED(tag), "1", { ttl: NODE_CONNECTED_TTL });
  }

  async deleteNodeConnected(tag: string): Promise<void> {
    await this.kv.delete(KV_KEYS.NODE.CONNECTED(tag));
  }

  async isNodeConnected(tag: string): Promise<boolean> {
    return (await this.kv.get(KV_KEYS.NODE.CONNECTED(tag))) !== null;
  }

  async registerClusterNode(clusterId: string, instanceId: string): Promise<void> {
    await this.kv.put(KV_KEYS.CLUSTER.NODE(clusterId, instanceId), "1", { ttl: NODE_CONNECTED_TTL });
  }

  async getClusterNodes(clusterId: string): Promise<string[] | null> {
    const prefix = KV_KEYS.CLUSTER.NODES_PREFIX(clusterId);
    try {
      const results = await this.kv.list({ prefix });
      return results.map((r) => r.name.slice(prefix.length)).filter(Boolean);
    } catch {
      return null;
    }
  }

  async deregisterClusterNode(clusterId: string, instanceId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.CLUSTER.NODE(clusterId, instanceId));
  }

  async saveProcessSnapshot({ tag, seq, snapshot }: { tag: string; seq: number; snapshot: Record<string, unknown> }): Promise<void> {
    const timestamp = Date.now();
    await this.kv.put(KV_KEYS.PROCESS.SNAPSHOT(tag, timestamp), JSON.stringify({ seq, timestamp, data: snapshot }), { ttl: 60 * 60 * 2 });
  }

  async getProcessSnapshot({ tag, timestamp }: { tag: string; timestamp: number }): Promise<Record<string, unknown> | null> {
    const data = await this.kv.get(KV_KEYS.PROCESS.SNAPSHOT(tag, timestamp));
    if (!data) return null;
    return JSON.parse(data).data;
  }

  async getLatestProcessSnapshots({ tag, limit = 10 }: { tag: string; limit?: number }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const prefix = KV_KEYS.PROCESS.SNAPSHOT(tag);
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
    tag,
    startTime,
    endTime,
  }: {
    tag: string;
    startTime: number;
    endTime: number;
  }): Promise<Array<{ seq: number; timestamp: number; data: Record<string, unknown> }>> {
    const maxRange = 60 * 60 * 1000;
    const cappedEndTime = Math.min(endTime, startTime + maxRange);
    const prefix = KV_KEYS.PROCESS.SNAPSHOT(tag);
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

    return snapshots.filter((s): s is { seq: number; timestamp: number; data: Record<string, unknown> } => s !== null).sort((a, b) => a.timestamp - b.timestamp);
  }

  async setFlagForDecommission({ tag }: { tag: string }): Promise<void> {
    await this.kv.put(KV_KEYS.INSTANCE.DECOMMISSION_RECOVERY_WINDOW(tag), Date.now().toString(), { ttl: INSTANCE_STATUS_TTL });
  }

  async isInRecoveryWindow({ tag }: { tag: string }): Promise<boolean> {
    const raw = await this.kv.get(KV_KEYS.INSTANCE.DECOMMISSION_RECOVERY_WINDOW(tag));
    if (raw === null) return false; // never flagged

    const flaggedAt = parseInt(raw, 10);
    return Date.now() - flaggedAt < INSTANCE_DECOMMISSION_RECOVERY_WINDOW_MS;
  }

  async checkForDecommissionFlag({ instanceId }: { instanceId: string }): Promise<boolean> {
    const raw = await this.kv.get(KV_KEYS.INSTANCE.DECOMMISSION_RECOVERY_WINDOW(instanceId));
    if (raw === null) return false; // never flagged
    return true;
  }

  async saveJobRun(run: {
    id: string;
    job: string;
    status: "running" | "completed" | "failed";
    startedAt: number;
    completedAt?: number;
    durationMs?: number;
    error?: string;
    output?: Record<string, unknown>;
    ttl?: number;
  }): Promise<void> {
    if (run.status === "running") return;
    const { ttl, ...data } = run;

    // Write the run data — expires automatically via TTL
    await this.kv.put(KV_KEYS.JOB.RUN(run.id), JSON.stringify(data), ttl ? { ttl } : undefined);

    // Maintain a compact index of IDs (newest first, capped at 200)
    const raw = await this.kv.get(KV_KEYS.JOB.INDEX);
    const index: string[] = raw ? JSON.parse(raw) : [];
    index.unshift(run.id);
    await this.kv.put(KV_KEYS.JOB.INDEX, JSON.stringify(index.slice(0, 200)));
  }

  async getRecentJobRuns(limit = 50): Promise<Array<Record<string, unknown>>> {
    const raw = await this.kv.get(KV_KEYS.JOB.INDEX);
    if (!raw) return [];
    const ids: string[] = JSON.parse(raw);
    // Fetch more than limit to account for expired entries
    const runs = await Promise.all(
      ids.slice(0, Math.min(ids.length, limit * 2)).map(async (id) => {
        const data = await this.kv.get(KV_KEYS.JOB.RUN(id));
        if (!data) return null;
        try { return JSON.parse(data); } catch { return null; }
      }),
    );
    return runs.filter((r): r is Record<string, unknown> => r !== null).slice(0, limit);
  }
}
