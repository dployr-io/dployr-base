// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import { Service } from "@/types/index.js";

export type ServiceFilter = {
  id?: string;
  name?: string;
  clusterId?: string;
};

export class ServiceStore extends BaseStore {
  /**
   * Upserts a service under the cluster that owns the instance identified by `instanceTag`.
   * No-ops if (cluster_id, name) already exists.
   * Returns `null` if no instance with that tag exists.
   */
  async upsert({ instanceTag, name }: { instanceTag: string; name: string }): Promise<Service | null> {
    const instanceResult = await this.db.prepare(`SELECT cluster_id FROM instances WHERE tag = $1`).bind(instanceTag).first();

    if (!instanceResult || !instanceResult.cluster_id) return null;

    const clusterId = instanceResult.cluster_id as string;
    const id = this.generateId();
    const now = this.now();

    try {
      const result = await this.db
        .prepare(
          `INSERT INTO services (id, cluster_id, name, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (cluster_id, name) DO NOTHING`,
        )
        .bind(id, clusterId, name, now, now)
        .run();

      if (result.meta.changes > 0) return { id, clusterId, name, createdAt: now, updatedAt: now };
      const existing = await this.db.prepare(`SELECT id, cluster_id, name, created_at, updated_at FROM services WHERE cluster_id = $1 AND name = $2`).bind(clusterId, name).first();
      return existing ? this.toService(existing) : null;
    } catch (error) {
      this.parsePostgresError({ error, table: "services" });
    }
  }

  async find(filter: ServiceFilter): Promise<Service | null> {
    const { clause, bindings } = this.buildWhere({
      id: filter.id,
      name: filter.name,
      cluster_id: filter.clusterId,
    });
    if (!bindings.length) return null;

    const result = await this.db
      .prepare(`SELECT id, cluster_id, name, created_at, updated_at FROM services ${clause} LIMIT 1`)
      .bind(...bindings)
      .first();

    return result ? this.toService(result) : null;
  }

  async list(filter?: ServiceFilter): Promise<Service[]> {
    const { clause, bindings } = this.buildWhere({ cluster_id: filter?.clusterId });

    const results = bindings.length
      ? await this.db
          .prepare(`SELECT id, cluster_id, name, created_at, updated_at FROM services ${clause} ORDER BY name ASC`)
          .bind(...bindings)
          .all()
      : await this.db.prepare(`SELECT id, cluster_id, name, created_at, updated_at FROM services ORDER BY name ASC`).all();

    return results.results.map((r) => this.toService(r));
  }

  async delete(filter: Pick<ServiceFilter, "id" | "name">): Promise<void> {
    const col = filter.id !== undefined ? "id" : "name";
    const val = filter.id ?? filter.name;
    if (!val) return;
    await this.db.prepare(`DELETE FROM services WHERE ${col} = $1`).bind(val).run();
  }

  private toService(row: any): Service {
    return {
      id: row.id as string,
      clusterId: row.cluster_id as string,
      name: row.name as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
