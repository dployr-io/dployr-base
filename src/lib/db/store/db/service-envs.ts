// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import { type AllowedTable } from "@/lib/constants/index.js";

export interface ServiceEnv {
  id: string;
  serviceId: string;
  key: string;
  value: string;
  createdAt: number;
  updatedAt: number;
}

export class ServiceEnvStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "service_envs";

  /** Upserts one or more env vars for a service or deployment. Pass `{ KEY: "value", ... }`. */
  async set({ serviceId, deploymentId, envs }: { serviceId?: string; deploymentId?: string; envs: Record<string, string> }): Promise<void> {
    const entries = Object.entries(envs);
    if (!entries.length) return;
    if (!serviceId && !deploymentId) throw new Error("Either serviceId or deploymentId must be provided");

    const now = this.now();
    const conflictTarget = serviceId ? "(service_id, key)" : "(deployment_id, key)";
    const statements = entries.map(([key, value]) => {
      const id = this.generateId();
      return this.db
        .prepare(
          `INSERT INTO service_envs (id, service_id, deployment_id, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)
           ON CONFLICT ${conflictTarget} DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        )
        .bind(id, serviceId ?? null, deploymentId ?? null, key, value, now, now);
    });

    await this.db.batch(statements);
  }

  async get({ serviceId, key }: { serviceId: string; key: string }): Promise<ServiceEnv | null> {
    const row = await this.db
      .prepare(`SELECT id, service_id, key, value, created_at, updated_at FROM service_envs WHERE service_id = $1 AND key = $2`)
      .bind(serviceId, key)
      .first();
    return row ? this.toEnv(row) : null;
  }

  /**
   * List environment variables for a service.
   *
   * @param serviceId - Service ID to list environment variables for
   * @returns Array of environment variables
   */
  async list({ serviceId, serviceName }: { serviceId: string; serviceName?: string | null }): Promise<ServiceEnv[]> {
    const results = serviceName
      ? await this.db
          .prepare(
            `SELECT se.id, se.service_id, se.key, se.value, se.created_at, se.updated_at
             FROM service_envs se
             LEFT JOIN deployments d ON se.deployment_id = d.id
             WHERE se.service_id = $1 OR d.name = $2
             ORDER BY se.key ASC`,
          )
          .bind(serviceId, serviceName)
          .all()
      : await this.db
          .prepare(`SELECT id, service_id, key, value, created_at, updated_at FROM service_envs WHERE service_id = $1 ORDER BY key ASC`)
          .bind(serviceId)
          .all();
    return results.results.map((r) => this.toEnv(r));
  }

  async delete({ serviceId, key }: { serviceId: string; key: string }): Promise<void> {
    await this.db.prepare(`DELETE FROM service_envs WHERE service_id = $1 AND key = $2`).bind(serviceId, key).run();
  }

  async clear({ serviceId }: { serviceId: string }): Promise<void> {
    await this.db.prepare(`DELETE FROM service_envs WHERE service_id = $1`).bind(serviceId).run();
  }

  /**
   * Atomically replaces ALL env vars for a service. Executes DELETE + INSERT in a single D1 batch
   * so a crash between the two can never leave the row-set in a partial state.
   * Pass `deploymentId` to also clear any envs still stored under the linked deployment record.
   */
  async replace({ serviceId, deploymentId, envs }: { serviceId: string; deploymentId?: string; envs: Record<string, string> }): Promise<void> {
    const deleteStmts = [
      this.db.prepare(`DELETE FROM service_envs WHERE service_id = $1`).bind(serviceId),
      ...(deploymentId ? [this.db.prepare(`DELETE FROM service_envs WHERE deployment_id = $1`).bind(deploymentId)] : []),
    ];
    const entries = Object.entries(envs);
    if (!entries.length) {
      await this.db.batch(deleteStmts);
      return;
    }
    const now = this.now();
    const insertStmts = entries.map(([key, value]) => {
      const id = this.generateId();
      return this.db
        .prepare(
          `INSERT INTO service_envs (id, service_id, deployment_id, key, value, created_at, updated_at)
           VALUES ($1, $2, NULL, $3, $4, $5, $6)
           ON CONFLICT (service_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        )
        .bind(id, serviceId, key, value, now, now);
    });
    await this.db.batch([...deleteStmts, ...insertStmts]);
  }

  private toEnv(row: any): ServiceEnv {
    return {
      id: row.id as string,
      serviceId: row.service_id as string,
      key: row.key as string,
      value: row.value as string,
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
    };
  }
}
