// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { InstancePool, InstanceStatus } from "@/types/index.js";
import { PoolCapacityExceededError } from "@/lib/errors/errors.js";
import { BaseStore } from "./base.js";
import { InstanceFilter, InstanceUpdateData } from "./instances.js";

export class InstancePoolStore extends BaseStore {
  async list(params?: { clusterId?: string; limit?: number; offset?: number }): Promise<{ instances: InstancePool[]; total: number }> {
    const { clusterId, limit, offset } = params || {};

    const filters: string[] = [];
    const bindings: any[] = [];

    if (clusterId) {
      bindings.push(clusterId);
      filters.push(`id = (SELECT pool_instance_id FROM clusters WHERE id = $${bindings.length})`);
    }

    const whereClause = filters.length ? `WHERE ${filters.join(" AND ")}` : "";

    const countStmt = this.db.prepare(`SELECT COUNT(*) as count FROM instance_pool ${whereClause}`);
    const countResult = bindings.length ? await countStmt.bind(...bindings).first() : await countStmt.first();
    const total = Number(countResult?.count || 0);

    let dataSql = `SELECT id, address, tag, capacity, region, status, metadata, created_at, updated_at FROM instance_pool ${whereClause} ORDER BY created_at ASC`;

    const dataBindings = [...bindings];

    if (limit !== undefined) {
      dataBindings.push(limit);
      dataSql += ` LIMIT $${dataBindings.length}`;
    }
    if (offset !== undefined) {
      dataBindings.push(offset);
      dataSql += ` OFFSET $${dataBindings.length}`;
    }

    const dataStmt = this.db.prepare(dataSql);
    const results = dataBindings.length ? await dataStmt.bind(...dataBindings).all() : await dataStmt.all();

    return { instances: results.results.map(this.toPool), total };
  }

  async add(entry: Omit<InstancePool, "id" | "createdAt" | "updatedAt">): Promise<InstancePool> {
    const now = this.now();
    const id = this.generateId();

    return this.db.withTransaction(async (client) => {
      let result;
      try {
        result = await client.query(
          `INSERT INTO instance_pool (id, address, tag, capacity, region, status, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           RETURNING id, address, tag, capacity, region, status, metadata, created_at, updated_at`,
          [id, entry.address, entry.tag, entry.capacity ?? 10, entry.region ?? null, entry.status ?? "healthy", JSON.stringify(entry.metadata ?? {}), now, now],
        );
      } catch (error) {
        this.parsePostgresError({ error, table: "instance_pool" });
      }

      return this.toPool(result.rows[0]);
    });
  }

  async remove(id: string): Promise<void> {
    try {
      await this.db.prepare(`DELETE FROM instance_pool WHERE id = $1`).bind(id).run();
    } catch (error) {
      this.parsePostgresError({ error, table: "instance_pool" });
    }
  }

  /**
   * Returns the first instance matching the given filter, or `null` if not found.
   * At least one filter field must be set.
   */
  async find(filter: InstanceFilter): Promise<InstancePool | null> {
    const { clause, bindings } = this.buildWhere({ id: filter.id, tag: filter.tag });
    const parts = clause ? [clause.replace("WHERE ", "")] : [];

    if (filter.clusterId !== undefined) {
      bindings.push(filter.clusterId);
      parts.push(`id = (SELECT pool_instance_id FROM clusters WHERE id = $${bindings.length})`);
    }

    if (!bindings.length) return null;

    const where = `WHERE ${parts.join(" AND ")}`;

    const result = await this.db
      .prepare(`SELECT id, address, tag, capacity, region, status, metadata, created_at, updated_at FROM instance_pool ${where} LIMIT 1`)
      .bind(...bindings)
      .first();

    return result ? this.toPool(result) : null;
  }

  /**
   * Updates mutable fields on an instance. Only the provided fields are written.
   */
  async update({ id, data }: { id: string; data: InstanceUpdateData }): Promise<void> {
    const parts: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (data.status !== undefined) {
      parts.push(`status = $${p++}::instance_status`);
      values.push(data.status);
    }
    if (data.metadata !== undefined) {
      parts.push(`metadata = $${p++}::jsonb`);
      values.push(data.metadata);
    }
    if (!parts.length) return;

    parts.push(`updated_at = $${p++}`);
    values.push(this.now(), id);

    await this.db
      .prepare(`UPDATE instances SET ${parts.join(", ")} WHERE id = $${p}`)
      .bind(...values)
      .run();
  }

  /**
   * Assigns the least-loaded active pool instance to a cluster.
   *
   * Only instances that are active and below their configured capacity limit are
   * considered; among those the one with the fewest current assignments is chosen.
   *
   * Throws PoolCapacityExceededError if no active instance has remaining capacity.
   */
  async assign(clusterId: string): Promise<string> {
    return this.db.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT ip.id
         FROM instance_pool ip
         WHERE ip.status = 'healthy'
           AND (SELECT COUNT(*) FROM clusters c WHERE c.pool_instance_id = ip.id) < ip.capacity
         ORDER BY (SELECT COUNT(*) FROM clusters c WHERE c.pool_instance_id = ip.id) ASC
         LIMIT 1`,
        [],
      );

      if (!result.rows.length) throw new PoolCapacityExceededError();

      const instanceId = result.rows[0].id as string;
      const now = this.now();

      try {
        await client.query(`UPDATE clusters SET pool_instance_id = $1, updated_at = $2 WHERE id = $3`, [instanceId, now, clusterId]);
      } catch (error) {
        this.parsePostgresError({ error, table: "clusters" });
      }

      return instanceId;
    });
  }

  /** Returns the pool instance ID currently assigned to a cluster, or null. */
  async getClusterInstance(clusterId: string): Promise<string | null> {
    const result = await this.db.prepare(`SELECT pool_instance_id FROM clusters WHERE id = $1`).bind(clusterId).first();
    return (result?.pool_instance_id as string) ?? null;
  }

  /** Unassigns the pool instance from a cluster (e.g. on plan upgrade). */
  async releaseInstance(clusterId: string): Promise<void> {
    const now = this.now();
    try {
      await this.db.prepare(`UPDATE clusters SET pool_instance_id = NULL, updated_at = $1 WHERE id = $2`).bind(now, clusterId).run();
    } catch (error) {
      this.parsePostgresError({ error, table: "clusters" });
    }
  }

  /**
   * Returns every current cluster-to-pool-instance assignment.
   * Useful for admin inspection; for removal cleanup prefer relying on
   * ON DELETE SET NULL rather than calling this + releaseInstance manually.
   */
  async getClustersInstanceMap(): Promise<Array<{ clusterId: string; instanceId: string }>> {
    const result = await this.db.prepare(`SELECT id AS cluster_id, pool_instance_id AS instance_id FROM clusters WHERE pool_instance_id IS NOT NULL`).all();

    return result.results.map((row) => ({
      clusterId: row.cluster_id as string,
      instanceId: row.instance_id as string,
    }));
  }

  private toPool(row: any): InstancePool {
    return {
      id: row.id,
      address: row.address ?? null,
      tag: row.tag,
      capacity: row.capacity,
      region: row.region ?? undefined,
      status: row.status,
      metadata: row.metadata ?? {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
