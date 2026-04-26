// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import { Service } from "@/types/index.js";

/** Fields that can be used to look up or filter services. */
export type ServiceFilter = {
  id?: string;
  name?: string;
  instanceId?: string;
};

export class ServiceStore extends BaseStore {
  /**
   * Creates a service record under the instance identified by `instanceTag`.
   * Returns `null` if no instance with that tag exists.
   */
  async create({ instanceTag, name }: { instanceTag: string; name: string }): Promise<Service | null> {
    const instanceResult = await this.db
      .prepare(`SELECT id FROM instances WHERE tag = $1`)
      .bind(instanceTag)
      .first();

    if (!instanceResult) return null;

    const instanceId = instanceResult.id as string;
    const id = this.generateId();
    const now = this.now();

    try {
      await this.db
        .prepare(`INSERT INTO services (id, instance_id, name, created_at, updated_at) VALUES ($1, $2, $3, $4, $5)`)
        .bind(id, instanceId, name, now, now)
        .run();
    } catch (error) {
      this.parsePostgresError({ error, table: "services" });
    }

    return { id, instanceId, name, createdAt: now, updatedAt: now };
  }

  /**
   * Returns the first service matching the given filter, or `null` if not found.
   * At least one filter field must be set.
   */
  async find(filter: ServiceFilter): Promise<Service | null> {
    const { clause, bindings } = this.buildWhere({
      id: filter.id,
      name: filter.name,
      instance_id: filter.instanceId,
    });
    if (!bindings.length) return null;

    const result = await this.db
      .prepare(`SELECT id, instance_id, name, created_at, updated_at FROM services ${clause} LIMIT 1`)
      .bind(...bindings)
      .first();

    return result ? this.toService(result) : null;
  }

  /**
   * Returns all services matching the given filter.
   * Omit `filter` (or pass `{}`) to list every service.
   */
  async list(filter?: ServiceFilter): Promise<Service[]> {
    const { clause, bindings } = this.buildWhere({ instance_id: filter?.instanceId });

    const results = bindings.length
      ? await this.db.prepare(`SELECT id, instance_id, name, created_at, updated_at FROM services ${clause} ORDER BY name ASC`).bind(...bindings).all()
      : await this.db.prepare(`SELECT id, instance_id, name, created_at, updated_at FROM services ORDER BY name ASC`).all();

    return results.results.map((r) => this.toService(r));
  }

  /**
   * Deletes services matching the given filter.
   * Accepts `id` or `name` as the lookup key.
   */
  async delete(filter: Pick<ServiceFilter, "id" | "name">): Promise<void> {
    const col = filter.id !== undefined ? "id" : "name";
    const val = filter.id ?? filter.name;
    if (!val) return;
    await this.db.prepare(`DELETE FROM services WHERE ${col} = $1`).bind(val).run();
  }

  private toService(row: any): Service {
    return {
      id: row.id as string,
      instanceId: row.instance_id as string,
      name: row.name as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
