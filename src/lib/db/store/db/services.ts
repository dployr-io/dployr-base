// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import { Service, ServiceType } from "@/types/index.js";

export type ServiceFilter = {
  id?: string;
  name?: string;
  type?: ServiceType;
  clusterId?: string;
};

export class ServiceStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "services";

  /**
   * Upserts a service under the cluster that owns the instance identified by `instanceTag`.
   * No-ops if (cluster_id, name) already exists.
   * Returns `null` if no instance with that tag exists.
   */
  async upsert({ instanceTag, name, type }: { instanceTag: string; name: string; type: ServiceType }): Promise<Service | null> {
    const id = this.generateId();
    const now = this.now();

    try {
      return await this.db.withTransaction(async (client) => {
        const instanceResult = await this.db
          .prepare(`SELECT cluster_id FROM instances WHERE tag = $1`)
          .bind(instanceTag)
          .executeWithClient(client);

        if (!instanceResult.rows.length || !instanceResult.rows[0].cluster_id) return null;

        const clusterId = instanceResult.rows[0].cluster_id as string;

        const insertResult = await this.db
          .prepare(
            `INSERT INTO services (id, cluster_id, name, type, created_at, updated_at)
              VALUES ($1, $2, $3, $4, $5, $6)
              ON CONFLICT (cluster_id, name) DO NOTHING`,
          )
          .bind(id, clusterId, name, type, now, now)
          .executeWithClient(client);

        if (insertResult.rowCount && insertResult.rowCount > 0) {
          return { id, clusterId, name, type, deploymentId: null, createdAt: now, updatedAt: now };
        }

        const existing = await this.db
          .prepare(`SELECT id, cluster_id, name, type, deployment_id, created_at, updated_at FROM services WHERE cluster_id = $1 AND name = $2`)
          .bind(clusterId, name)
          .executeWithClient(client);

        return existing.rows[0] ? this.toService(existing.rows[0]) : null;
      });
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  async find(filter: ServiceFilter): Promise<Service | null> {
    const { clause, bindings } = this.buildWhere({
      id: filter.id,
      name: filter.name,
      cluster_id: filter.clusterId,
      type: filter.type,
    });
    if (!bindings.length) return null;

    const result = await this.db
      .prepare(`SELECT id, cluster_id, name, type, deployment_id, created_at, updated_at FROM services ${clause} LIMIT 1`)
      .bind(...bindings)
      .first();

    return result ? this.toService(result) : null;
  }

  async list(filter?: ServiceFilter): Promise<Service[]> {
    const { clause, bindings } = this.buildWhere({ cluster_id: filter?.clusterId, type: filter?.type });

    const results = await this.db
      .prepare(`SELECT id, cluster_id, name, type, deployment_id, created_at, updated_at FROM services ${clause} ORDER BY name ASC`)
      .bind(...bindings)
      .all();

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
      type: row.type as ServiceType,
      deploymentId: (row.deployment_id as string) ?? null,
      name: row.name as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
