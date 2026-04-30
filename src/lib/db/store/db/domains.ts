// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import type { CustomDomain, DNSProvider } from "@/types/dns.js";

export class DomainStore extends BaseStore {
  async create(clusterId: string, domain: string, token: string, provider: DNSProvider | null): Promise<CustomDomain> {
    const id = this.generateId();
    const now = this.now();

    try {
      await this.db
        .prepare(
          `INSERT INTO domains (id, cluster_id, domain, verification_token, provider, created_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
        )
        .bind(id, clusterId, domain, token, provider, now)
        .run();

      return {
        id,
        clusterId,
        domain,
        status: "pending",
        verificationToken: token,
        provider,
        createdAt: now,
        activatedAt: null,
      };
    } catch (error) {
      this.parsePostgresError({ error, table: "domains" });
    }
  }

  async find(domain: string): Promise<CustomDomain | null> {
    const row = await this.db
      .prepare(
        `SELECT id, cluster_id, domain, status, verification_token, provider, created_at, activated_at
         FROM domains WHERE domain = $1`,
      )
      .bind(domain)
      .first();

    if (!row) return null;
    return this.toDomain(row);
  }

  async list(filter?: { clusterId?: string }): Promise<CustomDomain[]> {
    const { clause, bindings } = this.buildWhere({ cluster_id: filter?.clusterId });

    const results = bindings.length
      ? await this.db
          .prepare(`SELECT id, cluster_id, domain, status, verification_token, provider, created_at, activated_at FROM domains ${clause} ORDER BY created_at DESC`)
          .bind(...bindings)
          .all()
      : await this.db.prepare(`SELECT id, cluster_id, domain, status, verification_token, provider, created_at, activated_at FROM domains ORDER BY created_at DESC`).all();

    return results.results.map((row: any) => this.toDomain(row));
  }

  async activate(domain: string): Promise<void> {
    await this.db.prepare(`UPDATE domains SET status = 'active', activated_at = $1 WHERE domain = $2`).bind(this.now(), domain).run();
  }

  async delete(domain: string): Promise<void> {
    await this.db.prepare(`DELETE FROM domains WHERE domain = $1`).bind(domain).run();
  }

  private toDomain(row: any): CustomDomain {
    return {
      id: row.id as string,
      clusterId: row.cluster_id as string,
      domain: row.domain as string,
      status: row.status as "pending" | "active",
      verificationToken: row.verification_token as string,
      provider: row.provider as DNSProvider | null,
      createdAt: row.created_at as number,
      activatedAt: row.activated_at as number | null,
    };
  }
}
