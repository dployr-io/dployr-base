// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore, type Pagination } from "./base.js";

export type OidcProvider = "github" | "gitlab" | "bitbucket";

export interface OidcBinding {
  id: string;
  userId: string;
  clusterId: string;
  provider: OidcProvider;
  issuer: string;
  subject: string;
  name: string | null;
  createdAt: number;
}

type OidcBindingRow = {
  id: string;
  user_id: string;
  cluster_id: string;
  provider: OidcProvider;
  issuer: string;
  subject: string;
  name: string | null;
  created_at: number;
};

const SELECT_COLS = "id, user_id, cluster_id, provider, issuer, subject, name, created_at";

export type OidcBindingFilter = {
  id?: string;
  userId?: string;
  clusterId?: string;
  provider?: OidcProvider;
  issuer?: string;
  subject?: string;
};

export class OidcBindingStore extends BaseStore {
  protected readonly storeTable = "oidc_bindings" as const;

  async create(params: {
    userId: string;
    clusterId: string;
    provider: OidcProvider;
    issuer: string;
    subject: string;
    name?: string;
  }): Promise<OidcBinding> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const row = await this.db
      .prepare(
        `INSERT INTO oidc_bindings (id, user_id, cluster_id, provider, issuer, subject, name, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING ${SELECT_COLS}`,
      )
      .bind(id, params.userId, params.clusterId, params.provider, params.issuer, params.subject, params.name ?? null, now)
      .first<OidcBindingRow>();
    return toBinding(row!);
  }

  async find(filter: OidcBindingFilter): Promise<OidcBinding | null> {
    const { clause, bindings } = this.buildWhere({
      id: filter.id,
      user_id: filter.userId,
      cluster_id: filter.clusterId,
      provider: filter.provider,
      issuer: filter.issuer,
      subject: filter.subject,
    });
    if (!bindings.length) return null;
    const row = await this.db
      .prepare(`SELECT ${SELECT_COLS} FROM oidc_bindings ${clause} LIMIT 1`)
      .bind(...bindings)
      .first<OidcBindingRow>();
    return row ? toBinding(row) : null;
  }

  async list(filter: OidcBindingFilter & Pagination): Promise<{ bindings: OidcBinding[]; total: number }> {
    const { clause, bindings } = this.buildWhere({
      user_id: filter.userId,
      cluster_id: filter.clusterId,
      provider: filter.provider,
      issuer: filter.issuer,
    });

    const countResult = await this.db
      .prepare(`SELECT COUNT(*) as count FROM oidc_bindings ${clause}`)
      .bind(...bindings)
      .first();
    const total = Number(countResult?.count ?? 0);

    const dataBindings: any[] = [...bindings];
    let sql = `SELECT ${SELECT_COLS} FROM oidc_bindings ${clause} ORDER BY created_at DESC`;

    if (filter.limit !== undefined) {
      dataBindings.push(filter.limit);
      sql += ` LIMIT $${dataBindings.length}`;
    }
    if (filter.offset !== undefined) {
      dataBindings.push(filter.offset);
      sql += ` OFFSET $${dataBindings.length}`;
    }

    const { results } = await this.db.prepare(sql).bind(...dataBindings).all<OidcBindingRow>();
    return { bindings: results.map(toBinding), total };
  }

  async delete(id: string, userId: string): Promise<boolean> {
    const result = await this.db
      .prepare(`DELETE FROM oidc_bindings WHERE id = $1 AND user_id = $2`)
      .bind(id, userId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }
}

function toBinding(row: OidcBindingRow): OidcBinding {
  return {
    id: row.id,
    userId: row.user_id,
    clusterId: row.cluster_id,
    provider: row.provider,
    issuer: row.issuer,
    subject: row.subject,
    name: row.name,
    createdAt: row.created_at,
  };
}
