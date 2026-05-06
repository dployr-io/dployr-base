import { InstanceStatus, SubscriptionPlan } from "@/types/index.js";
import { NodeUpdateV1_1 } from "@/types/node.js";
import { ACCEPTABLE_HEARTBEAT_WINDOW } from "../constants/duration.js";
import { tcpReachable } from "../net.js";
import { EventEmittable } from "@/services/notifications/emittable.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { VmProvider } from "@/services/vm/index.js";
import { EVENTS, HEADLESS_EVENTS } from "../constants/events.js";
import { ConnectionManager } from "@/services/websocket/connection-manager.js";
import { VirtualMachine } from "@/types/vm.js";
import { INSTANCE_POOL_QUOTA } from "../constants/instances.js";
import { KV_KEYS } from "../constants/kv.js";
import { DEFAULT_CAPACITY, PROVIDER_TO_INSTANCE_REGION } from "../constants/vm.js";
import { InstancePool } from "@/services/pool.js";
import { InstancePayload } from "../db/store/db/instances.js";

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
    console.debug("[node-health] Starting node heartbeat...");

    const { instances } = await this.db.instances.list({ managed: true });

    console.debug("[node-health] Found instances", instances.length);
    if (instances.length === 0) return;

    const windowStart = Date.now() - ACCEPTABLE_HEARTBEAT_WINDOW * 1000;

    console.debug("[node-health] Computed candidates", instances);
    for (const entry of instances) {
      const heartbeatStatus = await this.resolveHeartbeatStatus(entry.tag, windowStart, entry.kind);
      if (entry.status === heartbeatStatus) continue;

      try {
        const tcpStatus = await this.confirmStatusViaTcp(entry.address!);
        console.debug("[node-health] tcp status", tcpStatus);
        const _status = tcpStatus !== "healthy" ? tcpStatus : heartbeatStatus;
        await this.db.instances.update({ id: entry.id }, { status: _status });
        if (_status === "degraded") {
          const alreadyFlagged = await this.kv.instanceCache.checkForDecommissionFlag({ instanceId: entry.tag });
          if (!alreadyFlagged) {
            await this.kv.instanceCache.setFlagForDecommission({ tag: entry.tag });
            await this.emit(EVENTS.NODE.DECOMMISSIONED.code, entry.tag);
          }
        }
      } catch (err) {
        console.error(`[node-health] Failed to update ${entry.tag} status:`, err);
      }
    }
    console.debug("[node-health] Completed node heartbeat");
  }

  /** Full synchronisation of pool state with the VM provider. */
  public async nodesSync(): Promise<void> {
    console.debug("[node-sync] Starting node sync...");
    if (!this.vm) {
      console.log("[node-sync] Skipped — no VM provider configured");
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
    console.debug("[node-sync] Completed node sync");
  }

  /** Phase 1: upsert each provider droplet into the DB. */
  private async syncDropletsAndInstances(droplets: VirtualMachine[], poolMap: Map<string, InstancePayload & { id: string }>): Promise<void> {
    for (const droplet of droplets) {
      const existing = poolMap.get(droplet.name);
      const status = this.resolveProviderStatus(droplet) as InstanceStatus;
      const metadata = {
        managed: (droplet.tags ?? []).includes("managed"),
        tier: this.extractTier(droplet.tags),
      };

      if (!existing) {
        const added = await this.db.instances.addPool({
          tag: droplet.name,
          address: droplet.ipv4 ?? null,
          capacity: DEFAULT_CAPACITY,
          region: PROVIDER_TO_INSTANCE_REGION[droplet.region],
          status,
          metadata,
        });
        // update in‑memory map
        poolMap.set(droplet.name, {
          id: added.id, // make sure addPool returns the new instance
          tag: droplet.name,
          address: droplet.ipv4 ?? null,
          status,
          metadata,
          capacity: DEFAULT_CAPACITY,
        });
        await this.emit(HEADLESS_EVENTS[status], droplet.name);
        console.log("[node-sync] Discovered untracked instance, added to pool:", droplet.name);
        continue;
      }

      const addressChanged = existing.address?.trim() !== droplet.ipv4?.trim();
      const metadataChanged = existing.metadata?.managed !== metadata.managed || existing.metadata?.tier !== metadata.tier;

      if (!addressChanged && !metadataChanged) {
        continue;
      }

      await this.db.instances.update({ id: existing.id }, { address: droplet.ipv4 ?? null, metadata });

      await this.emit(EVENTS.INSTANCE.UPDATED.code, droplet.name);

      // update in‑memory map
      existing.status = status;
      existing.address = droplet.ipv4 ?? null;
      existing.metadata = metadata;
      poolMap.set(droplet.name, existing);
    }
  }

  /** Phase 2: remove instances that no longer have a matching droplet. */
  private async removeStaleInstances(poolEntries: Awaited<ReturnType<typeof this.db.instances.list>>["instances"], dropletMap: Map<string, VirtualMachine>): Promise<void> {
    for (const entry of poolEntries) {
      if (!dropletMap.has(entry.tag) && entry.kind === "pool") {
        console.debug("[node-sync] removing stale entry from database: ", entry);
        await this.db.instances.removePool(entry.id);
        await this.emit(EVENTS.NODE.DATA_CLEARED.code, entry.tag);
      }
    }
  }

  /** Phase 3: mark offline / unreachable pool instances as maintenance. */
  private async demoteUnhealthyInstancesToMaintenance(poolMap: Map<string, { id: string; tag: string; status: InstanceStatus }>): Promise<void> {
    const demotableStatuses = new Set<InstanceStatus>(["offline", "unreachable", "degraded"]);

    for (const entry of poolMap.values()) {
      console.debug("[node-sync] Identifying node entry: ", entry);
      if (!demotableStatuses.has(entry.status)) {
        console.debug("[node-sync] No demotable entries. Skipping...");
        continue;
      }

      // Don't demote a degraded instance that is still in its recovery window
      if (entry.status === "degraded" && (await this.kv.instanceCache.isInRecoveryWindow({ tag: entry.tag }))) {
        console.debug("[node-sync] recovery entry, skipping...: ", entry);
        continue;
      }

      await this.db.instances.update({ id: entry.id }, { status: "maintenance" });
      await this.emit(EVENTS.NODE.MAINTENANCE.code, entry.tag);
    }
  }

  /** Phase 4: allocates unassigned clusters with available instances
   *  Provisions new compute if `PoolCapacityExceededError`.*/
  private async allocateUnassignedCapacity(currentDropletCount: number): Promise<void> {
    if (currentDropletCount >= INSTANCE_POOL_QUOTA) return;

    const lock = await this.kv.kv.get(KV_KEYS.POOL.PROVISION_LOCK);
    if (lock) {
      console.debug("[node-sync] Pool provisioning lock is active. Skipping...");
      return;
    }

    const unassigned = await this.db.instances.listUnassignedClusters();
    for (const { id: clusterId } of unassigned) {
      const plan = await this.db.billing.getEffectivePlan(clusterId);
      await this.allocateForPlan(clusterId, plan);
      await this.emit("allocated", EVENTS.NODE.ALLOCATED.code);
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

      console.debug("[node-sync] Identifying dedicated instance: ", dedicated);

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
    console.debug("[node-sync] Maintenance instances detected: ", maintenanceInstances);
    if (maintenanceInstances.length === 0) return;

    const [clusterMap, droplets] = await Promise.all([this.db.instances.getPoolClustersMap(), this.vm.list({ tagName: "managed", perPage: 200 })]);
    const dropletMap = new Map(droplets.map((d) => [d.name, d]));

    for (const instance of maintenanceInstances) {
      const assignedClusterIds = clusterMap.filter((m) => m.instanceId === instance.id).map((m) => m.clusterId);
      console.debug("[node-sync] Assigned clusterIds: ", assignedClusterIds);

      const allMigrated = await this.migrateClusters(assignedClusterIds);
      if (!allMigrated) continue;

      await this.destroyDroplet(instance, dropletMap);
    }
  }

  /** Attempt to migrate all clusters off an instance. Returns true only when every cluster migrated successfully. */
  private async migrateClusters(clusterIds: string[]): Promise<boolean> {
    let allMigrated = true;
    if (clusterIds.length === 0) return allMigrated;

    for (const clusterId of clusterIds) {
      try {
        await this.pool.allocateSharedPool(clusterId);
        await this.emit(EVENTS.NODE.ALLOCATED.code, clusterId);
      } catch (err) {
        console.error("[node-sync] Error while migrating clusters: ", err);
        allMigrated = false;
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
        await this.emit(EVENTS.NODE.DRAINED.code, droplet.name);
      } catch (err) {
        console.error(`[pool-drain] Failed to delete droplet ${droplet.name}:`, err);
        return; // don't remove from DB if delete failed
      }
    }

    await this.db.instances.removePool(instance.id);
    await this.emit(EVENTS.NODE.DATA_CLEARED.code, instance.tag);
  }

  /** Derive status from heartbeat data alone (does not touch the network). */
  private async resolveHeartbeatStatus(tag: string, windowStart: number, kind: string): Promise<InstanceStatus> {
    const singleCheck = async (): Promise<InstanceStatus> => {
      // 1. Look for active connections
      const connKey = kind === "pool" ? `pool:${tag}` : tag;
      const nodeConns = this.conn.getNodeConnections(connKey);
      if (!nodeConns.length) {
        console.debug(`[heartbeat] ${tag}: no active WebSocket connection → degraded`);
        return "degraded";
      }

      const now = Date.now();
      const newestConnection = Math.max(...nodeConns.map((c) => c.connectedAt));
      const connectionAge = now - newestConnection;

      // 2. If the connection is still "fresh" (within the acceptable heartbeat window)
      if (connectionAge < ACCEPTABLE_HEARTBEAT_WINDOW * 1000) {
        const nodeUpdate = await this.getNodeUpdate(tag);
        if (nodeUpdate?.health?.overall === "ok") {
          console.debug(`[heartbeat] ${tag}: connection alive (${connectionAge}ms), last health ok → healthy`);
          return "healthy";
        } else {
          console.debug(`[heartbeat] ${tag}: connection alive (${connectionAge}ms), but last health is "${nodeUpdate?.health?.overall}" (not ok) → falling back to KV recency`);
          // Fall through to KV check
        }
      } else {
        console.debug(`[heartbeat] ${tag}: connection age (${connectionAge}ms) exceeds window → falling back to KV recency`);
      }

      // 3. Fallback: normal KV-based recency + health check
      const nodeUpdate = await this.getNodeUpdate(tag);
      const updateTime = nodeUpdate?.timestamp ? new Date(nodeUpdate.timestamp).getTime() : 0;
      const isRecent = updateTime >= windowStart;
      const isHealthy = nodeUpdate?.health?.overall === "ok";

      console.debug(
        `[heartbeat] ${tag}: KV updateTime=${updateTime} (${new Date(updateTime).toISOString()}), ` +
          `isRecent=${isRecent}, overall=${nodeUpdate?.health?.overall}, ` +
          `windowStart=${windowStart} (${new Date(windowStart).toISOString()})`,
      );

      if (isRecent && isHealthy) {
        console.debug(`[heartbeat] ${tag}: KV update is recent and healthy → healthy`);
        return "healthy";
      } else {
        if (!isRecent && !isHealthy) {
          console.debug(`[heartbeat] ${tag}: KV update stale AND health not ok → degraded`);
        } else if (!isRecent) {
          console.debug(`[heartbeat] ${tag}: KV update is stale (older than window) → degraded`);
        } else {
          console.debug(`[heartbeat] ${tag}: health is "${nodeUpdate?.health?.overall}" (not ok) → degraded`);
        }
        return "degraded";
      }
    };

    // Immediate first attempt
    let status = await singleCheck();
    console.debug(`[heartbeat] ${tag}: initial check → ${status}`);
    if (status === "healthy") return status;

    // Retry loop unchanged
    const deadline = Date.now() + 8_000;
    let attempt = 1;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      status = await singleCheck();
      attempt++;
      console.debug(`[heartbeat] ${tag}: retry #${attempt} → ${status}`);
      if (status === "healthy") {
        console.info(`[heartbeat] ${tag}: recovered after ${attempt} attempts (${Date.now() - deadline + 8_000}ms)`);
        return "healthy";
      }
    }

    console.debug(`[heartbeat] ${tag}: timed out after ${attempt} retries, marking degraded`);
    return "degraded";
  }

  private async getNodeUpdate(tag: string): Promise<Partial<NodeUpdateV1_1> | null> {
    const [healthEntity, statusEntity] = await Promise.all([
      this.kv.entities.getEntity<NodeUpdateV1_1["health"]>(KV_KEYS.INSTANCE.ENTITY(tag, "health")),
      this.kv.entities.getEntity<NodeUpdateV1_1["status"]>(KV_KEYS.INSTANCE.ENTITY(tag, "status")),
    ]);

    if (!healthEntity && !statusEntity) return null;

    const timestamp = Math.max(healthEntity?.timestamp ?? 0, statusEntity?.timestamp ?? 0);
    return {
      health: healthEntity?.data,
      status: statusEntity?.data,
      timestamp: timestamp ? new Date(timestamp).toISOString() : undefined,
    };
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
        console.log(`[node-sync] Indie allocation not yet implemented for cluster ${clusterId}`);
        break;
      case "pro":
        console.log(`[node-sync] Pro dedicated instance not yet implemented for cluster ${clusterId}`);
        break;
    }
  }
}
