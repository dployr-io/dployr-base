// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Instance, InstanceStatus } from "@/types/index.js";
import { BaseStore, type Pagination } from "./base.js";

/** Fields that can be used to look up or filter instances. */
export type InstanceFilter = {
  id?: string;
  tag?: string;
  clusterId?: string;
};

/** Fields that can be updated on an existing instance. */
export type InstanceUpdateData = {
  status?: InstanceStatus;
  metadata?: Record<string, any>;
};

export class InstanceStore extends BaseStore {
  /**
   * Creates a new instance and its bootstrap token atomically.
   */
  async create({ clusterId, data }: { clusterId: string; data: Omit<Instance, "id" | "createdAt" | "updatedAt"> }): Promise<Instance> {
    return this.db.withTransaction(async (client) => {
      const id = this.generateId();
      const now = this.now();

      let result;
      try {
        result = await client.query(
          `INSERT INTO instances (id, cluster_id, address, tag, status, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5::instance_status, $6::jsonb, $7, $8)
           RETURNING id, cluster_id, address, tag, status, metadata, created_at, updated_at`,
          [id, clusterId, data.address || null, data.tag, data.status ?? "healthy", data.metadata || {}, now, now],
        );
      } catch (error) {
        this.parsePostgresError({ error, table: "instances" });
      }

      const row = result.rows[0];

      return {
        id: row.id,
        address: row.address,
        tag: row.tag,
        status: row.status,
        metadata: row.metadata || {},
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
    });
  }

  /**
   * Returns the first instance matching the given filter, or `null` if not found.
   * At least one filter field must be set.
   */
  async find(filter: InstanceFilter): Promise<(Instance & { clusterId: string }) | null> {
    const { clause, bindings } = this.buildWhere({
      id: filter.id,
      tag: filter.tag,
      cluster_id: filter.clusterId,
    });
    if (!bindings.length) return null;

    const result = await this.db
      .prepare(`SELECT id, address, tag, status, metadata, created_at, updated_at, cluster_id FROM instances ${clause} LIMIT 1`)
      .bind(...bindings)
      .first();

    return result ? this.toInstance(result) : null;
  }

  /**
   * Returns a paginated list of instances, optionally filtered.
   */
  async list(filter?: InstanceFilter & Pagination): Promise<{ instances: Instance[]; total: number }> {
    const { clusterId, limit, offset } = filter ?? {};
    const { clause, bindings } = this.buildWhere({ cluster_id: clusterId });

    const countResult = bindings.length
      ? await this.db
          .prepare(`SELECT COUNT(*) as count FROM instances ${clause}`)
          .bind(...bindings)
          .first()
      : await this.db.prepare(`SELECT COUNT(*) as count FROM instances`).first();

    const total = Number(countResult?.count || 0);

    let sql = `SELECT id, cluster_id, address, tag, status, metadata, created_at, updated_at FROM instances ${clause} ORDER BY created_at DESC`;
    const dataBindings = [...bindings];

    if (limit !== undefined) {
      dataBindings.push(limit);
      sql += ` LIMIT $${dataBindings.length}`;
    }
    if (offset !== undefined) {
      dataBindings.push(offset);
      sql += ` OFFSET $${dataBindings.length}`;
    }

    const results = dataBindings.length
      ? await this.db
          .prepare(sql)
          .bind(...dataBindings)
          .all()
      : await this.db.prepare(sql).all();

    return { instances: results.results.map((r) => this.toInstance(r)), total };
  }

  /**
   * Updates mutable fields on an instance. Only the provided fields are written.
   */
  async update({ id }: { id: string }, data: InstanceUpdateData): Promise<void> {
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

  /** Permanently deletes an instance by ID. */
  async delete({ id }: { id: string }): Promise<void> {
    await this.db.prepare(`DELETE FROM instances WHERE id = $1`).bind(id).run();
  }

  private toInstance(row: any): Instance & { clusterId: string } {
    return {
      id: row.id as string,
      address: row.address as string,
      tag: row.tag as string,
      status: (row.status ?? "healthy") as InstanceStatus,
      metadata: row.metadata || {},
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      clusterId: row.cluster_id as string,
    };
  }
}
