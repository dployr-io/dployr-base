import { Deployment, DeploymentStatus, ServiceType } from "@/types/index.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import { BaseStore } from "./base.js";
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
    name,
    type,
    source,
    blueprint,
  }: {
    clusterId: string;
    name: string;
    type: ServiceType;
    source: "remote" | "image";
    blueprint: Record<string, any>;
  }): Promise<Omit<Deployment, "finishedAt" | "logs" | "serviceId"> | null> {
    const id = this.generateId();
    const now = this.now();

    try {
      const safeBlueprint = maskBlueprintSecrets(blueprint);
      return await this.db.withTransaction(async (client) => {
        const insertResult = await this.db
          .prepare(
            `INSERT INTO deployments (id, cluster_id, name, type, source, status, blueprint, created_at)
           VALUES ($1, $2, $3, $4, $5, 'pending', $6::jsonb, $7)
           ON CONFLICT (cluster_id, name) DO NOTHING`,
          )
          .bind(id, clusterId, name, type, source, safeBlueprint, now)
          .executeWithClient(client);

        if (insertResult.rowCount && insertResult.rowCount > 0) {
          return { id, clusterId, name, type, status: "pending" as const, source, blueprint: safeBlueprint, createdAt: now };
        }

        const existing = await this.db
          .prepare(
            `SELECT id, cluster_id, service_id, name, type, source, status, blueprint, logs, created_at, finished_at
             FROM deployments WHERE cluster_id = $1 AND name = $2`,
          )
          .bind(clusterId, name)
          .executeWithClient(client);

        return existing.rows[0] ? this.toDeployment(existing.rows[0]) : null;
      });
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  async get(id: string): Promise<Deployment | null> {
    const row = await this.db
      .prepare(`SELECT id, cluster_id, service_id, name, type, source, status, blueprint, logs, created_at, finished_at FROM deployments WHERE id = $1`)
      .bind(id)
      .first();
    return row ? this.toDeployment(row) : null;
  }

  async list(filter: DeploymentFilter): Promise<Deployment[]> {
    const { clause, bindings } = this.buildWhere({
      cluster_id: filter.clusterId,
      service_id: filter.serviceId,
      status: filter.status,
    });

    const results = await this.db
      .prepare(
        `SELECT id, cluster_id, service_id, name, type, source, status, blueprint, logs, created_at, finished_at
         FROM deployments ${clause} ORDER BY created_at DESC`,
      )
      .bind(...bindings)
      .all();

    return results.results.map((r) => this.toDeployment(r));
  }

  /** Single call for when the node pushes its completion event — sets `status`, attaches the service, writes logs, and connects the deployment to the service. */
  async complete({ id, serviceId, logs, status }: { id: string; serviceId?: string; logs: string; status: "success" | "failed" }): Promise<void> {
    const now = this.now();
    await this.db.withTransaction(async (client) => {
      await this.db
        .prepare(
          `UPDATE deployments
           SET status = $1, service_id = $2, logs = $3, finished_at = $4
           WHERE id = $5`,
        )
        .bind(status, serviceId ?? null, logs, now, id)
        .executeWithClient(client);

      if (status === "success" && serviceId) {
        await this.db
          .prepare(`UPDATE services SET deployment_id = $1, updated_at = $2 WHERE id = $3`)
          .bind(id, now, serviceId)
          .executeWithClient(client);
      }
    });
  }

  async updateStatus(id: string, status: DeploymentStatus): Promise<void> {
    await this.db.prepare(`UPDATE deployments SET status = $1 WHERE id = $2`).bind(status, id).run();
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
