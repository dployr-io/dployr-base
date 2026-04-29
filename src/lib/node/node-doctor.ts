import { InstanceStatus, SubscriptionPlan } from "@/types/index.js";
import { NodeUpdateV1_1 } from "@/types/node.js";
import { HEARTBEAT_WINDOW, POOL_PROVISION_LOCK_TTL } from "../constants/duration.js";
import { tcpReachable } from "../net.js";
import { EventEmittable } from "@/services/notifications/emittable.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { VmProvider } from "@/services/vm/index.js";
import { EVENTS, HEADLESS_EVENTS } from "../constants/events.js";
import { ConnectionManager } from "@/services/websocket/connection-manager.js";
import { VirtualMachine } from "@/types/vm.js";
import { PoolCapacityExceededError } from "../errors/errors.js";
import { INSTANCE_POOL_QUOTA } from "../constants/instances.js";
import { KV_KEYS } from "../constants/kv.js";
import { DEFAULT_CAPACITY } from "../constants/vm.js";
import { InstancePool } from "@/services/pool.js";

export class NodeDoctor extends EventEmittable {
  protected readonly vm: VmProvider | null;
  protected readonly db: DatabaseStore;
  protected readonly conn: ConnectionManager;
  protected readonly pool: InstancePool;

  constructor({ vm, kv, db, conn, pool }: { vm: VmProvider | null; kv: KVStore; db: DatabaseStore; conn: ConnectionManager; pool: InstancePool }) {
    super(kv);
    this.vm = vm;
    this.db = db;
    this.conn = conn;
    this.pool = pool;
  }

  /** Health check based on daemon heartbeat. */
  public async nodeHeartbeat(): Promise<void> {
    const { instances } = await this.db.instances.list({ managed: true });
    if (instances.length === 0) return;

    const windowStart = Date.now() - HEARTBEAT_WINDOW;
    const candidates = instances.filter((e) => !this.isStaticStatus(e.status));

    for (const entry of candidates) {
      const heartbeatStatus = await this.resolveHeartbeatStatus(entry.tag, windowStart);
      if (entry.status === heartbeatStatus) continue;

      const confirmedStatus = await this.confirmStatusViaTcp(entry.address!);

      try {
        await this.db.instances.update({ id: entry.id }, { status: confirmedStatus });
        await this.emit(HEADLESS_EVENTS[confirmedStatus], entry.tag);
      } catch (err) {
        console.error(`[pool-health] Failed to update ${entry.tag} to ${confirmedStatus}:`, err);
      }
    }
  }

  /** Full synchronisation of pool state with the VM provider. */
  public async nodesSync(): Promise<void> {
    if (!this.vm) {
      console.log("[pool-sync] Skipped — no VM provider configured");
      return;
    }

    const [droplets, { instances: poolEntries }, { instances: dedicatedInstances }] = await Promise.all([
      this.vm.list({ tagName: "managed", perPage: 200 }),
      this.db.instances.list({ managed: true, kind: "pool" }),
      this.db.instances.list({ managed: true, kind: "dedicated" }),
    ]);

    const poolMap = new Map(poolEntries.map((e) => [e.tag, e]));
    const dropletMap = new Map(droplets.map((d: VirtualMachine) => [d.name, d]));

    await this.syncDropletsAndInstances(droplets, poolMap);
    await this.removeStaleInstances([...poolEntries, ...dedicatedInstances], dropletMap);
    await this.demoteUnhealthyInstancesToMaintenance(poolMap);
    await this.allocateUnassignedCapacity(droplets.length);
    await this.syncDedicatedInstances(dedicatedInstances, dropletMap);

    this.nodesDrain(poolEntries);
  }

  /** Provider-level ping — checks droplet status and updates accordingly. */
  public async syncStatusFromProvider(): Promise<void> {
    if (!this.vm) return;

    const { instances } = await this.db.instances.list({ managed: true });
    if (instances.length === 0) return;

    const droplets = await this.vm.list({ tagName: "managed", perPage: 200 });
    const dropletMap = new Map(droplets.map((d) => [d.name, d]));

    for (const entry of instances) {
      const next = this.resolveProviderStatus(dropletMap.get(entry.tag));

      try {
        await this.db.instances.update({ id: entry.id }, { status: next });
        await this.emit(HEADLESS_EVENTS[next], entry.tag);
      } catch (err) {
        console.error(`[pool-ping] Failed to update ${entry.tag} to ${next}:`, err);
      }
    }
  }

  /** Phase 1: upsert each provider droplet into the DB. */
  private async syncDropletsAndInstances(droplets: VirtualMachine[], poolMap: any): Promise<void> {
    for (const droplet of droplets) {
      const existing = poolMap.get(droplet.name);
      const status: InstanceStatus = droplet.status === "active" ? "healthy" : "offline";
      const metadata = {
        managed: (droplet.tags ?? []).includes("managed"),
        tier: this.extractTier(droplet.tags),
      };

      if (!existing) {
        await this.db.instances.addPool({
          tag: droplet.name,
          address: droplet.ipv4 ?? null,
          capacity: DEFAULT_CAPACITY,
          region: droplet.region,
          status,
          metadata,
        });
        await this.emit(HEADLESS_EVENTS[status], droplet.name);
        console.log("[pool-sync] Discovered untracked instance, added to pool:", droplet.name);
        continue;
      }

      await this.db.instances.update({ id: existing.id }, { status, address: droplet.ipv4, metadata });
      if (existing.status !== status) {
        await this.emit(HEADLESS_EVENTS[status], droplet.name);
      }
      // Keep the in-memory map fresh so later phases see the updated status.
      existing.status = status;
      poolMap.set(droplet.name, existing);
    }
  }

  /** Phase 2: remove instances that no longer have a matching droplet. */
  private async removeStaleInstances(poolEntries: Awaited<ReturnType<typeof this.db.instances.list>>["instances"], dropletMap: Map<string, VirtualMachine>): Promise<void> {
    for (const entry of poolEntries) {
      if (!dropletMap.has(entry.tag) && entry.kind === "pool") {
        await this.db.instances.removePool(entry.id);
        await this.emit(EVENTS.POOL.INSTANCE_DATA_CLEARED.code, entry.tag);
      }
    }
  }

  /** Phase 3: mark offline / unreachable pool instances as maintenance. */
  private async demoteUnhealthyInstancesToMaintenance(poolMap: Map<string, { id: string; tag: string; status: InstanceStatus }>): Promise<void> {
    const unhealthyStatuses = new Set<InstanceStatus>(["offline", "unreachable"]);
    for (const entry of poolMap.values()) {
      if (unhealthyStatuses.has(entry.status) && entry.status !== "maintenance") {
        await this.db.instances.update({ id: entry.id }, { status: "maintenance" });
        await this.emit(EVENTS.POOL.INSTANCE_MAINTENANCE.code, entry.tag);
      }
    }
  }

  /** Phase 4: allocates unassigned clusters with available instances
   *  Provisions new compute if `PoolCapacityExceededError`.*/
  private async allocateUnassignedCapacity(currentDropletCount: number): Promise<void> {
    if (currentDropletCount >= INSTANCE_POOL_QUOTA) return;

    const lock = await this.kv.kv.get(KV_KEYS.POOL_PROVISION_LOCK);
    if (lock) return;

    const unassigned = await this.db.instances.listUnassignedClusters();
    for (const { id: clusterId } of unassigned) {
      const plan = await this.db.billing.getEffectivePlan(clusterId);
      await this.allocateForPlan(clusterId, plan);
      await this.emit("allocated", EVENTS.POOL.INSTANCE_ALLOCATED.code);
    }
  }

  /** Phase 5: sync dedicated instance statuses against provider state. */
  private async syncDedicatedInstances(dedicated: { id: string; tag: string; status: InstanceStatus }[], dropletMap: Map<string, VirtualMachine>): Promise<void> {
    for (const instance of dedicated) {
      const droplet = dropletMap.get(instance.tag);
      let next: InstanceStatus;

      if (!droplet) next = "offline";
      else if (droplet.status !== "active") next = "unreachable";
      else continue;

      if (instance.status !== next) {
        await this.db.instances.update({ id: instance.id }, { status: next });
        await this.emit(HEADLESS_EVENTS[next], instance.tag);
      }
    }
  }

  /** Drain (migrate clusters + destroy) all maintenance pool instances. */
  private async nodesDrain(poolEntries: { id: string; tag: string; status: InstanceStatus; kind: string }[]): Promise<void> {
    if (!this.vm) return;

    const maintenanceInstances = poolEntries.filter((e) => e.status === "maintenance");
    if (maintenanceInstances.length === 0) return;

    const [clusterMap, droplets] = await Promise.all([this.db.instances.getPoolClustersMap(), this.vm.list({ tagName: "managed", perPage: 200 })]);
    const dropletMap = new Map(droplets.map((d) => [d.name, d]));

    for (const instance of maintenanceInstances) {
      const assignedClusterIds = clusterMap.filter((m) => m.instanceId === instance.id).map((m) => m.clusterId);

      const allMigrated = await this.migrateClusters(assignedClusterIds);
      if (!allMigrated) continue;

      await this.destroyDroplet(instance, dropletMap);
    }
  }

  /** Attempt to migrate all clusters off an instance. Returns true only when every cluster migrated successfully. */
  private async migrateClusters(clusterIds: string[]): Promise<boolean> {
    if (clusterIds.length === 0) return true;

    let allMigrated = true;
    for (const clusterId of clusterIds) {
      try {
        await this.db.instances.assignPool(clusterId);
        await this.emit(EVENTS.POOL.INSTANCE_ALLOCATED.code, clusterId);
      } catch (err) {
        if (err instanceof PoolCapacityExceededError) {
          allMigrated = false;
        } else {
          throw err;
        }
      }
    }
    return allMigrated;
  }

  /** Destroy the VM droplet and clean up its DB record. */
  private async destroyDroplet(instance: { id: string; tag: string }, dropletMap: Map<string, VirtualMachine & { id?: number | string }>): Promise<void> {
    const droplet = dropletMap.get(instance.tag);
    if (droplet?.id) {
      try {
        await this.vm!.delete(droplet.id);
        await this.emit(EVENTS.POOL.INSTANCE_DRAINED.code, droplet.name);
      } catch (err) {
        console.error(`[pool-drain] Failed to delete droplet ${droplet.name}:`, err);
        return; // don't remove from DB if delete failed
      }
    }

    await this.db.instances.removePool(instance.id);
    await this.emit(EVENTS.POOL.INSTANCE_DATA_CLEARED.code, instance.tag);
  }

  /** Statuses that are terminal/manual and should not be touched by heartbeat checks. */
  private isStaticStatus(status: InstanceStatus): boolean {
    return status === "maintenance" || status === "offline" || status === "unreachable";
  }

  /** Derive status from heartbeat data alone (does not touch the network). */
  private async resolveHeartbeatStatus(tag: string, windowStart: number): Promise<InstanceStatus> {
    if (!this.conn.hasNodeConnection(tag)) return "degraded";

    const nodeUpdate = await this.kv.getNodeUpdate(tag);
    const isRecent = typeof nodeUpdate?.lastUpdated === "number" && nodeUpdate.lastUpdated >= windowStart;
    const isHealthy = (nodeUpdate as NodeUpdateV1_1)?.health?.overall === "ok";
    return isRecent && isHealthy ? "healthy" : "degraded";
  }

  /** Confirm a status change with a TCP probe. */
  private async confirmStatusViaTcp(address: string): Promise<InstanceStatus> {
    const reachable = await tcpReachable(address);
    return reachable ? "healthy" : "unreachable";
  }

  /** Map a provider droplet's state to an InstanceStatus. */
  private resolveProviderStatus(droplet: VirtualMachine | undefined): InstanceStatus {
    if (!droplet) return "unreachable";
    if (droplet.status !== "active") return "offline";
    // Reachable at provider level, but connection health is unconfirmed.
    return "degraded";
  }

  private extractTier(tags?: string[]): string {
    if (!tags) return "hobby";
    for (const tier of ["pro", "indie", "hobby"]) {
      if (tags.includes(tier)) return tier;
    }
    return "hobby";
  }

  private async allocateForPlan(clusterId: string, plan: SubscriptionPlan): Promise<void> {
    switch (plan) {
      case "hobby":
        await this.pool.allocateSharedPool(clusterId);
        break;
      case "indie":
        console.log(`[pool-sync] Indie allocation not yet implemented for cluster ${clusterId}`);
        break;
      case "pro":
        console.log(`[pool-sync] Pro dedicated instance not yet implemented for cluster ${clusterId}`);
        break;
    }
  }
}
