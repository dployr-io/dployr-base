import { InstanceStatus, SubscriptionPlan } from "@/types/index.js";
import { NodeUpdateV1_1 } from "@/types/node.js";
import { ACCEPTABLE_HEARTBEAT_WINDOW, INSTANCE_STARTUP_GRACE_MS } from "../constants/duration.js";
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
import { DEFAULT_CAPACITY, INSTANCE_ENV_TAG, INSTANCE_MANAGED_TAG, INSTANCE_DO_NOT_REMOVE_TAG, PROVIDER_TO_INSTANCE_REGION } from "../constants/vm.js";
import { POOL_CAPACITY_BY_TIER } from "../constants/instances.js";
import { InstancePool } from "@/services/pool.js";
import { InstancePayload } from "../db/store/db/instances.js";
import { Logger } from "@/lib/logger.js";
import { DployrdService } from "@/services/dployrd.js";
import { JWTService } from "@/services/auth/jwt.js";
import { ulid } from "ulid";

export class NodeDoctor extends EventEmittable {
  protected readonly vm: VmProvider | null;
  protected readonly db: DatabaseStore;
  protected readonly conn: ConnectionManager;
  protected readonly pool: InstancePool;
  private readonly log: Logger;
  private readonly desiredBuildNodeCapacity: number;
  private decommissionHook?: () => void;

  constructor({ vm, kv, db, conn, pool, desiredBuildNodeCapacity }: { vm: VmProvider | null; kv: KVStore; db: DatabaseStore; conn: ConnectionManager; pool: InstancePool; desiredBuildNodeCapacity?: number }) {
    super(kv);
    this.vm = vm;
    this.db = db;
    this.conn = conn;
    this.pool = pool;
    this.desiredBuildNodeCapacity = desiredBuildNodeCapacity ?? 1;
    this.log = new Logger("node-doctor");
  }

  onDecommission(hook: () => void): void {
    this.decommissionHook = hook;
  }

  /** Health check based on daemon heartbeat. */
  public async nodeHeartbeat(): Promise<void> {
    this.log.debug("Starting node heartbeat...");

    const { instances } = await this.db.instances.list({ managed: true });

    this.log.debug("Found instances", { count: instances.length });
    if (instances.length === 0) return;

    const windowStart = Date.now() - ACCEPTABLE_HEARTBEAT_WINDOW * 1000;

    this.log.debug("Computed candidates", { count: instances.length });
    for (const entry of instances) {
      const hasConnection = this.conn.getNodeConnections(entry.tag).length > 0;
      if (!hasConnection && Date.now() - entry.createdAt < INSTANCE_STARTUP_GRACE_MS) {
        this.log.debug(`Skipping health check for ${entry.tag} — ${entry.status === "provisioning" ? "still provisioning, no connection yet" : "within startup grace period"}`);
        continue;
      }
      const heartbeatStatus = await this.resolveHeartbeatStatus(entry.tag, windowStart, entry.kind);
      if (entry.status === heartbeatStatus) continue;

      try {
        const tcpStatus = await this.confirmStatusViaTcp(entry.address!);
        this.log.debug("tcp status", { tcpStatus });
        const _status = tcpStatus !== "healthy" ? tcpStatus : heartbeatStatus;
        await this.db.instances.update({ id: entry.id }, { status: _status });
        if (_status === "degraded") {
          const alreadyFlagged = await this.kv.instanceCache.checkForDecommissionFlag({ instanceId: entry.tag });
          if (!alreadyFlagged) {
            await this.kv.instanceCache.setFlagForDecommission({ tag: entry.tag });
            await this.emit(EVENTS.NODE.DECOMMISSIONED.code, entry.tag);
            this.decommissionHook?.();
          }
        }
      } catch (err) {
        this.log.error(`Failed to update ${entry.tag} status`, { error: String(err) });
      }
    }
    this.log.debug("Completed node heartbeat");
  }

  /** Full synchronisation of pool state with the VM provider. */
  public async nodesSync(): Promise<void> {
    this.log.debug("Starting node sync...");
    if (!this.vm) {
      this.log.info("Skipped — no VM provider configured");
      return;
    }

    const [droplets, { instances: poolEntries }, { instances: dedicatedInstances }] = await Promise.all([
      this.vm.list({ tagName: INSTANCE_ENV_TAG, perPage: 200 }),
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
    await this.cleanupOrphanedDedicatedInstances(dropletMap);

    this.nodesDrain(poolEntries);
    this.log.debug("Completed node sync");
  }

  /** Phase 1: upsert each provider droplet into the DB. */
  private async syncDropletsAndInstances(droplets: VirtualMachine[], poolMap: Map<string, InstancePayload & { id: string }>): Promise<void> {
    for (const droplet of droplets) {
      if (!(droplet.tags ?? []).includes(INSTANCE_MANAGED_TAG)) continue;
      const existing = poolMap.get(droplet.name);
      const status = this.resolveProviderStatus(droplet) as InstanceStatus;
      const metadata = {
        managed: (droplet.tags ?? []).includes(INSTANCE_MANAGED_TAG),
        tier: this.extractTier(droplet.tags),
      };

      if (!existing) {
        const added = await this.db.instances.addPool({
          tag: droplet.name,
          address: droplet.ipv4 ?? null,
          capacity: POOL_CAPACITY_BY_TIER[metadata.tier as keyof typeof POOL_CAPACITY_BY_TIER] ?? DEFAULT_CAPACITY,
          region: PROVIDER_TO_INSTANCE_REGION[droplet.region],
          status,
          role: "instance",
          metadata,
        });
        // update in‑memory map
        poolMap.set(droplet.name, {
          id: added.id, // make sure addPool returns the new instance
          tag: droplet.name,
          address: droplet.ipv4 ?? null,
          status,
          role: "instance",
          metadata,
          capacity: DEFAULT_CAPACITY,
        });
        await this.emit(HEADLESS_EVENTS[status], droplet.name);
        this.log.info("Discovered untracked instance, added to pool", { droplet: droplet.name });
        continue;
      }

      const addressChanged = existing.address?.trim() !== droplet.ipv4?.trim();
      const metadataChanged = existing.metadata?.managed !== metadata.managed || existing.metadata?.tier !== metadata.tier;

      if (!addressChanged && !metadataChanged) {
        continue;
      }

      await this.db.instances.update({ id: existing.id }, { address: droplet.ipv4 ?? null, metadata });

      await this.emit(EVENTS.INSTANCE.UPDATED.code, droplet.name);

      // Preserve existing status in the map — status transitions are owned by nodeHeartbeat,
      // not inferred from provider state. A provisioning instance would otherwise get
      // overwritten with "degraded" here and immediately demoted to maintenance.
      existing.address = droplet.ipv4 ?? null;
      existing.metadata = metadata;
      poolMap.set(droplet.name, existing);
    }
  }

  /** Phase 2: remove instances that no longer have a matching droplet. */
  private async removeStaleInstances(poolEntries: Awaited<ReturnType<typeof this.db.instances.list>>["instances"], dropletMap: Map<string, VirtualMachine>): Promise<void> {
    for (const entry of poolEntries) {
      if (!dropletMap.has(entry.tag) && entry.kind === "pool") {
        this.log.debug("removing stale entry from database", { tag: entry.tag });
        await this.db.instances.removePool(entry.id);
        await this.emit(EVENTS.NODE.DATA_CLEARED.code, entry.tag);
      }
    }
  }

  /** Phase 3: mark offline / unreachable pool instances as maintenance. */
  private async demoteUnhealthyInstancesToMaintenance(poolMap: Map<string, { id: string; tag: string; status: InstanceStatus }>): Promise<void> {
    const demotableStatuses = new Set<InstanceStatus>(["offline", "unreachable", "degraded"]);
    // "provisioning" instances are still booting — never demote them here; nodeHeartbeat handles the transition

    for (const entry of poolMap.values()) {
      this.log.debug("Identifying node entry", { tag: entry.tag, status: entry.status });
      if (!demotableStatuses.has(entry.status)) {
        this.log.debug("No demotable entries. Skipping...");
        continue;
      }

      // Don't demote a degraded instance that is still in its recovery window
      if (entry.status === "degraded" && (await this.kv.instanceCache.isInRecoveryWindow({ tag: entry.tag }))) {
        this.log.debug("recovery entry, skipping...", { tag: entry.tag });
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
      this.log.debug("Pool provisioning lock is active. Skipping...");
      return;
    }

    const unassigned = await this.db.instances.listUnassignedClusters();
    for (const { id: clusterId, name: clusterName } of unassigned) {
      const plan = await this.db.billing.getEffectivePlan(clusterId);
      await this.allocateForPlan(clusterId, clusterName, plan);
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

      this.log.debug("Identifying dedicated instance", { count: dedicated.length });

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
    this.log.debug("Maintenance instances detected", { count: maintenanceInstances.length });
    if (maintenanceInstances.length === 0) return;

    const [clusterMap, droplets] = await Promise.all([this.db.instances.getPoolClustersMap(), this.vm.list({ tagName: INSTANCE_ENV_TAG, perPage: 200 })]);
    const dropletMap = new Map(droplets.map((d) => [d.name, d]));

    for (const instance of maintenanceInstances) {
      const assignedClusterIds = clusterMap.filter((m) => m.instanceId === instance.id).map((m) => m.clusterId);
      this.log.debug("Assigned clusterIds", { count: assignedClusterIds.length });

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
        const cluster = await this.db.clusters.find({ id: clusterId });
        const plan = await this.db.billing.getEffectivePlan(clusterId);
        await this.db.instances.releasePoolInstance(clusterId);
        await this.allocateForPlan(clusterId, cluster?.name ?? clusterId, plan);
        await this.emit(EVENTS.NODE.ALLOCATED.code, clusterId);
        await this.nudgePoolNode(clusterId);
      } catch (err) {
        this.log.error("Error while migrating clusters", { error: String(err) });
        allMigrated = false;
      }
    }
    return allMigrated;
  }

  /** Send a heartbeat request to the pool node assigned to a cluster, forcing an immediate full sync. */
  private async nudgePoolNode(clusterId: string): Promise<void> {
    const cluster = await this.db.clusters.find({ id: clusterId });
    if (!cluster?.poolInstanceId) return;
    const instance = await this.db.instances.find({ id: cluster.poolInstanceId });
    if (!instance?.tag) return;
    const conns = this.conn.getNodeConnections(instance.tag);
    if (conns.length === 0) return;
    try {
      conns[0].ws.send(JSON.stringify({ kind: "heartbeat" }));
      this.log.info(`Nudged pool node ${instance.tag} after cluster ${cluster.name} migration`);
    } catch (err) {
      this.log.warn(`Failed to nudge pool node ${instance.tag}`, { error: String(err) });
    }
  }

  /** Destroy the VM droplet and clean up its DB record. */
  private async destroyDroplet(instance: { id: string; tag: string }, dropletMap: Map<string, VirtualMachine & { id?: number | string }>): Promise<void> {
    const droplet = dropletMap.get(instance.tag);
    if (droplet) {
      if ((droplet.tags ?? []).includes(INSTANCE_DO_NOT_REMOVE_TAG)) {
        this.log.warn("Refusing to destroy protected droplet", { droplet: instance.tag });
        return;
      }
      try {
        await this.vm!.delete(instance.tag);
        await this.emit(EVENTS.NODE.DRAINED.code, droplet.name);
      } catch (err) {
        this.log.error(`Failed to delete droplet ${droplet.name}`, { error: String(err) });
        return;
      }
    }

    await this.db.instances.removePool(instance.id);
    await this.emit(EVENTS.NODE.DATA_CLEARED.code, instance.tag);
  }

  /** Derive status from heartbeat data alone (does not touch the network). */
  private async resolveHeartbeatStatus(tag: string, windowStart: number, kind: string): Promise<InstanceStatus> {
    const singleCheck = async (): Promise<InstanceStatus> => {
      // 1. Look for active connections
      const nodeConns = this.conn.getNodeConnections(tag);
      if (!nodeConns.length) {
        this.log.debug(`${tag}: no active WebSocket connection → degraded`);
        return "degraded";
      }

      const now = Date.now();
      const newestConnection = Math.max(...nodeConns.map((c) => c.connectedAt));
      const connectionAge = now - newestConnection;

      // 2. If the connection is still "fresh" (within the acceptable heartbeat window)
      if (connectionAge < ACCEPTABLE_HEARTBEAT_WINDOW * 1000) {
        const nodeUpdate = await this.getNodeUpdate(tag);
        if (nodeUpdate?.health?.overall === "ok") {
          this.log.debug(`${tag}: connection alive (${connectionAge}ms), last health ok → healthy`);
          return "healthy";
        } else {
          this.log.debug(`${tag}: connection alive (${connectionAge}ms), but last health is "${nodeUpdate?.health?.overall}" (not ok) → falling back to KV recency`);
          // Fall through to KV check
        }
      } else {
        this.log.debug(`${tag}: connection age (${connectionAge}ms) exceeds window → falling back to KV recency`);
      }

      // 3. Fallback: normal KV-based recency + health check
      const nodeUpdate = await this.getNodeUpdate(tag);
      const updateTime = nodeUpdate?.timestamp ? new Date(nodeUpdate.timestamp).getTime() : 0;
      const isRecent = updateTime >= windowStart;
      const isHealthy = nodeUpdate?.health?.overall === "ok";

      this.log.debug(
        `${tag}: KV updateTime=${updateTime} (${new Date(updateTime).toISOString()}), ` +
          `isRecent=${isRecent}, overall=${nodeUpdate?.health?.overall}, ` +
          `windowStart=${windowStart} (${new Date(windowStart).toISOString()})`,
      );

      if (isRecent && isHealthy) {
        this.log.debug(`${tag}: KV update is recent and healthy → healthy`);
        return "healthy";
      } else {
        if (!isRecent && !isHealthy) {
          this.log.debug(`${tag}: KV update stale AND health not ok → degraded`);
        } else if (!isRecent) {
          this.log.debug(`${tag}: KV update is stale (older than window) → degraded`);
        } else {
          this.log.debug(`${tag}: health is "${nodeUpdate?.health?.overall}" (not ok) → degraded`);
        }
        return "degraded";
      }
    };

    // Immediate first attempt
    let status = await singleCheck();
    this.log.debug(`${tag}: initial check → ${status}`);
    if (status === "healthy") return status;

    // Retry loop unchanged
    const deadline = Date.now() + 8_000;
    let attempt = 1;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      status = await singleCheck();
      attempt++;
      this.log.debug(`${tag}: retry #${attempt} → ${status}`);
      if (status === "healthy") {
        this.log.info(`${tag}: recovered after ${attempt} attempts (${Date.now() - deadline + 8_000}ms)`);
        return "healthy";
      }
    }

    this.log.debug(`${tag}: timed out after ${attempt} retries, marking degraded`);
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

  /** Phase 6: destroy dedicated VMs whose cluster_id was nulled by transitionToSharedPool. */
  private async cleanupOrphanedDedicatedInstances(dropletMap: Map<string, VirtualMachine & { id?: number | string }>): Promise<void> {
    if (!this.vm) return;
    const orphaned = await this.db.instances.listOrphanedDedicated();
    if (orphaned.length === 0) return;
    this.log.info(`Found ${orphaned.length} orphaned dedicated instance(s) to clean up`);
    for (const instance of orphaned) {
      await this.destroyDroplet(instance, dropletMap);
    }
  }

  /** Reconcile build node capacity and re-queue in-flight builds from degraded nodes. */
  public async buildNodeReconcile(): Promise<void> {
    const { instances: buildNodes } = await this.db.instances.list({ role: "build" as any });

    const degraded = buildNodes.filter((n) => ["degraded", "offline", "unreachable", "maintenance"].includes(n.status ?? ""));
    for (const node of degraded) {
      const inFlight = await this.kv.instanceCache.getInFlightBuilds(node.tag);
      if (inFlight.length > 0) {
        this.log.info(`Re-queuing ${inFlight.length} in-flight build(s) from degraded build node ${node.tag}`);
        for (const entry of inFlight) {
          await this.kv.payloads.enqueueBuild({ ...entry, enqueuedAt: Date.now() });
        }
        await this.kv.instanceCache.clearInFlightBuilds(node.tag);
        await this.kv.kv.delete(KV_KEYS.BUILD.SLOTS(node.tag));
      }
    }

    const UNHEALTHY = new Set(["degraded", "offline", "unreachable", "maintenance"]);
    const active = buildNodes.filter((n) => !UNHEALTHY.has(n.status ?? "")).length;
    if (active >= this.desiredBuildNodeCapacity) return;

    const healthy = buildNodes.filter((n) => n.status === "healthy").length;
    const deficit = this.desiredBuildNodeCapacity - active;
    this.log.info(`Build node deficit: ${deficit} (active: ${active}, healthy: ${healthy}, desired: ${this.desiredBuildNodeCapacity})`);
    for (let i = 0; i < deficit; i++) {
      try {
        await this.pool.spawnBuildNode();
      } catch (err) {
        this.log.error("Failed to provision build node", { error: String(err) });
      }
    }
  }

  /**
   * Checks disk usage on every healthy managed instance from the latest
   * cached node update. Warns (once per 24h) at >70% and provisions a
   * 25 GB DO block volume + sends a mount task at >85%.
   */
  public async checkDiskPressure(): Promise<void> {
    if (!this.vm) return;

    const { instances } = await this.db.instances.list({ managed: true });
    const dployrd = new DployrdService();
    const jwt = new JWTService(this.kv);

    for (const instance of instances) {
      if (instance.status !== "healthy") continue;
      if (!instance.address) continue;

      const resourcesEntity = await this.kv.entities.getEntity<NodeUpdateV1_1["resources"]>(
        KV_KEYS.INSTANCE.ENTITY(instance.tag, "resources"),
      );
      const disks = resourcesEntity?.data?.disks;
      if (!disks || disks.length === 0) continue;

      type Disk = { mount_point: string; total_bytes: number; used_bytes: number; available_bytes: number; filesystem: string };

      // Pick /var/lib/docker first, then /, then the largest disk
      const rootDisk: Disk =
        (disks as Disk[]).find((d) => d.mount_point === "/var/lib/docker") ??
        (disks as Disk[]).find((d) => d.mount_point === "/") ??
        (disks as Disk[]).reduce((a, b) => (b.total_bytes > a.total_bytes ? b : a));

      const usedPct = rootDisk.used_bytes / rootDisk.total_bytes;

      if (usedPct >= 0.85) {
        // Guard: don't provision if one is already in flight
        const alreadyProvisioning = await this.kv.kv.get(KV_KEYS.INSTANCE.VOLUME_PROVISIONING(instance.tag));
        if (alreadyProvisioning) continue;

        this.log.warn(`Disk pressure critical on ${instance.tag} (${Math.round(usedPct * 100)}%) — provisioning volume`);

        try {
          await this.kv.kv.put(KV_KEYS.INSTANCE.VOLUME_PROVISIONING(instance.tag), "1", { ttl: 60 * 60 * 2 }); // 2h lock

          // DO Volumes need the region slug; fall back to nyc1
          const region = (instance.metadata as any)?.region ?? "nyc1";
          const volName = `dployr-${instance.tag}-storage-${ulid().slice(-6).toLowerCase()}`;
          const dropletId = (instance.metadata as any)?.dropletId as number | undefined;

          if (!dropletId) {
            this.log.warn(`No dropletId in metadata for ${instance.tag} — cannot attach volume`);
            continue;
          }

          const volumeId = await this.vm.createVolume(dropletId, region, 25, volName);
          await this.vm.attachVolume(volumeId, dropletId);

          // Send mount task to the node daemon
          const taskId = ulid();
          const token = await jwt.createNodeAccessToken(instance.tag, { issuer: "dployr-base", audience: "dployr-instance" });
          const task = dployrd.createStorageMountTask(taskId, `/dev/disk/by-id/scsi-0DO_Volume_${volName}`, "/var/lib/docker", token);
          this.conn.sendTask(instance.tag, task);

          await this.emit(EVENTS.NODE.HEALTHY.code, instance.tag);
          this.log.info(`Provisioned and attached 25 GB volume ${volName} to ${instance.tag}`);
        } catch (err) {
          this.log.error(`Failed to provision volume for ${instance.tag}`, { error: String(err) });
          await this.kv.kv.delete(KV_KEYS.INSTANCE.VOLUME_PROVISIONING(instance.tag));
        }
      } else if (usedPct >= 0.70) {
        const alreadyWarned = await this.kv.kv.get(KV_KEYS.INSTANCE.DISK_WARN_SENT(instance.tag));
        if (alreadyWarned) continue;

        this.log.warn(`Disk pressure warning on ${instance.tag} (${Math.round(usedPct * 100)}%)`);
        await this.kv.kv.put(KV_KEYS.INSTANCE.DISK_WARN_SENT(instance.tag), "1", { ttl: 60 * 60 * 24 });
        await this.emit(EVENTS.NODE.HEALTHY.code, instance.tag);
      } else {
        // Clear warn flag once pressure drops below threshold
        await this.kv.kv.delete(KV_KEYS.INSTANCE.DISK_WARN_SENT(instance.tag));
      }
    }
  }

  private async allocateForPlan(clusterId: string, clusterName: string, plan: SubscriptionPlan): Promise<void> {
    switch (plan) {
      case "hobby":
      case "indie":
        await this.pool.allocateSharedPool(clusterId, plan);
        break;
      case "pro":
        await this.db.instances.releasePoolInstance(clusterId);
        await this.pool.spawnDedicatedInstance({ clusterId, clusterName });
        break;
    }
  }
}
