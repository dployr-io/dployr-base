// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Instance } from "@/types/index.js";
import { VmProvider } from "./vm/index.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { POOL_PROVISION_LOCK_TTL } from "@/lib/constants/index.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { EVENTS } from "@/lib/constants/events.js";
import { BillingService } from "./billing/index.js";
import { PoolCapacityExceededError } from "@/lib/errors/errors.js";
import { ulid } from "ulid";
import { JWTService } from "./auth/jwt.js";
import { DEFAULT_INSTANCE_IMAGE, DEFAULT_INSTANCE_REGION, DEFAULT_INSTANCE_SIZE, DEFAULT_INSTANCE_TAGS, buildInstallScript, DEFAULT_CAPACITY } from "@/lib/constants/vm.js";
import { EventEmittable } from "./notifications/emittable.js";

export class InstancePool extends EventEmittable {
  private readonly db: DatabaseStore;
  private readonly vm?: VmProvider;
  private readonly jwt?: JWTService;
  private readonly sshKey?: number;

  constructor({ db, kv, vm, jwt, sshKey }: { db: DatabaseStore; kv: KVStore; vm?: VmProvider; jwt?: JWTService; sshKey?: number }) {
    super(kv);
    this.db = db;
    this.vm = vm;
    this.jwt = jwt;
    this.sshKey = sshKey;
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

  public async allocateSharedPool(clusterId: string): Promise<void> {
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
