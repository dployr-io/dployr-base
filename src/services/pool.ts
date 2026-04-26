import { InstanceStatus } from "@/types/index.js";
import { VmProvider } from "./vm/provider.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { HEARTBEAT_WINDOW } from "@/lib/constants/index.js";
import { getBillingProvider, getDbStore } from "@/lib/config/context.js";
import { BillingService } from "./billing/index.js";
import { Context } from "hono";
import { tcpReachable } from "@/lib/net.js";

export class InstancePoolService {
   /**
     * Lists instance pools available to a cluster.
     *
     * Returns a paginated list of instance pools available to the
     * specified cluster.
     *
     * @param params.clusterId - Cluster ULID to list instances from
     * @param params.c - Hono context with request bindings
     * @param params.limit - Maximum number of instances to return
     * @param params.offset - Number of instances to skip
     * @returns Array of instances and total count
     */
    async listInstances({ c, clusterId, limit, offset }: { c: Context; clusterId?: string; limit?: number; offset?: number }): Promise<{ instances: any[]; total: number }> {
      const db = getDbStore(c);
      return db.instancePool.list({ clusterId, limit, offset });
    }

  /**
   * Reconciles the instance pool against DigitalOcean.
   *
   * - Droplets with the "managed" label that are absent from the pool → added.
   * - Pool entries with no corresponding droplet in DO → removed.
   */
  public async poolSync({ vm, db }: { vm: VmProvider; db: DatabaseStore }) {
    const [droplets, { instances: poolEntries }] = await Promise.all([vm.list({ tagName: "managed", perPage: 200 }), db.instancePool.list()]);

    const poolByTag = new Map(poolEntries.map((e) => [e.tag, e]));
    const dropletByTag = new Map(droplets.map((d) => [d.name, d]));

    // Add managed droplets not yet in pool
    for (const droplet of droplets) {
      if (!poolByTag.has(droplet.name)) {
        await db.instancePool.add({
          tag: droplet.name,
          address: droplet.ipv4 ?? null,
          capacity: 10,
          region: droplet.region,
          status: "healthy",
          metadata: { managed: true, tier: "hobby" },
        });
        console.log(`[pool-sync] Added ${droplet.name}`);
      }
    }

    // Remove pool entries no longer present in DO
    for (const entry of poolEntries) {
      if (!dropletByTag.has(entry.tag)) {
        await db.instancePool.remove(entry.id);
        console.log(`[pool-sync] Removed stale entry ${entry.tag}`);
      }
    }
  }

  /**
   * Checks each pool instance against its DO droplet status.
   *
   * - DO status "active"     → keeps current status (daemon check decides healthy/degraded)
   * - DO status not "active" → offline  (VM exists but is powered off / archived)
   * - Not found in DO at all → unreachable
   *
   * Skips instances in maintenance.
   * Uses a single list() call for efficiency
   */
  public async poolPing({ vm, db }: { vm: VmProvider; db: DatabaseStore }) {
    const { instances: poolEntries } = await db.instancePool.list();
    const candidates = poolEntries.filter((e) => e.status !== "maintenance");
    if (candidates.length === 0) return;

    const droplets = await vm.list({ tagName: "managed", perPage: 200 });
    const dropletByTag = new Map(droplets.map((d) => [d.name, d]));

    for (const entry of candidates) {
      const droplet = dropletByTag.get(entry.tag);
      let next: InstanceStatus;

      if (!droplet) {
        next = "unreachable";
      } else if (droplet.status !== "active") {
        next = "offline";
      } else {
        // VM is active — leave healthy/degraded to be decided by pool-health
        continue;
      }

      if (entry.status !== next) {
        await db.instancePool.updateStatus(entry.id, next);
        console.log(`[pool-ping] ${entry.tag} → ${next}`);
      }
    }
  }

  /**
   * Checks each pool instance by opening a TCP connection to port 22.
   *
   * Any response (connect or ECONNREFUSED) means the host is up → healthy.
   * A timeout means the host is gone → degraded.
   */
  public async poolPingDirect({ db }: { db: DatabaseStore }) {
    const { instances: poolEntries } = await db.instancePool.list();
    const candidates = poolEntries.filter((e) => e.address && e.status !== "maintenance" && e.status !== "offline" && e.status !== "unreachable");

    await Promise.all(
      candidates.map(async (entry) => {
        const reachable = await tcpReachable(entry.address!);
        const next: InstanceStatus = reachable ? "healthy" : "degraded";

        if (entry.status !== next) {
          await db.instancePool.updateStatus(entry.id, next);
          console.log(`[pool-ping-direct] ${entry.tag} → ${next}`);
        }
      }),
    );
  }

  /**
   * Checks daemon reachability for each pool instance via the KV cache.
   *
   * A daemon is considered alive if either:
   *   - the node update key exists and its lastUpdated timestamp is within 120 s, OR
   *   - there is at least one process snapshot in the last 120 s.
   *
   * Skips instances already marked offline, unreachable, or maintenance —
   * those need VM-level remediation, not daemon-level.
   */
  public async poolHealth({ kv, db }: { kv: KVStore; db: DatabaseStore }) {
    const { instances: poolEntries } = await db.instancePool.list();
    const candidates = poolEntries.filter((e) => e.status !== "maintenance" && e.status !== "offline" && e.status !== "unreachable");

    const now = Date.now();
    const windowStart = now - HEARTBEAT_WINDOW;

    for (const entry of candidates) {
      const [nodeUpdate, recentSnapshots] = await Promise.all([kv.getNodeUpdate(entry.tag), kv.getProcessSnapshotsByTimeRange({ instanceId: entry.tag, startTime: windowStart, endTime: now })]);

      const updateFresh = nodeUpdate !== null && typeof nodeUpdate.lastUpdated === "number" && nodeUpdate.lastUpdated >= windowStart;

      const snapshotFresh = recentSnapshots.length > 0;

      const daemonAlive = updateFresh || snapshotFresh;
      const next: InstanceStatus = daemonAlive ? "healthy" : "degraded";

      if (entry.status !== next) {
        await db.instancePool.updateStatus(entry.id, next);
        console.log(`[pool-health] ${entry.tag} → ${next}`);
      }
    }
  }

  /**
   * Resolves an instance for a cluster, primarily for hobby plan users.
   *
   * Checks the billing status for the cluster. If the plan is "hobby",
   * attempts to retrieve an instance from the shared instance pool.
   * Returns null for non-hobby plans, missing clusterId, if no pool
   * instance is available, or if the instance is not found in the pool.
   *
   * @param params.c - Hono context with request bindings
   * @param params.clusterId - Cluster ULID to resolve an instance for
   * @returns Resolved instance with clusterId and metadata, or null if not available
   */
  async resolveInstancePool({ c, clusterId }: { c: any; clusterId?: string }) {
    if (!clusterId) return null;

    const billingProvider = getBillingProvider(c);
    if (!billingProvider) return null;

    const billingService = new BillingService(billingProvider, c.env);
    const db = getDbStore(c);

    const status = await billingService.getStatus({ clusterId, db });
    if (status.plan !== "hobby") return null;

    const [instanceId, { instances: pool }] = await Promise.all([db.instancePool.getClusterInstance(clusterId), db.instancePool.list()]);

    if (!instanceId) return null;

    const instance = pool.find((inst) => inst.id === instanceId);
    if (!instance) return null;

    const now = Date.now();

    return {
      ...instance,
      metadata: {
        ...instance.metadata,
        managed: true,
      },
      clusterId,
      createdAt: now,
      updatedAt: now,
    };
  }
}
