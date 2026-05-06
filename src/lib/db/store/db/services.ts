// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore, type Pagination } from "./base.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import { ValidationError } from "@/lib/errors/errors.js";
import { validateString } from "@/lib/validators/string-sanitizer.js";
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
  async upsert({
    clusterId,
    name,
    label,
    type,
    deploymentId,
  }: {
    clusterId: string;
    name: string;
    label?: string | null;
    type: ServiceType;
    deploymentId?: string;
  }): Promise<Service | null> {
    const nameValidation = validateString(name, "name");
    if (!nameValidation.valid) {
      throw new ValidationError(nameValidation.error || "Service name is not allowed");
    }

    const id = this.generateId();
    const now = this.now();

    try {
      const result = await this.db
        .prepare(
          `INSERT INTO services (id, cluster_id, name, label, type, deployment_id, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT (name) DO UPDATE SET label = COALESCE(EXCLUDED.label, services.label), deployment_id = COALESCE(EXCLUDED.deployment_id, services.deployment_id), updated_at = EXCLUDED.updated_at
           RETURNING id, cluster_id, name, label, type, deployment_id, created_at, updated_at`,
        )
        .bind(id, clusterId, name, label || null, type, deploymentId || null, now, now)
        .first();

      return result ? this.toService(result) : null;
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  /**
   * Find a single service matching the provided filter.
   *
   * @param filter - Filter criteria
   * @param filter.id - Service ID (exact match)
   * @param filter.name - Service name (exact match)
   * @param filter.type - Service type to filter by
   * @param filter.clusterId - Cluster ID to filter services by
   * @returns The service, or null if not found
   */
  async find(filter: ServiceFilter): Promise<Service | null> {
    const { clause, bindings } = this.buildWhere({
      id: filter.id,
      name: filter.name,
      cluster_id: filter.clusterId,
      type: filter.type,
    });
    if (!bindings.length) return null;

    const result = await this.db
      .prepare(`SELECT id, cluster_id, name, label, type, deployment_id, created_at, updated_at FROM services ${clause} LIMIT 1`)
      .bind(...bindings)
      .first();

    return result ? this.toService(result) : null;
  }

  /**
   * List services with optional filtering and pagination.
   *
   * @param filter - Optional filter and pagination criteria
   * @param filter.clusterId - Cluster ID to filter services by
   * @param filter.type - Service type to filter by
   * @param filter.id - Service ID (exact match)
   * @param filter.name - Service name (exact match)
   * @param filter.limit - Maximum number of results to return
   * @param filter.offset - Number of results to skip (for pagination)
   * @returns Object containing array of services and total count (before pagination)
   */
  async list(filter?: ServiceFilter & Pagination): Promise<{ services: Service[]; total: number }> {
    const { clause, bindings } = this.buildWhere({ cluster_id: filter?.clusterId, type: filter?.type });

    const countResult = bindings.length
      ? await this.db.prepare(`SELECT COUNT(*) as count FROM services ${clause}`).bind(...bindings).first()
      : await this.db.prepare(`SELECT COUNT(*) as count FROM services`).first();

    const total = Number(countResult?.count ?? 0);

    let sql = `SELECT id, cluster_id, name, label, type, deployment_id, created_at, updated_at FROM services ${clause} ORDER BY name ASC`;
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
      ? await this.db.prepare(sql).bind(...dataBindings).all()
      : await this.db.prepare(sql).all();

    return { services: results.results.map((r) => this.toService(r)), total };
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
      label: (row.label as string) ?? null,
      type: row.type as ServiceType,
      deploymentId: (row.deployment_id as string) ?? null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
