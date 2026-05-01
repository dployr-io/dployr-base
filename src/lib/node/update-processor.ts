// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ulid } from "ulid";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { Service } from "@/types/index.js";
import { NodeUpdate, NodeUpdateV1, NodeUpdateV1_1 } from "@/types/node.js";
import type { ConnectionManager } from "@/services/websocket/connection-manager.js";
import type { JWTService } from "@/services/auth/jwt.js";
import type { DployrdService } from "@/services/dployrd.js";

/**
 * Processes a single node update message — short-lived, one instance per message.
 *
 * Responsible for reconciling the node's reported state with the database:
 * - persists process snapshots to KV
 * - upserts/removes services that have appeared or disappeared
 * - syncs deployments reported by the node
 *
 * Supports both the legacy v1 schema and the current v1.1 schema.
 */
export class UpdateProcessor {
  private db: DatabaseStore;
  private kv: KVStore;
  private tag: string;
  private message: NodeUpdate | NodeUpdateV1_1;
  private tasks: Promise<void>[];
  private servicesChanged = false;
  private deploymentsChanged = false;
  private connectionManager?: ConnectionManager;
  private jwtService?: JWTService;
  private dployrdService?: DployrdService;

  constructor({
    db,
    kv,
    tag,
    message,
    connectionManager,
    jwtService,
    dployrdService,
  }: {
    db: DatabaseStore;
    kv: KVStore;
    tag: string;
    message: NodeUpdate | NodeUpdateV1_1;
    connectionManager?: ConnectionManager;
    jwtService?: JWTService;
    dployrdService?: DployrdService;
  }) {
    this.db = db;
    this.kv = kv;
    this.tag = tag;
    this.message = message;
    this.tasks = [];
    this.connectionManager = connectionManager;
    this.jwtService = jwtService;
    this.dployrdService = dployrdService;
  }

  /** Entry point — fans out to schema-specific handlers then awaits all queued tasks. */
  async processUpdate(): Promise<{ servicesChanged: boolean; deploymentsChanged: boolean }> {
    if (!this.message.instance_id) {
      console.warn(`[UpdateProcessor] Update missing instance_id`);
      return { servicesChanged: false, deploymentsChanged: false };
    }

    this.handleMessageV1();
    this.handleMessageV1_1();

    this.tasks.push(this.kv.saveNodeUpdate({ tag: this.tag, update: this.message as Record<string, unknown> }));

    await Promise.all(this.tasks);
    return { servicesChanged: this.servicesChanged, deploymentsChanged: this.deploymentsChanged };
  }

  private async saveProcessSnapshot({ seq, snapshot }: { seq: number; snapshot: Record<string, unknown> }): Promise<void> {
    try {
      await this.kv.saveProcessSnapshot({ tag: this.tag, seq, snapshot });
    } catch (error) {
      console.error(`[UpdateProcessor] Failed to save process snapshot:`, error);
    }
  }

  /** @deprecated */
  private async handleMessageV1() {
    if (this.message.schema !== "v1") return;
    const v1Message = this.message as NodeUpdateV1;
    if (v1Message.top && v1Message.seq) {
      this.tasks.push(this.saveProcessSnapshot({ seq: v1Message.seq, snapshot: v1Message.top }));
    }
    if (v1Message.services) {
      this.tasks.push(this.syncServices(v1Message.services));
    }
    if (v1Message.deployments) {
      this.tasks.push(this.syncDeployments(v1Message.deployments));
    }
  }

  private async handleMessageV1_1() {
    if (this.message.schema === "v1.1") {
      const v1_1Message = this.message as NodeUpdateV1_1;
      if (v1_1Message.processes?.list && v1_1Message.sequence) {
        this.tasks.push(this.saveProcessSnapshot({ seq: v1_1Message.sequence, snapshot: { list: v1_1Message.processes.list } }));
      }
      if (v1_1Message.workloads?.services) {
        this.tasks.push(this.syncServices(v1_1Message.workloads.services));
      }
      if (v1_1Message.workloads?.deployments) {
        this.tasks.push(this.syncDeployments(v1_1Message.workloads.deployments));
      }
    }
  }

  /** Resolves the cluster ID for this tag, or returns null with a warning if not found. */
  private async resolveClusterId(): Promise<string | null> {
    const instance = await this.db.instances.find({ tag: this.tag });
    if (!instance) {
      console.warn(`[UpdateProcessor] Instance ${this.tag} not found`);
      return null;
    }
    if (!instance.clusterId) {
      console.warn(`[UpdateProcessor] Instance ${this.tag} has no clusterId`);
      return null;
    }
    return instance.clusterId;
  }

  private async syncServices(services: Record<string, unknown>[]): Promise<void> {
    if (!Array.isArray(services)) return;

    try {
      const clusterId = await this.resolveClusterId();
      if (!clusterId) return;

      const incomingServiceNames = new Set(services.map((s) => s.name as string));
      const existingServices = await this.db.services.list({ clusterId });
      const existingServiceNames = new Set(existingServices.map((s) => s.name));

      const hasChanges =
        existingServiceNames.size !== incomingServiceNames.size || Array.from(incomingServiceNames).some((name) => !existingServiceNames.has(name));

      if (!hasChanges) return;
      this.servicesChanged = true;

      const toCreate = services.filter((s) => !existingServiceNames.has(s.name as string));
      const toReprovision = existingServices.filter((s) => !incomingServiceNames.has(s.name));

      await Promise.all([
        ...toCreate.map(async (service) => {
          const svc = service as unknown as Service;
          try {
            await this.db.services.upsert({ instanceTag: this.tag, name: svc.name, type: svc.type });
            console.log(`[UpdateProcessor] Created service: ${svc.name}`);
          } catch (error) {
            console.error(`[UpdateProcessor] Failed to create service ${svc.name}:`, error);
          }
        }),
        ...toReprovision.map((service) => this.reprovisionService(service, clusterId)),
      ]);
    } catch (error) {
      console.error(`[UpdateProcessor] Failed to sync services:`, error);
    }
  }

  private async reprovisionService(service: Service, clusterId: string): Promise<void> {
    if (!this.connectionManager || !this.jwtService || !this.dployrdService) {
      console.warn(`[UpdateProcessor] Cannot reprovision ${service.name}: reprovision dependencies not injected`);
      return;
    }

    if (!service.deploymentId) {
      console.warn(`[UpdateProcessor] Service ${service.name} has no deployment reference — skipping reprovision`);
      return;
    }

    if (!this.db.serviceSecrets) {
      console.warn(`[UpdateProcessor] Cannot reprovision ${service.name}: encryption not configured`);
      return;
    }

    try {
      const deployment = await this.db.deployments.get(service.deploymentId);
      if (!deployment) {
        console.warn(`[UpdateProcessor] Deployment ${service.deploymentId} not found for service ${service.name} — skipping reprovision`);
        return;
      }

      const blueprint = { ...deployment.blueprint } as Record<string, any>;
      const secretKeys = Object.keys(blueprint.secrets ?? {});

      if (secretKeys.length > 0) {
        const { values, missing } = await this.db.serviceSecrets.getDecrypted({ serviceId: service.id, keys: secretKeys });

        if (missing.length > 0) {
          // If failed to re-provision due to missing secret, prompt user to re-renter values
          console.error(
            `[UpdateProcessor] Cannot reprovision ${service.name}: secrets expired or missing — [${missing.join(", ")}]. ` +
              `User must supply these values again.`,
          );
          return;
        }

        blueprint.secrets = values;
      }

      const instance = await this.db.instances.find({ tag: this.tag });
      const routingKey = instance?.kind === "pool" ? `pool:${this.tag}` : clusterId;

      const taskId = ulid();
      const token = await this.jwtService.createNodeAccessToken(this.tag);
      const task = this.dployrdService.createDeployTask(taskId, blueprint as any, token);

      const sent = this.connectionManager.sendTask(routingKey, task);
      if (sent) {
        console.log(`[UpdateProcessor] Reprovisioning service ${service.name} via task ${taskId}`);
      } else {
        console.warn(`[UpdateProcessor] No connected node to reprovision ${service.name}`);
      }
    } catch (error) {
      console.error(`[UpdateProcessor] Failed to reprovision service ${service.name}:`, error);
    }
  }

  private async syncDeployments(deployments: Record<string, unknown>[]): Promise<void> {
    if (!Array.isArray(deployments)) return;

    try {
      const clusterId = await this.resolveClusterId();
      if (!clusterId) return;

      if (deployments.length > 0) this.deploymentsChanged = true;
      await Promise.all(
        deployments.map(async (deployment) => {
          const d = deployment as any;
          try {
            await this.db.deployments.upsert({ ...d });
          } catch (error) {
            console.error(`[UpdateProcessor] Failed to sync deployment ${d.id}:`, error);
          }
        }),
      );
    } catch (error) {
      console.error(`[UpdateProcessor] Failed to sync deployments:`, error);
    }
  }
}
