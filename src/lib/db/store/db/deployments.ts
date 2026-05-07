import { Deployment, DeploymentStatus, ServiceType } from "@/types/index.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import { ValidationError } from "@/lib/errors/errors.js";
import { validateString } from "@/lib/validators/string-sanitizer.js";
import { BaseStore, Pagination } from "./base.js";

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
    userId,
    id,
    name,
    type,
    source,
    status,
    description,
    runCmd,
    buildCmd,
    port,
    workingDir,
    staticDir,
    image,
    domain,
    runtimeType,
    runtimeVersion,
    remoteUrl,
    remoteBranch,
    remoteCommitHash,
    logs,
    createdAt,
    finishedAt,
    serviceId,
  }: {
    clusterId: string;
    userId: string;
    name: string;
    type: ServiceType;
    source: "remote" | "image";
    status?: DeploymentStatus;
    description?: string | null;
    runCmd?: string | null;
    buildCmd?: string | null;
    port?: number | null;
    workingDir?: string | null;
    staticDir?: string | null;
    image?: string | null;
    domain?: string | null;
    runtimeType?: string | null;
    runtimeVersion?: string | null;
    remoteUrl?: string | null;
    remoteBranch?: string | null;
    remoteCommitHash?: string | null;
    id?: string | null;
    logs?: string | null;
    createdAt?: number | null;
    finishedAt?: number | null;
    serviceId?: string | null;
  }): Promise<Deployment | null> {
    const nameValidation = validateString(name, "name");
    if (!nameValidation.valid) {
      throw new ValidationError(nameValidation.error || "Deployment name is not allowed");
    }

    if (!createdAt) createdAt = this.now();
    if (!id) id = this.generateId();
    if (!logs) logs = null;
    if (!finishedAt && (status === "success" || status === "failed")) finishedAt = this.now();

    try {
      return await this.db.withTransaction(async (client) => {
        const now = this.now();

        const insertResult = await this.db
          .prepare(
            `INSERT INTO deployments (id, cluster_id, user_id, name, type, source, status, description, run_cmd, build_cmd, port, working_dir, static_dir, image, domain, runtime_type, runtime_version, remote_url, remote_branch, remote_commit_hash, created_at, logs, finished_at, service_id, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25)
           ON CONFLICT (name) DO UPDATE SET
             status = $7,
             description = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.description ELSE $8 END,
             run_cmd = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.run_cmd ELSE $9 END,
             build_cmd = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.build_cmd ELSE $10 END,
             port = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.port ELSE $11 END,
             working_dir = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.working_dir ELSE $12 END,
             static_dir = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.static_dir ELSE $13 END,
             image = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.image ELSE $14 END,
             domain = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.domain ELSE $15 END,
             runtime_type = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.runtime_type ELSE $16 END,
             runtime_version = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.runtime_version ELSE $17 END,
             remote_url = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.remote_url ELSE $18 END,
             remote_branch = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.remote_branch ELSE $19 END,
             remote_commit_hash = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.remote_commit_hash ELSE $20 END,
             logs = CASE WHEN $22 IS NOT NULL THEN $22 ELSE deployments.logs END,
             finished_at = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.finished_at ELSE $23 END,
             service_id = CASE WHEN deployments.finished_at IS NOT NULL THEN deployments.service_id ELSE $24 END,
             updated_at = $25
           RETURNING id, cluster_id, user_id, service_id, name, type, source, status, description, run_cmd, build_cmd, port, working_dir, static_dir, image, domain, runtime_type, runtime_version, remote_url, remote_branch, remote_commit_hash, logs, created_at, finished_at`,
          )
          .bind(
            id,
            clusterId,
            userId,
            name,
            type,
            source,
            status ?? "pending",
            description ?? null,
            runCmd ?? null,
            buildCmd ?? null,
            port ?? null,
            workingDir ?? null,
            staticDir ?? null,
            image ?? null,
            domain ?? null,
            runtimeType ?? null,
            runtimeVersion ?? null,
            remoteUrl ?? null,
            remoteBranch ?? null,
            remoteCommitHash ?? null,
            createdAt,
            logs,
            finishedAt ?? null,
            serviceId ?? null,
            now,
          )
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

  async get(filter: string | { id?: string; name?: string }): Promise<Deployment | null> {
    const id = typeof filter === "string" ? filter : filter.id;
    const name = typeof filter === "object" ? filter.name : undefined;
    const sel = `SELECT id, cluster_id, user_id, service_id, name, type, source, status, description, run_cmd, build_cmd, port, working_dir, static_dir, image, domain, runtime_type, runtime_version, remote_url, remote_branch, remote_commit_hash, logs, created_at, finished_at FROM deployments WHERE`;
    if (id) {
      const row = await this.db.prepare(`${sel} id = $1`).bind(id).first()
        ?? await this.db.prepare(`${sel} name = $1`).bind(id).first();
      return row ? this.toDeployment(row) : null;
    }
    const row = await this.db.prepare(`${sel} name = $1`).bind(name!).first();
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

    let sql = `SELECT id, cluster_id, user_id, service_id, name, type, source, status, description, run_cmd, build_cmd, port, working_dir, static_dir, image, domain, runtime_type, runtime_version, remote_url, remote_branch, remote_commit_hash, logs, created_at, finished_at FROM deployments ${clause} ORDER BY created_at DESC`;
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
      userId: row.user_id as string,
      serviceId: row.service_id as string | null,
      name: row.name as string,
      type: row.type as ServiceType,
      source: row.source as "remote" | "image",
      status: row.status as DeploymentStatus,
      description: row.description as string | null,
      runCmd: row.run_cmd as string | null,
      buildCmd: row.build_cmd as string | null,
      port: row.port as number | null,
      workingDir: row.working_dir as string | null,
      staticDir: row.static_dir as string | null,
      image: row.image as string | null,
      domain: row.domain as string | null,
      runtimeType: row.runtime_type as string | null,
      runtimeVersion: row.runtime_version as string | null,
      remoteUrl: row.remote_url as string | null,
      remoteBranch: row.remote_branch as string | null,
      remoteCommitHash: row.remote_commit_hash as string | null,
      logs: row.logs as string | null,
      createdAt: row.created_at as number,
      finishedAt: row.finished_at as number | null,
    };
  }
}
