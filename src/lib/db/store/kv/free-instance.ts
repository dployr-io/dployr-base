import { IKVAdapter } from "@/lib/storage/kv.interface.js";
import { KV_KEYS } from "@/lib/constants/kv.js";

/**
 * Shape of a free instance entry stored in the pool.
 */
export interface FreeInstanceEntry {
  id: string;
  address: string;
  tag: string;
  capacity: number;
  region?: string;
  /** Runtime-only field set via admin API. Not present in config. */
  status?: "active" | "paused";
  metadata?: { managed: boolean; tier: string };
}

/**
 * Free instance pool management for hobby clusters.
 */
export class FreeInstanceStore {
  constructor(private kv: IKVAdapter) {}

  /**
   * Returns the full free instance pool array from KV. The pool is written from
   * config on startup and mutated at runtime via admin API endpoints (pause,
   * resume, remove).
   *
   * @returns An array of `FreeInstanceEntry` objects, or `null` if the pool has
   *   not been seeded yet.
   */
  async getFreeInstancePool(): Promise<FreeInstanceEntry[] | null> {
    const data = await this.kv.get(KV_KEYS.FREE_INSTANCE_POOL);
    if (!data) return null;
    return JSON.parse(data);
  }

  /**
   * Overwrites the free instance pool in KV. Used by the admin seed endpoint
   * and by pause/resume/remove operations that mutate the pool array.
   *
   * @param pool - The new pool array to persist.
   */
  async setFreeInstancePool(pool: FreeInstanceEntry[]): Promise<void> {
    await this.kv.put(KV_KEYS.FREE_INSTANCE_POOL, JSON.stringify(pool));
  }

  // Assignment & lookup
  async assignFreeInstance(clusterId: string): Promise<string | null> {
    const pool = await this.getFreeInstancePool();
    if (!pool || pool.length === 0) return null;

    const available = pool.filter((inst) => inst.status !== "paused");
    if (available.length === 0) return null;

    let counter = 0;
    const counterKey = KV_KEYS.FREE_INSTANCE_COUNTER("global");
    const counterValue = await this.kv.get(counterKey);
    if (counterValue) {
      counter = parseInt(counterValue, 10) || 0;
    }

    counter = (counter + 1) % available.length;

    await this.kv.put(counterKey, counter.toString());

    const instance = available[counter];

    await this.kv.put(KV_KEYS.FREE_INSTANCE_CLUSTER(clusterId), instance.id);

    return instance.id;
  }

  /**
   * Returns the ID of the free instance currently assigned to a cluster, or
   * `null` if the cluster has not been assigned one (e.g. paid plan or pool
   * was empty at signup).
   *
   * @param clusterId - The cluster to look up.
   * @returns The assigned free instance ID, or `null`.
   */
  async getClusterFreeInstance(clusterId: string): Promise<string | null> {
    return await this.kv.get(KV_KEYS.FREE_INSTANCE_CLUSTER(clusterId));
  }

  /**
   * Removes the free instance assignment for a cluster. Called when a cluster
   * upgrades away from the hobby plan or when the assigned instance is removed
   * from the pool via the admin API.
   *
   * Does not decrement the instance counter — use the admin API to manage
   * pool capacity manually when removing instances.
   *
   * @param clusterId - The cluster whose free instance assignment to release.
   */
  async releaseFreeInstance(clusterId: string): Promise<void> {
    await this.kv.delete(KV_KEYS.FREE_INSTANCE_CLUSTER(clusterId));
  }

  // Cluster mapping scan
  async getClustersFreeInstanceMap(): Promise<Array<{ clusterId: string; instanceId: string }>> {
    const prefix = "free_instance:cluster:";
    const keys = await this.kv.list({ prefix });
    const results = await Promise.all(
      keys.map(async (key) => {
        const instanceId = await this.kv.get(key.name);
        if (!instanceId) return null;
        const clusterId = key.name.slice(prefix.length);
        return { clusterId, instanceId };
      }),
    );
    return results.filter((r): r is { clusterId: string; instanceId: string } => r !== null);
  }
}
