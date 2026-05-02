// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore, Pagination } from "./base.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import type { CustomDomain, DNSProvider } from "@/types/dns.js";

export class DomainStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "domains";
  async create({ clusterId, domain, token, provider }: { clusterId: string; domain: string; token: string; provider: DNSProvider | null }): Promise<CustomDomain> {
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
      this.parsePostgresError(error);
    }
  }

  /**
   * Find a domain by its domain name.
   *
   * @param domain - The domain name to search for (exact match)
   * @returns The domain, or null if not found
   */
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

  /**
   * List domains with optional filtering and pagination.
   *
   * @param filter - Optional filter and pagination criteria
   * @param filter.clusterId - Cluster ID to filter domains by
   * @param filter.limit - Maximum number of results to return
   * @param filter.offset - Number of results to skip (for pagination)
   * @returns Object containing array of domains and total count (before pagination)
   */
  async list(filter?: { clusterId?: string } & Pagination): Promise<{ domains: CustomDomain[]; total: number }> {
    const { clause, bindings } = this.buildWhere({ cluster_id: filter?.clusterId });

    const countResult = bindings.length
      ? await this.db
          .prepare(`SELECT COUNT(*) as count FROM domains ${clause}`)
          .bind(...bindings)
          .first()
      : await this.db.prepare(`SELECT COUNT(*) as count FROM domains`).first();

    const total = Number(countResult?.count ?? 0);

    let sql = `SELECT id, cluster_id, domain, status, verification_token, provider, created_at, activated_at FROM domains ${clause} ORDER BY created_at DESC`;
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

    return { domains: results.results.map((row: any) => this.toDomain(row)), total };
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
