// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { InstanceEntry } from "@/types/index.js";
import { PoolCapacityExceededError } from "@/lib/errors/errors.js";
import { BaseStore } from "./base.js";

export class InstancePoolStore extends BaseStore {
  /** Returns all pool entries ordered by insertion time. */
  async getInstancePool(): Promise<InstanceEntry[]> {
    const result = await this.db
      .prepare(`SELECT id, address, tag, capacity, region, status, metadata, created_at, updated_at FROM instance_pool ORDER BY created_at ASC`)
      .all();

    return result.results.map(this.toEntry);
  }

  /**
   * Inserts a new instance into the shared pool.
   * Throws DatabaseConflictError if the address or tag is already taken.
   */
  async addToPool(entry: Omit<InstanceEntry, "id" | "createdAt" | "updatedAt">): Promise<InstanceEntry> {
    const now = this.now();
    const id = this.generateId();

    return this.db.withTransaction(async (client) => {
      let result;
      try {
        result = await client.query(
          `INSERT INTO instance_pool (id, address, tag, capacity, region, status, metadata, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9)
           RETURNING id, address, tag, capacity, region, status, metadata, created_at, updated_at`,
          [id, entry.address, entry.tag, entry.capacity ?? 10, entry.region ?? null, entry.status ?? "active", JSON.stringify(entry.metadata ?? {}), now, now],
        );
      } catch (error) {
        this.parsePostgresError({ error, table: "instance_pool" });
      }

      return this.toEntry(result.rows[0]);
    });
  }

  /**
   * Removes a pool instance by ID.
   * Due to `ON DELETE SET NULL` on clusters.pool_instance_id, all clusters
   * that were assigned to this instance are automatically unassigned — no
   * manual release loop required.
   */
  async removeFromPool(id: string): Promise<void> {
    try {
      await this.db.prepare(`DELETE FROM instance_pool WHERE id = $1`).bind(id).run();
    } catch (error) {
      this.parsePostgresError({ error, table: "instance_pool" });
    }
  }

  /** Pauses or resumes a pool instance. Paused instances are skipped by assignInstance. */
  async updateStatus(id: string, status: "active" | "paused"): Promise<void> {
    const now = this.now();
    try {
      await this.db.prepare(`UPDATE instance_pool SET status = $1, updated_at = $2 WHERE id = $3`).bind(status, now, id).run();
    } catch (error) {
      this.parsePostgresError({ error, table: "instance_pool" });
    }
  }

  /**
   * Assigns the least-loaded active pool instance to a cluster.
   *
   * Runs inside a transaction to make the SELECT + UPDATE atomic, preventing
   * double-assignment under concurrent signups. Only instances that are active
   * and below their configured capacity limit are considered; among those the
   * one with the fewest current assignments is chosen.
   *
   * Throws PoolCapacityExceededError if no active instance has remaining capacity.
   */
  async assignInstance(clusterId: string): Promise<string> {
    return this.db.withTransaction(async (client) => {
      const result = await client.query(
        `SELECT ip.id
         FROM instance_pool ip
         WHERE ip.status = 'active'
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
    const result = await this.db
      .prepare(`SELECT id AS cluster_id, pool_instance_id AS instance_id FROM clusters WHERE pool_instance_id IS NOT NULL`)
      .all();

    return result.results.map((row) => ({
      clusterId: row.cluster_id as string,
      instanceId: row.instance_id as string,
    }));
  }

  private toEntry(row: any): InstanceEntry {
    return {
      id: row.id,
      address: row.address,
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
