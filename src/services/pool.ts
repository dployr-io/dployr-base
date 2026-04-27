import { InstanceStatus, NodeUpdateV1_1, SubscriptionPlan } from "@/types/index.js";
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

  private async createInstancePool(): Promise<void> {
    if (!this.vm || !this.jwt) return;

    const instanceId = ulid();
    const name = "instance-pool-" + Date.now().toString();

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

    await this.db.instancePool.add({
      address: droplet.ipv4 ?? null,
      capacity: DEFAULT_CAPACITY,
      tag: name,
      region: droplet.region,
      status: "healthy",
    });
  }

  public async spawnPoolInstance({ clusterId }: { clusterId: string }): Promise<void> {
    try {
      await this.createInstancePool();
      await this.db.instancePool.assign(clusterId);
    } catch (err) {
      console.error("[Auth/Pools] Failed to provision pool instance for cluster", clusterId, err);
    }
  }

  public async poolSync() {
    if (!this.vm) {
      console.log("[pool-sync] Skipped — no VM provider configured");
      return;
    }

    // Phase 1: mirror provider → pool DB
    const [droplets, { instances: poolEntries }] = await Promise.all([this.vm.list({ tagName: "managed", perPage: 200 }), this.db.instancePool.list()]);

    const poolByTag = new Map(poolEntries.map((e: { tag: any }) => [e.tag, e]));
    const dropletByTag = new Map(droplets.map((d: VirtualMachine) => [d.name, d]));

    for (const droplet of droplets) {
      if (!poolByTag.has(droplet.name)) {
        await this.db.instancePool.add({
          tag: droplet.name,
          address: droplet.ipv4 ?? null,
          capacity: 10,
          region: droplet.region,
          status: "healthy",
          metadata: { managed: true, tier: "hobby" },
        });
        console.log("[pool-sync] Discovered untracked instance, added to pool:", droplet.name);
      }
    }

    // Phase 2: health triage — remove stale entries, mark degraded instances for maintenance
    const unhealthyStatuses = new Set<InstanceStatus>(["degraded", "offline", "unreachable"]);

    for (const entry of poolEntries) {
      if (!dropletByTag.has(entry.tag)) {
        await this.db.instancePool.remove(entry.id);
        continue;
      }

      if (unhealthyStatuses.has(entry.status)) {
        await this.db.instancePool.update({ id: entry.id, data: { status: "maintenance" } });
        await this.kv.logSystemEvent({
          type: EVENTS.POOL.INSTANCE_MAINTENANCE.code,
          targets: [{ id: entry.id }],
        });
      }
    }

    // Phase 3: proactive allocation — ensure every unassigned cluster has an instance
    if (droplets.length < INSTANCE_POOL_QUOTA) {
      const lock = await this.kv.kv.get(KV_KEYS.POOL_PROVISION_LOCK);
      if (!lock) {
        const unassigned = await this.db.clusters.listUnassigned();
        if (unassigned.length > 0) {
          console.log(`[pool-sync] ${unassigned.length} cluster(s) unassigned — allocating`);
        }
        for (const { id: clusterId } of unassigned) {
          const plan = await this.db.subscriptions.getEffectivePlan(clusterId);
          await this.allocateForPlan(clusterId, plan);
        }
      }
    }

    // Phase 4: sync dedicated instances against provider
    const { instances: dedicatedInstances } = await this.db.instances.list();
    for (const instance of dedicatedInstances) {
      const droplet = dropletByTag.get(instance.tag);
      let next: InstanceStatus;

      if (!droplet) {
        next = "offline";
      } else if (droplet.status !== "active") {
        next = "unreachable";
      } else {
        continue;
      }

      if (instance.status !== next) {
        await this.db.instances.update({ id: instance.id }, { status: next });
        console.log(`[pool-sync] Instance ${instance.tag} → ${next}`);
      }
    }
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
      await this.db.instancePool.assign(clusterId);
      console.log(`[pool-sync] Assigned shared pool instance to cluster ${clusterId}`);
    } catch (err) {
      if (!(err instanceof PoolCapacityExceededError)) throw err;

      if (!this.vm || !this.jwt) {
        console.log(`[pool-sync] Pool at capacity for cluster ${clusterId} — VM or JWT service not configured, cannot provision`);
        return;
      }

      console.log(`[pool-sync] Pool at capacity — provisioning new instance for cluster ${clusterId}`);
      await this.kv.kv.put(KV_KEYS.POOL_PROVISION_LOCK, "1", { ttl: POOL_PROVISION_LOCK_TTL });
      await this.createInstancePool();
      await this.db.instancePool.assign(clusterId);
      await this.kv.logSystemEvent({ type: EVENTS.POOL.INSTANCE_PROVISIONED.code });
      console.log(`[pool-sync] Provisioned and assigned new instance to cluster ${clusterId}`);
    }
  }

  public async poolDrain() {
    if (!this.vm) return;
    const { instances: poolEntries } = await this.db.instancePool.list();
    const maintenanceInstances = poolEntries.filter((e: { status: string }) => e.status === "maintenance");
    if (maintenanceInstances.length === 0) return;

    const [clusterMap, droplets] = await Promise.all([this.db.instancePool.getClustersInstanceMap(), this.vm.list({ tagName: "managed", perPage: 200 })]);

    const dropletByTag = new Map(droplets.map((d: VirtualMachine) => [d.name, d]));

    for (const instance of maintenanceInstances) {
      const assignedClusters = clusterMap.filter((m: { instanceId: any }) => m.instanceId === instance.id).map((m: { clusterId: any }) => m.clusterId);

      if (assignedClusters.length > 0) {
        let migratedAll = true;

        for (const clusterId of assignedClusters) {
          try {
            await this.db.instancePool.assign(clusterId);
          } catch (err) {
            if (err instanceof PoolCapacityExceededError) {
              migratedAll = false;
            } else {
              throw err;
            }
          }
        }

        if (!migratedAll) continue;
      }

      const droplet = dropletByTag.get(instance.tag);
      if (droplet?.id) {
        try {
          await this.vm.delete(droplet.id);
        } catch {
          continue;
        }
      }

      await this.db.instancePool.remove(instance.id);

      await this.kv.logSystemEvent({
        type: EVENTS.POOL.INSTANCE_DRAINED.code,
        targets: [{ id: instance.id }],
      });
    }
  }

  public async poolPing() {
    if (!this.vm) return;
    const { instances: poolEntries } = await this.db.instancePool.list();
    const candidates = poolEntries.filter((e: { status: string }) => e.status !== "maintenance");
    if (candidates.length === 0) return;

    const droplets = await this.vm.list({ tagName: "managed", perPage: 200 });
    const dropletByTag = new Map(droplets.map((d: VirtualMachine) => [d.name, d]));

    for (const entry of candidates) {
      const droplet = dropletByTag.get(entry.tag);
      let next: InstanceStatus;

      if (!droplet) next = "unreachable";
      else if (droplet.status !== "active") next = "offline";
      else continue;

      if (entry.status !== next) {
        await this.db.instancePool.update({ id: entry.id, data: { status: next } });
      }
    }
  }

  public async poolPingDirect() {
    const { instances: poolEntries } = await this.db.instancePool.list();
    const candidates = poolEntries.filter((e: { address: any; status: string }) => e.address && e.status !== "maintenance" && e.status !== "offline" && e.status !== "unreachable");

    await Promise.all(
      candidates.map(async (entry) => {
        const reachable = await tcpReachable(entry.address!);
        const next: InstanceStatus = reachable ? "healthy" : "degraded";

        if (entry.status !== next) {
          await this.db.instancePool.update({ id: entry.id, data: { status: next } });
        }
      }),
    );
  }

  public async poolHealth() {
    const { instances: poolEntries } = await this.db.instancePool.list();
    const candidates = poolEntries.filter((e: { status: string }) => e.status !== "maintenance" && e.status !== "offline" && e.status !== "unreachable");
    const windowStart = Date.now() - HEARTBEAT_WINDOW;

    for (const entry of candidates) {
      const nodeUpdate = await this.kv.getNodeUpdate(entry.tag);
      const isFresh = typeof nodeUpdate?.lastUpdated === "number" && nodeUpdate.lastUpdated >= windowStart;
      const isHealthy = (nodeUpdate as NodeUpdateV1_1)?.health?.overall === undefined || (nodeUpdate as any).health.overall === "healthy";
      const next: InstanceStatus = isFresh && isHealthy ? "healthy" : "degraded";

      if (entry.status !== next) {
        await this.db.instancePool.update({ id: entry.id, data: { status: next } });
      }
    }
  }

  async resolveInstancePool({ db, billingService, clusterId }: { db: DatabaseStore; billingService: BillingService | null; clusterId?: string }) {
    if (!clusterId || !billingService) return null;

    const status = await billingService.getStatus({ clusterId, db });
    if (status.plan !== "hobby") return null;

    const [instanceId, { instances: pool }] = await Promise.all([db.instancePool.getClusterInstance(clusterId), db.instancePool.list()]);

    if (!instanceId) return null;

    const instance = pool.find((inst: { id: string }) => inst.id === instanceId);
    if (!instance) return null;

    const now = Date.now();

    return {
      ...instance,
      metadata: { ...instance.metadata, managed: true },
      clusterId,
      createdAt: now,
      updatedAt: now,
    };
  }
}
