// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import { EncryptionService } from "@/lib/crypto/encryption.js";

export interface ServiceSecret {
  id: string;
  serviceId: string;
  key: string;
  createdAt: number;
  updatedAt: number;
}

export class ServiceSecretStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "service_secrets";

  constructor(
    db: ConstructorParameters<typeof BaseStore>[0],
    private encryption: EncryptionService,
  ) {
    super(db);
  }

  /** Upserts one or more secrets for a service or deployment. Pass `{ KEY: "value", ... }`. */
  async set({ serviceId, deploymentId, secrets }: { serviceId?: string; deploymentId?: string; secrets: Record<string, string> }): Promise<void> {
    const entries = Object.entries(secrets);
    if (!entries.length) return;
    if (!serviceId && !deploymentId) throw new Error("Either serviceId or deploymentId must be provided");

    const now = this.now();
    const conflictTarget = serviceId ? "(service_id, key)" : "(deployment_id, key)";
    const statements = entries.map(([key, value]) => {
      const id = this.generateId();
      const { valueCipher, dekCipher } = this.encryption.encrypt(value);
      return this.db
        .prepare(
          `INSERT INTO service_secrets (id, service_id, deployment_id, key, value_encrypted, dek_encrypted, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           ON CONFLICT ${conflictTarget} DO UPDATE
             SET value_encrypted = EXCLUDED.value_encrypted,
                 dek_encrypted   = EXCLUDED.dek_encrypted,
                 updated_at      = EXCLUDED.updated_at`,
        )
        .bind(id, serviceId ?? null, deploymentId ?? null, key, valueCipher, dekCipher, now, now);
    });

    await this.db.batch(statements);
  }

  async get({ serviceId, key }: { serviceId: string; key: string }): Promise<{ meta: ServiceSecret; value: string } | null> {
    const row = await this.db
      .prepare(`SELECT id, service_id, key, value_encrypted, dek_encrypted, created_at, updated_at FROM service_secrets WHERE service_id = $1 AND key = $2`)
      .bind(serviceId, key)
      .first();

    if (!row) return null;

    const value = this.encryption.decrypt(Buffer.from(row.value_encrypted as any), Buffer.from(row.dek_encrypted as any));
    return { meta: this.toSecret(row), value };
  }

  /**
   * Decrypts the requested keys for a service and returns them as a plain key→value map.
   * Used during reprovision to reconstruct the full deployment payload.
   * `missing` lists keys that were requested but not found in storage — caller should surface these as an error.
   */
  async getDecrypted({ serviceId, keys }: { serviceId: string; keys: string[] }): Promise<{ values: Record<string, string>; missing: string[] }> {
    if (!keys.length) return { values: {}, missing: [] };

    const placeholders = keys.map((_, i) => `$${i + 2}`).join(", ");
    const rows = await this.db
      .prepare(`SELECT key, value_encrypted, dek_encrypted FROM service_secrets WHERE service_id = $1 AND key IN (${placeholders})`)
      .bind(serviceId, ...keys)
      .all();

    const values: Record<string, string> = {};
    for (const row of rows.results) {
      values[row.key as string] = this.encryption.decrypt(Buffer.from(row.value_encrypted as any), Buffer.from(row.dek_encrypted as any));
    }

    const missing = keys.filter((k) => !(k in values));
    return { values, missing };
  }

  /**
   * List secrets for a service. Returns metadata only — no decrypted values. Use `get` or `getDecrypted` for values.
   *
   * @param serviceId - Service ID to list secrets for
   * @returns Array of secrets with metadata
   */
  async list({ serviceId, serviceName }: { serviceId: string; serviceName?: string | null }): Promise<ServiceSecret[]> {
    const results = serviceName
      ? await this.db
          .prepare(
            `SELECT ss.id, ss.service_id, ss.key, ss.created_at, ss.updated_at
             FROM service_secrets ss
             LEFT JOIN deployments d ON ss.deployment_id = d.id
             WHERE ss.service_id = $1 OR d.name = $2
             ORDER BY ss.key ASC`,
          )
          .bind(serviceId, serviceName)
          .all()
      : await this.db
          .prepare(`SELECT id, service_id, key, created_at, updated_at FROM service_secrets WHERE service_id = $1 ORDER BY key ASC`)
          .bind(serviceId)
          .all();
    return results.results.map((r) => this.toSecret(r));
  }

  async delete({ serviceId, key }: { serviceId: string; key: string }): Promise<void> {
    await this.db.prepare(`DELETE FROM service_secrets WHERE service_id = $1 AND key = $2`).bind(serviceId, key).run();
  }

  async clear({ serviceId }: { serviceId: string }): Promise<void> {
    await this.db.prepare(`DELETE FROM service_secrets WHERE service_id = $1`).bind(serviceId).run();
  }

  /** Deletes orphaned secrets (service no longer exists) older than 6 months. Returns the number of deleted rows. */
  async cleanup(): Promise<number> {
    const result = await this.db
      .prepare(
        `DELETE FROM service_secrets
         WHERE service_id NOT IN (SELECT id FROM services)
         AND updated_at < EXTRACT(EPOCH FROM (NOW() - INTERVAL '6 months')) * 1000`,
      )
      .run();
    return result.meta.changes ?? 0;
  }

  private toSecret(row: any): ServiceSecret {
    return {
      id: row.id as string,
      serviceId: row.service_id as string,
      key: row.key as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
