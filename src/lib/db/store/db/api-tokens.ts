// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore, type Pagination } from "./base.js";

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  scopes: string[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
}

type ApiTokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_hash: string;
  scopes: string[];
  created_at: number;
  expires_at: number | null;
  last_used_at: number | null;
};

const SELECT_COLS = "id, user_id, name, scopes, created_at, expires_at, last_used_at";

function toToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    scopes: row.scopes ?? [],
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
  };
}

export class ApiTokenStore extends BaseStore {
  protected readonly storeTable = "api_tokens" as const;

  async create(params: { userId: string; name: string; tokenHash: string; scopes: string[]; expiresAt?: number }): Promise<ApiToken> {
    const id = crypto.randomUUID();
    const now = Date.now();
    const row = await this.db
      .prepare(
        `INSERT INTO api_tokens (id, user_id, name, token_hash, scopes, created_at, expires_at)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
         RETURNING ${SELECT_COLS}`,
      )
      .bind(id, params.userId, params.name, params.tokenHash, JSON.stringify(params.scopes), now, params.expiresAt ?? null)
      .first<ApiTokenRow>();
    return toToken(row!);
  }

  async findByHash(tokenHash: string): Promise<(ApiToken & { tokenHash: string }) | null> {
    const row = await this.db
      .prepare(`SELECT ${SELECT_COLS}, token_hash FROM api_tokens WHERE token_hash = $1`)
      .bind(tokenHash)
      .first<ApiTokenRow>();
    if (!row) return null;
    return { ...toToken(row), tokenHash: row.token_hash };
  }

  async list(filter: { userId: string } & Pagination): Promise<{ tokens: ApiToken[]; total: number }> {
    const { clause, bindings } = this.buildWhere({ user_id: filter.userId });

    const countResult = await this.db.prepare(`SELECT COUNT(*) as count FROM api_tokens ${clause}`).bind(...bindings).first();
    const total = Number(countResult?.count ?? 0);

    const dataBindings: any[] = [...bindings];
    let sql = `SELECT ${SELECT_COLS} FROM api_tokens ${clause} ORDER BY created_at DESC`;

    if (filter.limit !== undefined) {
      dataBindings.push(filter.limit);
      sql += ` LIMIT $${dataBindings.length}`;
    }
    if (filter.offset !== undefined) {
      dataBindings.push(filter.offset);
      sql += ` OFFSET $${dataBindings.length}`;
    }

    const { results } = await this.db.prepare(sql).bind(...dataBindings).all<ApiTokenRow>();
    return { tokens: results.map(toToken), total };
  }

  async updateLastUsed(id: string): Promise<void> {
    await this.db.prepare(`UPDATE api_tokens SET last_used_at = $1 WHERE id = $2`).bind(Date.now(), id).run();
  }

  async revoke(id: string, userId: string): Promise<boolean> {
    const result = await this.db.prepare(`DELETE FROM api_tokens WHERE id = $1 AND user_id = $2`).bind(id, userId).run();
    return (result.meta.changes ?? 0) > 0;
  }
}
