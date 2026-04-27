// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { type OAuthProvider, User, type RequiredOnly } from "@/types/index.js";
import { BaseStore } from "./base.js";

/** Fields that can be used to look up a user. */
export type UserFilter = {
  id?: string;
  email?: string;
};

export class UserStore extends BaseStore {
  /**
   * Upserts a user record. On conflict by email the name, picture, provider,
   * and metadata are merged with the existing row.
   */
  async upsert(user: RequiredOnly<Omit<User, "id" | "createdAt" | "updatedAt">, "email" | "provider" | "metadata">): Promise<User | null> {
    const id = this.generateId();
    const now = this.now();
    const metadataJson = user.metadata || {};

    return this.db.withTransaction(async (client) => {
      try {
        const userResult = await client.query(
          `INSERT INTO users (id, email, name, picture, provider, metadata, created_at, updated_at)
                 VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
                 ON CONFLICT(email) DO UPDATE SET
                   name = COALESCE(excluded.name, users.name),
                   picture = COALESCE(excluded.picture, users.picture),
                   provider = excluded.provider,
                   metadata = COALESCE(users.metadata, '{}'::jsonb) || excluded.metadata::jsonb,
                   updated_at = excluded.updated_at
                 RETURNING id, email, name, picture, provider, metadata, created_at, updated_at`,
          [id, user.email, user.name || null, user.picture || null, user.provider, metadataJson, now, now],
        );

        const savedUser = userResult.rows[0];
        if (!savedUser) return null;

        if (user.metadata && Object.keys(user.metadata).length > 0) {
          await client.query(
            `UPDATE clusters
                     SET metadata = COALESCE(metadata, '{}'::jsonb) || $1::jsonb,
                         updated_at = $2
                     WHERE id IN (
                       SELECT uc.cluster_id
                       FROM user_clusters uc
                       JOIN users u ON uc.user_id = u.id
                       WHERE u.email = $3 AND uc.role IN ('owner', 'admin')
                     )`,
            [user.metadata, now, user.email],
          );
        }

        return this.toUser(savedUser);
      } catch (error) {
        this.parsePostgresError({ error, table: "clusters" });
      }
    });
  }

  /**
   * Returns the first user matching the given filter, or `null` if not found.
   * At least one filter field must be set.
   */
  async find(filter: UserFilter): Promise<User | null> {
    const { clause, bindings } = this.buildWhere({ id: filter.id, email: filter.email });
    if (!bindings.length) return null;

    const result = await this.db
      .prepare(`SELECT id, email, name, picture, provider, metadata, created_at, updated_at FROM users ${clause} LIMIT 1`)
      .bind(...bindings)
      .first();

    return result ? this.toUser(result) : null;
  }

  /**
   * Updates mutable fields on a user identified by email.
   * Email cannot be changed — create a new account and transfer roles instead.
   */
  async update(email: string, updates: Partial<Omit<User, "id" | "email" | "createdAt">>): Promise<User | null> {
    if (!updates.name && !updates.picture && !updates.provider && !updates.metadata) {
      return this.find({ email });
    }

    const now = this.now();
    const parts: string[] = [];
    const values: any[] = [];
    let p = 1;

    if (updates.name !== undefined) {
      parts.push(`name = $${p++}`);
      values.push(updates.name);
    }
    if (updates.picture !== undefined) {
      parts.push(`picture = $${p++}`);
      values.push(updates.picture);
    }
    if (updates.provider !== undefined) {
      parts.push(`provider = $${p++}`);
      values.push(updates.provider);
    }
    if (updates.metadata !== undefined) {
      parts.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${p++}::jsonb`);
      values.push(updates.metadata);
    }

    parts.push(`updated_at = $${p++}`);
    values.push(now, email);

    const result = await this.db
      .prepare(`UPDATE users SET ${parts.join(", ")} WHERE email = $${p} RETURNING id, email, name, picture, provider, metadata, created_at, updated_at`)
      .bind(...values)
      .first<{ id: string; email: string; name: string | null; picture: string | null; provider: string; metadata: Record<string, unknown>; created_at: number; updated_at: number }>();

    return result ? this.toUser(result) : null;
  }

  private toUser(row: any): User {
    return {
      id: row.id,
      email: row.email,
      name: row.name || "",
      picture: row.picture || "",
      provider: row.provider as OAuthProvider,
      metadata: row.metadata || {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
