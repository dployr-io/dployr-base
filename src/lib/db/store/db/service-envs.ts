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

  /** Upserts one or more env vars for a service. Pass `{ KEY: "value", ... }`. */
  async set({ serviceId, envs }: { serviceId: string; envs: Record<string, string> }): Promise<void> {
    const entries = Object.entries(envs);
    if (!entries.length) return;

    const now = this.now();
    const statements = entries.map(([key, value]) => {
      const id = this.generateId();
      return this.db
        .prepare(
          `INSERT INTO service_envs (id, service_id, key, value, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (service_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
        )
        .bind(id, serviceId, key, value, now, now);
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
  async list({ serviceId }: { serviceId: string }): Promise<ServiceEnv[]> {
    const results = await this.db
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

  private toEnv(row: any): ServiceEnv {
    return {
      id: row.id as string,
      serviceId: row.service_id as string,
      key: row.key as string,
      value: row.value as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
