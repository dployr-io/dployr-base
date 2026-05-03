import { Deployment, DeploymentStatus, ServiceType } from "@/types/index.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import { BaseStore, Pagination } from "./base.js";
import { maskBlueprintSecrets } from "@/lib/crypto/masking.js";

export type DeploymentFilter = {
  id?: string;
  clusterId?: string;
  serviceId?: string;
  status?: DeploymentStatus;
};

export class DeploymentStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "deployments";

  async upsert({
    clusterId,
    id,
    name,
    type,
    source,
    status,
    blueprint,
    logs,
    createdAt,
    finishedAt,
    serviceId,
  }: {
    clusterId: string;
    name: string;
    type: ServiceType;
    source: "remote" | "image";
    status?: DeploymentStatus;
    blueprint: Record<string, any>;
    id?: string | null;
    logs?: string | null;
    createdAt?: number | null;
    finishedAt?: number | null;
    serviceId?: string | null;
  }): Promise<Deployment | null> {
    if (!createdAt) createdAt = this.now();
    if (!id) id = this.generateId();
    if (!logs) logs = null;
    if (!finishedAt && (status === "success" || status === "failed")) finishedAt = this.now();

    try {
      const safeBlueprint = maskBlueprintSecrets(blueprint);
      return await this.db.withTransaction(async (client) => {
        const now = this.now();

        // only update logs if finished_at is set
        const insertResult = await this.db
          .prepare(
            `INSERT INTO deployments (id, cluster_id, name, type, source, status, blueprint, created_at, logs, finished_at, service_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, $11, $12)
           ON CONFLICT (id) DO UPDATE SET
             blueprint = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.blueprint ELSE $7::jsonb END,
             name = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.name ELSE $3 END,
             type = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.type ELSE $4 END,
             source = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.source ELSE $5 END,
             status = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.status ELSE $6 END,
             logs = CASE WHEN $9 IS NOT NULL THEN $9 ELSE deployments.logs END,
             finished_at = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.finished_at ELSE $10 END,
             service_id = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.service_id ELSE $11 END,
             updated_at = $12
           RETURNING id, cluster_id, service_id, name, type, source, status, blueprint, logs, created_at, finished_at`,
          )
          .bind(id, clusterId, name, type, source, status ?? "pending", safeBlueprint, createdAt, logs, finishedAt ?? null, serviceId ?? null, now)
          .executeWithClient(client);

        const row = insertResult.rows?.[0];
        if (row) {
          if (status === "success" && serviceId) {
            await this.db.prepare(`UPDATE services SET deployment_id = $1, updated_at = $2 WHERE id = $3`).bind(id, finishedAt ?? now, serviceId).executeWithClient(client);
          }
          return this.toDeployment(row);
        }
        return null;
      });
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  async get(id: string): Promise<Deployment | null> {
    const row = await this.db.prepare(`SELECT id, cluster_id, service_id, name, type, source, status, blueprint, logs, created_at, finished_at FROM deployments WHERE id = $1`).bind(id).first();
    return row ? this.toDeployment(row) : null;
  }

  /**
   * List deployments with optional filtering and pagination.
   *
   * @param filter - Filter and pagination criteria
   * @param filter.id - Deployment ID (exact match)
   * @param filter.clusterId - Cluster ID to filter deployments by
   * @param filter.serviceId - Service ID to filter deployments by
   * @param filter.status - Deployment status to filter by (pending, success, failed)
   * @param filter.limit - Maximum number of results to return
   * @param filter.offset - Number of results to skip (for pagination)
   * @returns Object containing array of deployments and total count (before pagination)
   */
  async list(filter: DeploymentFilter & Pagination): Promise<{ deployments: Deployment[]; total: number }> {
    const { clause, bindings } = this.buildWhere({
      cluster_id: filter.clusterId,
      service_id: filter.serviceId,
      status: filter.status,
    });

    const countResult = bindings.length
      ? await this.db.prepare(`SELECT COUNT(*) as count FROM deployments ${clause}`).bind(...bindings).first()
      : await this.db.prepare(`SELECT COUNT(*) as count FROM deployments`).first();

    const total = Number(countResult?.count ?? 0);

    let sql = `SELECT id, cluster_id, service_id, name, type, source, status, blueprint, logs, created_at, finished_at FROM deployments ${clause} ORDER BY created_at DESC`;
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

    const deployments = results.results.map((r) => this.toDeployment(r));

    return { deployments, total };
  }


  async updateStatus(id: string, status: DeploymentStatus, finishedAt?: string): Promise<void> {
    if (status === "failed" || status === "success") {
      const timestamp = finishedAt || this.now();
      await this.db.prepare(`UPDATE deployments SET status = $1, finished_at = $2 WHERE id = $3`).bind(status, timestamp, id).run();
    } else {
      await this.db.prepare(`UPDATE deployments SET status = $1 WHERE id = $2`).bind(status, id).run();
    }
  }

  async updateLogs(id: string, logs: string): Promise<Deployment | null> {
    const result = await this.db
      .prepare(`UPDATE deployments SET logs = $1, updated_at = $2 WHERE id = $3 RETURNING id, cluster_id, service_id, name, type, source, status, blueprint, logs, created_at, finished_at`)
      .bind(logs, this.now(), id)
      .first();

    return result ? this.toDeployment(result) : null;
  }

  async delete({ id }: { id: string }): Promise<void> {
    await this.db.prepare(`DELETE FROM deployments WHERE id = $1`).bind(id).run();
  }

  private toDeployment(row: any): Deployment {
    return {
      id: row.id as string,
      clusterId: row.cluster_id as string,
      serviceId: row.service_id as string | null,
      name: row.name as string,
      type: row.type as ServiceType,
      source: row.source as "remote" | "image",
      status: row.status as DeploymentStatus,
      blueprint: row.blueprint ?? {},
      logs: row.logs as string | null,
      createdAt: row.created_at as number,
      finishedAt: row.finished_at as number | null,
    };
  }
}
