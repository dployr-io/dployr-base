// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { NodeUpdate, NodeUpdateV1, NodeUpdateV1_1 } from "@/types/node.js";

export class UpdateProcessor {
  constructor(
    private db: DatabaseStore,
    private kv: KVStore,
  ) {}

  async processUpdate(tag: string, message: NodeUpdate): Promise<void> {
    if (!message.instance_id) {
      console.warn(`[UpdateProcessor] Update missing instance_id`);
      return;
    }

    const tasks: Promise<void>[] = [];

    // Handle v1 schema
    if (message.schema === "v1") {
      const v1Message = message as NodeUpdateV1;
      if (v1Message.top && v1Message.seq) {
        tasks.push(this.saveProcessSnapshot({ tag, seq: v1Message.seq, snapshot: v1Message.top }));
      }
      if (v1Message.services) {
        tasks.push(this.syncServices(tag, v1Message.services));
      }
    }

    // Handle v1.1 schema
    if (message.schema === "v1.1") {
      const v1_1Message = message as NodeUpdateV1_1;
      if (v1_1Message.processes?.list && v1_1Message.sequence) {
        tasks.push(this.saveProcessSnapshot({ tag, seq: v1_1Message.sequence, snapshot: { list: v1_1Message.processes.list } }));
      }
      if (v1_1Message.workloads?.services) {
        tasks.push(this.syncServices(tag, v1_1Message.workloads.services));
      }
    }

    tasks.push(this.kv.saveNodeUpdate({ tag, update: message as Record<string, unknown> }));

    await Promise.all(tasks);
  }

  private async saveProcessSnapshot({ tag, seq, snapshot }: { tag: string; seq: number; snapshot: Record<string, unknown> }): Promise<void> {
    try {
      await this.kv.saveProcessSnapshot({ tag, seq, snapshot });
    } catch (error) {
      console.error(`[UpdateProcessor] Failed to save process snapshot:`, error);
    }
  }

  private async syncServices(tag: string, services: Record<string, unknown>[]): Promise<void> {
    if (!Array.isArray(services)) return;

    try {
      const instance = await this.db.instances.find({ tag });
      if (!instance) {
        console.warn(`[UpdateProcessor] Instance ${tag} not found`);
        return;
      }

      const clusterId = instance.clusterId;
      if (!clusterId) {
        console.warn(`[UpdateProcessor] Instance ${tag} has no clusterId`);
        return;
      }

      const incomingServiceNames = new Set(services.map((s) => s.name as string));
      const existingServices = await this.db.services.list({ clusterId }); // now defined
      const existingServiceNames = new Set(existingServices.map((s) => s.name));

      const hasChanges = existingServiceNames.size !== incomingServiceNames.size || Array.from(incomingServiceNames).some((name) => !existingServiceNames.has(name));

      if (!hasChanges) return;

      const toCreate = services.filter((s) => !existingServiceNames.has(s.name as string));
      const toDelete = existingServices.filter((s) => !incomingServiceNames.has(s.name));

      for (const service of toCreate) {
        const svc = service as { name: string };
        try {
          await this.db.services.upsert({ instanceTag: tag, name: svc.name });
          console.log(`[UpdateProcessor] Created service: ${svc.name}`);
        } catch (error) {
          console.error(`[UpdateProcessor] Failed to create service ${svc.name}:`, error);
        }
      }

      for (const service of toDelete) {
        try {
          await this.db.services.delete({ id: service.id }); // delete by id, not name
          console.log(`[UpdateProcessor] Deleted service: ${service.name}`);
        } catch (error) {
          console.error(`[UpdateProcessor] Failed to delete service ${service.name}:`, error);
        }
      }
    } catch (error) {
      console.error(`[UpdateProcessor] Failed to sync services:`, error);
    }
  }
}
