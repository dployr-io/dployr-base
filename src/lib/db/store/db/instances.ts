// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Instance, InstanceKind, InstanceStatus } from "@/types/index.js";
import { PoolCapacityExceededError } from "@/lib/errors/errors.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import { BaseStore, type Pagination } from "./base.js";

type InstanceUpdateData = Partial<Omit<Instance, "id" | "clusterId" | "managed" | "capacity" | "kind" | "region" | "createdAt" | "updatedAt">>;
export type InstancePayload = Omit<Instance, "id" | "kind" | "clusterId" | "createdAt" | "updatedAt">;
export type InstanceFilter = Partial<Omit<Instance, "metadata" | "createdAt" | "updatedAt">>;

export class InstanceStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "instances";
  async create({ clusterId, data }: { clusterId: string; data: InstancePayload }): Promise<Instance> {
    return this.db.withTransaction(async (client) => {
      const id = this.generateId();
      const now = this.now();

      let result;
      try {
        result = await client.query(
          `INSERT INTO instances (id, kind, cluster_id, address, tag, region, managed, metadata, created_at, updated_at)
           VALUES ($1, 'dedicated', $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           RETURNING id, kind, cluster_id, address, tag, status, capacity, region, managed, metadata, created_at, updated_at`,
          [id, clusterId, data.address ?? null, data.tag, data.region ?? "us-east", data.managed ?? true, data.metadata ?? {}, now, now],
        );
      } catch (error) {
        this.parsePostgresError(error);
      }

      return this.toInstance(result.rows[0]);
    });
  }

  /**
   * Find a single instance matching the provided filter.
   *
   * @param filter - Filter criteria
   * @param filter.id - Instance ID (exact match)
   * @param filter.tag - Instance tag (exact match)
   * @param filter.clusterId - Cluster ID to filter by
   * @param filter.kind - Instance kind (dedicated, pool)
   * @param filter.address - Instance address (exact match)
   * @param filter.status - Instance status (ready, busy, down, draining)
   * @param filter.managed - Whether the instance is managed (true/false)
   * @returns The instance, or null if not found
   */
  async find(filter: InstanceFilter): Promise<Instance | null> {
    const parts: string[] = [];
    const bindings: any[] = [];

    if (filter.id !== undefined) {
      bindings.push(filter.id);
      parts.push(`id = $${bindings.length}`);
    }
    if (filter.tag !== undefined) {
      bindings.push(filter.tag);
      parts.push(`tag = $${bindings.length}`);
    }
    if (filter.clusterId !== undefined) {
      bindings.push(filter.clusterId);
      parts.push(`cluster_id = $${bindings.length}`);
    }
    if (filter.kind !== undefined) {
      bindings.push(filter.kind);
      parts.push(`kind = $${bindings.length}`);
    }
    if (filter.address !== undefined) {
      bindings.push(filter.address);
      parts.push(`address = $${bindings.length}`);
    }
    if (filter.status !== undefined) {
      bindings.push(filter.status);
      parts.push(`status = $${bindings.length}`);
    }
    if (filter.managed !== undefined) {
      bindings.push(filter.managed);
      parts.push(`managed = $${bindings.length}`);
    }

    if (!bindings.length) return null;

    const where = `WHERE ${parts.join(" AND ")}`;
    const result = await this.db
      .prepare(`SELECT id, kind, cluster_id, address, tag, status, capacity, region, managed, metadata, created_at, updated_at FROM instances ${where} LIMIT 1`)
      .bind(...bindings)
      .first();

    return result ? this.toInstance(result) : null;
  }

  /**
   * List instances with optional filtering and pagination.
   *
   * @param filter - Optional filter and pagination criteria
   * @param filter.clusterId - Cluster ID to filter instances by
   * @param filter.kind - Instance kind to filter by (dedicated, pool)
   * @param filter.id - Instance ID (exact match)
   * @param filter.tag - Instance tag (exact match)
   * @param filter.address - Instance address (exact match)
   * @param filter.status - Instance status to filter by
   * @param filter.managed - Whether the instance is managed
   * @param filter.limit - Maximum number of results to return
   * @param filter.offset - Number of results to skip (for pagination)
   * @returns Object containing array of instances and total count (before pagination)
   */
  async list(filter?: InstanceFilter & Pagination): Promise<{ instances: Instance[]; total: number }> {
    const parts: string[] = [];
    const bindings: any[] = [];

    if (filter?.clusterId !== undefined) {
      bindings.push(filter.clusterId);
      parts.push(`cluster_id = $${bindings.length}`);
    }
    if (filter?.kind !== undefined) {
      bindings.push(filter.kind);
      parts.push(`kind = $${bindings.length}`);
    }

    const where = parts.length ? `WHERE ${parts.join(" AND ")}` : "";

    const countResult = bindings.length
      ? await this.db
          .prepare(`SELECT COUNT(*) as count FROM instances ${where}`)
          .bind(...bindings)
          .first()
      : await this.db.prepare(`SELECT COUNT(*) as count FROM instances ${where}`).first();

    const total = Number(countResult?.count ?? 0);

    let sql = `SELECT id, kind, cluster_id, address, tag, status, capacity, region, metadata, created_at, updated_at FROM instances ${where} ORDER BY created_at DESC`;
    const dataBindings = [...bindings];

    if (filter?.limit !== undefined) {
      dataBindings.push(filter.limit);
      sql += ` LIMIT $${dataBindings.length}`;
    }
    if (filter?.offset !== undefined) {
      dataBindings.push(filter.offset);
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

  async update({ id }: { id: string }, data: InstanceUpdateData): Promise<void> {
    const parts: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (data.address !== undefined) {
      parts.push(`address = $${p++}`);
      values.push(data.address);
    }
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

  async delete({ id }: { id: string }): Promise<void> {
    await this.db.prepare(`DELETE FROM instances WHERE id = $1`).bind(id).run();
  }

  async addPool(entry: { address?: string | null; tag: string; capacity?: number; region?: string; status?: InstanceStatus; metadata?: Record<string, any> }): Promise<Instance> {
    return this.db.withTransaction(async (client) => {
      const id = this.generateId();
      const now = this.now();

      let result;
      try {
        result = await client.query(
          `INSERT INTO instances (id, kind, address, tag, capacity, region, status, metadata, created_at, updated_at)
           VALUES ($1, 'pool', $2, $3, $4, $5, $6::instance_status, $7::jsonb, $8, $9)
           RETURNING id, kind, cluster_id, address, tag, status, capacity, region, metadata, created_at, updated_at`,
          [id, entry.address ?? null, entry.tag, entry.capacity ?? 10, entry.region ?? null, entry.status ?? "healthy", JSON.stringify(entry.metadata ?? {}), now, now],
        );
      } catch (error) {
        this.parsePostgresError(error);
      }

      return this.toInstance(result.rows[0]);
    });
  }

  async removePool(id: string): Promise<void> {
    try {
      await this.db.prepare(`DELETE FROM instances WHERE id = $1 AND kind = 'pool'`).bind(id).run();
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  async listPool(params?: { limit?: number; offset?: number }): Promise<{ instances: Instance[]; total: number }> {
    return this.list({ kind: "pool", limit: params?.limit, offset: params?.offset });
  }

  /**
   * Assigns the least-loaded healthy pool instance to a cluster.
   * Throws PoolCapacityExceededError if no instance has remaining capacity.
   */
  async assignPool(clusterId: string): Promise<string> {
    return this.db.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT i.id
         FROM instances i
         WHERE i.kind = 'pool'
           AND i.status = 'healthy'
           AND (SELECT COUNT(*) FROM clusters c WHERE c.pool_instance_id = i.id) < COALESCE(i.capacity, 10)
         ORDER BY (SELECT COUNT(*) FROM clusters c WHERE c.pool_instance_id = i.id) ASC
         LIMIT 1`,
        [],
      );

      if (!result.rows.length) throw new PoolCapacityExceededError();

      const instanceId = result.rows[0].id as string;
      const now = this.now();

      try {
        await client.query(`UPDATE clusters SET pool_instance_id = $1, updated_at = $2 WHERE id = $3`, [instanceId, now, clusterId]);
      } catch (error) {
        this.parsePostgresError(error);
      }

      return instanceId;
    });
  }

  async getClusterPoolInstance(clusterId: string): Promise<string | null> {
    const result = await this.db.prepare(`SELECT pool_instance_id FROM clusters WHERE id = $1`).bind(clusterId).first();
    return (result?.pool_instance_id as string) ?? null;
  }

  /**
   * Resolves the WS routing key for a cluster.
   * Returns the bare instance tag — connection manager handles pool: fallback internally.
   */
  async getRoutingKey(clusterId: string): Promise<string> {
    const poolInstanceId = await this.getClusterPoolInstance(clusterId);
    if (!poolInstanceId) {
      return clusterId;
    }
    const poolInstance = await this.find({ id: poolInstanceId });
    return poolInstance?.tag ?? clusterId;
  }


  async releasePoolInstance(clusterId: string): Promise<void> {
    const now = this.now();
    try {
      await this.db.prepare(`UPDATE clusters SET pool_instance_id = NULL, updated_at = $1 WHERE id = $2`).bind(now, clusterId).run();
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  /** Returns a map of all pooled instances and assigned clusters */
  async getPoolClustersMap(): Promise<Array<{ clusterId: string; instanceId: string }>> {
    const result = await this.db.prepare(`SELECT id AS cluster_id, pool_instance_id AS instance_id FROM clusters WHERE pool_instance_id IS NOT NULL`).all();
    return result.results.map((row) => ({
      clusterId: row.cluster_id as string,
      instanceId: row.instance_id as string,
    }));
  }

  async listUnassignedClusters(): Promise<{ id: string; name: string }[]> {
    const result = await this.db.prepare(`SELECT id, name FROM clusters WHERE pool_instance_id IS NULL`).all();
    return result.results.map((r) => ({ id: r.id as string, name: r.name as string }));
  }

  private toInstance(row: any): Instance {
    return {
      id: row.id as string,
      kind: (row.kind ?? "dedicated") as InstanceKind,
      address: (row.address as string) ?? null,
      tag: row.tag as string,
      status: (row.status ?? "healthy") as InstanceStatus,
      capacity: row.capacity != null ? (row.capacity as number) : undefined,
      region: row.region != null ? (row.region as string) : undefined,
      clusterId: row.cluster_id != null ? (row.cluster_id as string) : null,
      metadata: row.metadata ?? {},
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
