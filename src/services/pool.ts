// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Instance } from "@/types/index.js";
import { VmProvider } from "./vm/index.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { POOL_PROVISION_LOCK_TTL } from "@/lib/constants/index.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { EVENTS } from "@/lib/constants/events.js";
import { PoolCapacityExceededError } from "@/lib/errors/errors.js";
import { JWTService } from "./auth/jwt.js";
import { DEFAULT_INSTANCE_IMAGE, DEFAULT_INSTANCE_REGION, DEFAULT_INSTANCE_SIZE, buildInstanceTags, buildInstallScript, PROVIDER_TO_INSTANCE_REGION } from "@/lib/constants/vm.js";
import type { SubscriptionPlan } from "@/types/index.js";
import { EventEmittable } from "./notifications/emittable.js";
import { randomBytes } from "node:crypto";
import { INSTANCE_NAMES, POOL_CAPACITY_BY_TIER } from "@/lib/constants/instances.js";
import { Logger } from "@/lib/logger.js";

export class InstancePool extends EventEmittable {
  private readonly db: DatabaseStore;
  private readonly vm?: VmProvider;
  private readonly jwt?: JWTService;
  private readonly sshKey?: number;
  private readonly log: Logger;

  constructor({ db, kv, vm, jwt, sshKey }: { db: DatabaseStore; kv: KVStore; vm?: VmProvider; jwt?: JWTService; sshKey?: number }) {
    super(kv);
    this.db = db;
    this.vm = vm;
    this.jwt = jwt;
    this.sshKey = sshKey;
    this.log = new Logger("pool");
  }

  /** Provision a brand‑new pool instance and assign it to a cluster. */
  public async spawnPoolInstance({ clusterId, tier }: { clusterId: string; tier: SubscriptionPlan }): Promise<void> {
    const cluster = await this.db.clusters.find({ id: clusterId });
    const clusterName = cluster?.name ?? clusterId;
    try {
      await this.createPoolInstance(tier);
      await this.db.instances.assignPool(clusterId);
    } catch (err) {
      this.log.error(`Failed to provision pool instance for cluster ${clusterName}`, { error: String(err) });
    }
  }

  /** Return a pool instance object for a hobby cluster (used by admin API). */
  public async resolveInstancePool({ db, clusterId }: { db: DatabaseStore; clusterId?: string }): Promise<Instance | null> {
    if (!clusterId) return null;

    const instanceId = await db.instances.getClusterPoolInstance(clusterId);
    if (!instanceId) return null;

    return await db.instances.find({ id: instanceId, kind: "pool" });
  }

  private async createPoolInstance(tier: SubscriptionPlan): Promise<void> {
    if (!this.vm || !this.jwt) return;

    const name = INSTANCE_NAMES[Math.floor(Math.random() * INSTANCE_NAMES.length)];
    const num = String(Math.floor(Math.random() * 100)).padStart(2, "0");
    const suffix = randomBytes(4).toString("base64url").slice(0, 5);
    const tag = `${name}${num}-${suffix}`;

    const token = await this.jwt.createBootstrapToken(tag);
    const decoded = await this.jwt.verifyToken(token);

    const droplet = await this.vm.create({
      image: DEFAULT_INSTANCE_IMAGE,
      name: tag,
      region: DEFAULT_INSTANCE_REGION,
      size: DEFAULT_INSTANCE_SIZE,
      tags: buildInstanceTags(tier),
      sshKey: this.sshKey,
      userData: buildInstallScript(token, tag),
    });

    // Create instance row before bootstrap token so the FK is satisfied.
    const instance = await this.db.instances.addPool({
      address: droplet.ipv4 ?? null,
      capacity: POOL_CAPACITY_BY_TIER[tier],
      tag,
      region: PROVIDER_TO_INSTANCE_REGION[droplet.region],
      status: "provisioning",
      metadata: { managed: true, tier },
    });

    await this.db.bootstrapTokens.create(instance.id, decoded.nonce as string);
  }

  /** Provision a dedicated instance and assign it directly to a pro cluster. */
  public async spawnDedicatedInstance({ clusterId, clusterName }: { clusterId: string; clusterName?: string | undefined }): Promise<void> {
    if (!this.vm || !this.jwt) return;

    const name = INSTANCE_NAMES[Math.floor(Math.random() * INSTANCE_NAMES.length)];
    const num = String(Math.floor(Math.random() * 100)).padStart(2, "0");
    const suffix = randomBytes(4).toString("base64url").slice(0, 5);
    const tag = `${name}${num}-${suffix}`;

    const token = await this.jwt.createBootstrapToken(tag);
    const decoded = await this.jwt.verifyToken(token);

    const droplet = await this.vm.create({
      image: DEFAULT_INSTANCE_IMAGE,
      name: tag,
      region: DEFAULT_INSTANCE_REGION,
      size: DEFAULT_INSTANCE_SIZE,
      tags: buildInstanceTags("pro"),
      sshKey: this.sshKey,
      userData: buildInstallScript(token, tag),
    });

    const instance = await this.db.instances.create({
      clusterId,
      data: {
        address: droplet.ipv4 ?? null,
        tag,
        region: PROVIDER_TO_INSTANCE_REGION[droplet.region],
        managed: true,
        status: "provisioning",
        metadata: { managed: true, tier: "pro" },
      },
    });

    await this.db.bootstrapTokens.create(instance.id, decoded.nonce as string);
    await this.emit(EVENTS.NODE.PROVISIONED.code, clusterId);
    this.log.info(`Provisioned dedicated instance for pro cluster ${clusterName ?? clusterId}`);
  }

  public async allocateSharedPool(clusterId: string, tier: SubscriptionPlan): Promise<void> {
    const cluster = await this.db.clusters.find({ id: clusterId });
    const clusterName = cluster?.name ?? clusterId;
    try {
      await this.db.instances.assignPool(clusterId);
      await this.emit(EVENTS.NODE.ALLOCATED.code, clusterId);
      this.log.info(`Assigned shared pool instance to cluster ${clusterName}`);
    } catch (err) {
      if (!(err instanceof PoolCapacityExceededError)) throw err;

      if (!this.vm || !this.jwt) {
        this.log.info(`Pool at capacity for cluster ${clusterName} — VM or JWT service not configured, cannot provision`);
        return;
      }

      const lockCount = await this.kv.kv.incr(KV_KEYS.POOL.PROVISION_LOCK, POOL_PROVISION_LOCK_TTL);
      if (lockCount > 1) {
        this.log.warn("Pool allocation and scheduling ongoing. Skipping...");
        return;
      }

      this.log.info(`Pool at capacity — provisioning new instance for cluster ${clusterName}`);
      await this.createPoolInstance(tier);
      await this.emit(EVENTS.NODE.PROVISIONED.code, clusterId);

      // Another concurrent caller may have already assigned a pool instance while we
      // were provisioning. Re-try only if this cluster is still unassigned.
      const alreadyAssigned = await this.db.instances.getClusterPoolInstance(clusterId);
      if (!alreadyAssigned) {
        await this.db.instances.assignPool(clusterId);
        await this.emit(EVENTS.NODE.ALLOCATED.code, clusterId);
      }
      this.log.info(`Provisioned and assigned new instance to cluster ${clusterName}`);
    }
  }
}
