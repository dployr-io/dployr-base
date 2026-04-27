// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Instance, InstanceStatus, NodeUpdateV1_1, SubscriptionPlan } from "@/types/index.js";
import { VmProvider } from "./vm/index.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { HEARTBEAT_WINDOW, INSTANCE_POOL_QUOTA, POOL_PROVISION_LOCK_TTL } from "@/lib/constants/index.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { EVENTS } from "@/lib/constants/events.js";
import { BillingService } from "./billing/index.js";
import { PoolCapacityExceededError } from "@/lib/errors/errors.js";
import { tcpReachable } from "@/lib/net.js";
import { ulid } from "ulid";
import { JWTService } from "./auth/jwt.js";
import { DEFAULT_INSTANCE_IMAGE, DEFAULT_INSTANCE_REGION, DEFAULT_INSTANCE_SIZE, DEFAULT_INSTANCE_TAGS, buildInstallScript, DEFAULT_CAPACITY } from "@/lib/constants/vm.js";
import { VirtualMachine } from "@/types/vm.js";

/** Maps an InstanceStatus to the corresponding event code. */
const STATUS_EVENT: Record<InstanceStatus, string> = {
  healthy: EVENTS.POOL.INSTANCE_HEALTHY.code,
  degraded: EVENTS.POOL.INSTANCE_DEGRADED.code,
  offline: EVENTS.POOL.INSTANCE_OFFLINE.code,
  unreachable: EVENTS.POOL.INSTANCE_UNREACHABLE.code,
  maintenance: EVENTS.POOL.INSTANCE_MAINTENANCE.code,
};

export class InstancePoolService {
  private readonly db: DatabaseStore;
  private readonly kv: KVStore;
  private readonly vm?: VmProvider;
  private readonly jwt?: JWTService;
  private readonly sshKey?: number;

  constructor({ db, kv, vm, jwt, sshKey }: { db: DatabaseStore; kv: KVStore; vm?: VmProvider; jwt?: JWTService; sshKey?: number }) {
    this.db = db;
    this.kv = kv;
    this.vm = vm;
    this.jwt = jwt;
    this.sshKey = sshKey;
  }

  /** Full synchronisation of pool state with the VM provider. */
  public async poolSync(): Promise<void> {
    if (!this.vm) {
      console.log("[pool-sync] Skipped — no VM provider configured");
      return;
    }

    const [droplets, { instances: poolEntries }] = await Promise.all([this.vm.list({ tagName: "managed", perPage: 200 }), this.db.instances.listPool()]);

    const poolMap = new Map(poolEntries.map((e) => [e.tag, e]));
    const dropletMap = new Map(droplets.map((d: VirtualMachine) => [d.name, d]));

    // Phase 1: sync each droplet with the DB
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
        await this.emit(STATUS_EVENT[status], droplet.name);
        console.log("[pool-sync] Discovered untracked instance, added to pool:", droplet.name);
        continue;
      }

      // Update existing entry and refresh in-memory map to avoid stale status later
      await this.db.instances.update({ id: existing.id }, { status, address: droplet.ipv4, metadata });
      if (existing.status !== status) {
        await this.emit(STATUS_EVENT[status], droplet.name);
      }
      // Update in-memory map so phase 2 sees the new status
      existing.status = status;
      poolMap.set(droplet.name, existing);
    }

    // Phase 2: remove DB entries without a matching droplet
    for (const entry of poolEntries) {
      if (!dropletMap.has(entry.tag)) {
        await this.db.instances.removePool(entry.id);
        await this.emit(EVENTS.POOL.INSTANCE_DATA_CLEARED.code, entry.tag);
      }
    }

    // Phase 3: promote unhealthy instances to maintenance (only offline/unreachable)
    const maintenanceCandidates = new Set<InstanceStatus>(["offline", "unreachable"]);
    for (const entry of poolMap.values()) {
      if (maintenanceCandidates.has(entry.status) && entry.status !== "maintenance") {
        await this.db.instances.update({ id: entry.id }, { status: "maintenance" });
        await this.emit(EVENTS.POOL.INSTANCE_MAINTENANCE.code, entry.tag);
      }
    }

    // Phase 4: allocate missing pool instances for unassigned clusters
    if (droplets.length < INSTANCE_POOL_QUOTA) {
      const lock = await this.kv.kv.get(KV_KEYS.POOL_PROVISION_LOCK);
      if (!lock) {
        const unassigned = await this.db.instances.listUnassignedClusters();
        for (const { id: clusterId } of unassigned) {
          const plan = await this.db.billing.getEffectivePlan(clusterId);
          await this.allocateForPlan(clusterId, plan);
        }
      }
    }

    // Phase 5: sync dedicated instances
    const { instances: dedicated } = await this.db.instances.list({ kind: "dedicated" });
    for (const instance of dedicated) {
      const droplet = dropletMap.get(instance.tag);
      let next: InstanceStatus;
      if (!droplet) next = "offline";
      else if (droplet.status !== "active") next = "unreachable";
      else continue;

      if (instance.status !== next) {
        await this.db.instances.update({ id: instance.id }, { status: next });
        await this.emit(STATUS_EVENT[next], instance.tag);
      }
    }
  }

  /** Drain (migrate clusters + destroy) all maintenance pool instances. */
  public async poolDrain(): Promise<void> {
    if (!this.vm) return;

    const { instances: poolEntries } = await this.db.instances.listPool();
    const maintenanceInstances = poolEntries.filter((e) => e.status === "maintenance");
    if (maintenanceInstances.length === 0) return;

    const [clusterMap, droplets] = await Promise.all([this.db.instances.getPoolClustersMap(), this.vm.list({ tagName: "managed", perPage: 200 })]);
    const dropletMap = new Map(droplets.map((d) => [d.name, d]));

    for (const instance of maintenanceInstances) {
      const assignedClusterIds = clusterMap.filter((m) => m.instanceId === instance.id).map((m) => m.clusterId);

      // Migrate clusters to healthy pool instances
      if (assignedClusterIds.length > 0) {
        let allMigrated = true;
        for (const clusterId of assignedClusterIds) {
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
        if (!allMigrated) continue; // can't drain yet, skip
      }

      // Destroy the VM
      const droplet = dropletMap.get(instance.tag);
      if (droplet?.id) {
        try {
          await this.vm.delete(droplet.id);
          await this.emit(EVENTS.POOL.INSTANCE_DRAINED.code, droplet.name);
        } catch (err) {
          console.error(`[pool-drain] Failed to delete droplet ${droplet.name}:`, err);
          continue; // don't remove from DB if delete failed
        }
      }

      // Remove DB record
      await this.db.instances.removePool(instance.id);
      await this.emit(EVENTS.POOL.INSTANCE_DATA_CLEARED.code, instance.tag);
    }
  }

  /** Provider-level ping – checks droplet status and updates accordingly. */
  public async poolPing(): Promise<void> {
    if (!this.vm) return;

    const { instances: poolEntries } = await this.db.instances.listPool();
    if (poolEntries.length === 0) return;

    const droplets = await this.vm.list({ tagName: "managed", perPage: 200 });
    const dropletMap = new Map(droplets.map((d) => [d.name, d]));

    for (const entry of poolEntries) {
      const droplet = dropletMap.get(entry.tag);
      let next: InstanceStatus;

      if (!droplet) {
        next = "unreachable";
      } else if (droplet.status !== "active") {
        next = "offline";
      } else {
        next = "degraded"; // instance is reachable at provider level, but we're unsure of dployrd connection status
      }

      try {
        await this.db.instances.update({ id: entry.id }, { status: next });
        await this.emit(STATUS_EVENT[next], entry.tag);
      } catch (err) {
        console.error(`[pool-ping] Failed to update ${entry.tag} to ${next}:`, err);
      }
    }
  }

  /** Direct TCP ping – sets healthy/degraded. */
  public async poolPingDirect(): Promise<void> {
    const { instances: poolEntries } = await this.db.instances.listPool();
    const candidates = poolEntries.filter((e) => !!e.address);

    await Promise.all(
      candidates.map(async (entry) => {
        const reachable = await tcpReachable(entry.address!);
        const next: InstanceStatus = reachable ? "healthy" : "degraded";

        if (entry.status !== next) {
          try {
            await this.db.instances.update({ id: entry.id }, { status: next });
            await this.emit(STATUS_EVENT[next], entry.tag);
          } catch (err) {
            console.error(`[pool-ping-direct] Failed to update ${entry.tag} to ${next}:`, err);
          }
        }
      }),
    );
  }

  /** Health check based on daemon heartbeat */
  public async poolHealth(): Promise<void> {
    const { instances: poolEntries } = await this.db.instances.listPool();
    const candidates = poolEntries.filter((e) => e.status !== "maintenance" && e.status !== "offline" && e.status !== "unreachable");
    const windowStart = Date.now() - HEARTBEAT_WINDOW;

    for (const entry of candidates) {
      const connected = await this.kv.isNodeConnected(entry.tag);

      let next: InstanceStatus;
      if (!connected) {
        next = "degraded";
      } else {
        const nodeUpdate = await this.kv.getNodeUpdate(entry.tag);
        const isRecent = typeof nodeUpdate?.lastUpdated === "number" && nodeUpdate.lastUpdated >= windowStart;
        const overallHealthy = (nodeUpdate as NodeUpdateV1_1)?.health?.overall === "ok";
        next = isRecent && overallHealthy ? "healthy" : "degraded";
      }

      if (entry.status !== next) {
        try {
          await this.db.instances.update({ id: entry.id }, { status: next });
          await this.emit(STATUS_EVENT[next], entry.tag);
        } catch (err) {
          console.error(`[pool-health] Failed to update ${entry.tag} to ${next}:`, err);
        }
      }
    }
  }

  /** Provision a brand‑new pool instance and assign it to a cluster. */
  public async spawnPoolInstance({ clusterId }: { clusterId: string }): Promise<void> {
    try {
      await this.createPoolInstance();
      await this.db.instances.assignPool(clusterId);
    } catch (err) {
      console.error("[Pools] Failed to provision pool instance for cluster", clusterId, err);
    }
  }

  /** Return a pool instance object for a hobby cluster (used by admin API). */
  public async resolveInstancePool({ db, billingService, clusterId }: { db: DatabaseStore; billingService: BillingService | null; clusterId?: string }): Promise<Instance | null> {
    if (!clusterId || !billingService) return null;

    const status = await billingService.getStatus({ clusterId, db });
    if (status.plan !== "hobby") return null;

    const instanceId = await db.instances.getClusterPoolInstance(clusterId);
    if (!instanceId) return null;

    const instance = await db.instances.find({ id: instanceId, kind: "pool" });
    if (!instance) return null;

    const now = Date.now();
    return {
      ...instance,
      metadata: { ...instance.metadata, managed: true },
      createdAt: now,
      updatedAt: now,
    };
  }

  /* ------------------------------------------------------------------ */
  /*  Private helpers                                                    */
  /* ------------------------------------------------------------------ */

  /** Emit a system event with the given event code and target tag. */
  private async emit(type: string, tag: string): Promise<void> {
    try {
      await this.kv.logSystemEvent({
        type,
        targets: [{ id: tag }],
      });
    } catch (err) {
      console.error(`[pool-event] Failed to emit ${type} for ${tag}:`, err);
    }
  }

  private extractTier(tags?: string[]): string {
    if (!tags) return "hobby";
    for (const tier of ["pro", "indie", "hobby"]) {
      if (tags.includes(tier)) return tier;
    }
    return "hobby";
  }

  private async createPoolInstance(): Promise<void> {
    if (!this.vm || !this.jwt) return;

    const instanceId = ulid();
    const name = `instance-pool-${Date.now()}`;

    const token = await this.jwt.createBootstrapToken(name);
    const decoded = await this.jwt.verifyToken(token);
    await this.db.bootstrapTokens.create(instanceId, decoded.nonce as string);

    const droplet = await this.vm.create({
      image: DEFAULT_INSTANCE_IMAGE,
      name,
      region: DEFAULT_INSTANCE_REGION,
      size: DEFAULT_INSTANCE_SIZE,
      tags: DEFAULT_INSTANCE_TAGS,
      sshKey: this.sshKey,
      userData: buildInstallScript(token, name),
    });

    await this.db.instances.addPool({
      address: droplet.ipv4 ?? null,
      capacity: DEFAULT_CAPACITY,
      tag: name,
      region: droplet.region,
      status: "healthy",
    });
  }

  private async allocateForPlan(clusterId: string, plan: SubscriptionPlan): Promise<void> {
    switch (plan) {
      case "hobby":
        await this.allocateSharedPool(clusterId);
        break;
      case "indie":
        console.log(`[pool-sync] Indie allocation not yet implemented for cluster ${clusterId}`);
        break;
      case "pro":
        console.log(`[pool-sync] Pro dedicated instance not yet implemented for cluster ${clusterId}`);
        break;
    }
  }

  private async allocateSharedPool(clusterId: string): Promise<void> {
    try {
      await this.db.instances.assignPool(clusterId);
      await this.emit(EVENTS.POOL.INSTANCE_ALLOCATED.code, clusterId);
      console.log(`[pool-sync] Assigned shared pool instance to cluster ${clusterId}`);
    } catch (err) {
      if (!(err instanceof PoolCapacityExceededError)) throw err;

      if (!this.vm || !this.jwt) {
        console.log(`[pool-sync] Pool at capacity for cluster ${clusterId} — VM or JWT service not configured, cannot provision`);
        return;
      }

      console.log(`[pool-sync] Pool at capacity — provisioning new instance for cluster ${clusterId}`);
      await this.kv.kv.put(KV_KEYS.POOL_PROVISION_LOCK, "1", { ttl: POOL_PROVISION_LOCK_TTL });
      await this.createPoolInstance();
      await this.emit(EVENTS.POOL.INSTANCE_PROVISIONED.code, clusterId);
      await this.db.instances.assignPool(clusterId);
      await this.emit(EVENTS.POOL.INSTANCE_ALLOCATED.code, clusterId);
      console.log(`[pool-sync] Provisioned and assigned new instance to cluster ${clusterId}`);
    }
  }
}
