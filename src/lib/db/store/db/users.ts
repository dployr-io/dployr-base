// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { type OAuthProvider, User, type RequiredOnly } from "@/types/index.js";
import { BaseStore } from "./base.js";

export class UserStore extends BaseStore {
  async save(user: RequiredOnly<Omit<User, "id" | "createdAt" | "updatedAt">, "email" | "provider" | "metadata">): Promise<User | null> {
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
        if (!savedUser) {
          return null;
        }

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

        return {
          id: savedUser.id,
          email: savedUser.email,
          name: savedUser.name || "",
          picture: savedUser.picture || "",
          provider: savedUser.provider as OAuthProvider,
          metadata: savedUser.metadata,
          createdAt: savedUser.created_at,
          updatedAt: savedUser.updated_at,
        };
      } catch (error) {
        this.parsePostgresError({ error, table: "clusters" });
      }
    });
  }

  async get(email: string): Promise<User | null> {
    const stmt = this.db.prepare(`
            SELECT id, email, name, picture, provider, metadata, created_at, updated_at 
            FROM users WHERE email = $1
        `);

    const result = await stmt.bind(email).first();
    if (!result) return null;

    return {
      ...result,
      metadata: (result as any).metadata || {},
    } as User;
  }

  async getById(userId: string): Promise<User | null> {
    const stmt = this.db.prepare(`
            SELECT id, email, name, picture, provider, metadata, created_at, updated_at 
            FROM users WHERE id = $1
        `);

    const result = await stmt.bind(userId).first();
    if (!result) return null;

    return {
      ...result,
      metadata: (result as any).metadata || {},
    } as User;
  }

  // By deliberate design, users cannot update their email addresses
  // To change a user's email, create a new user with the desired email,
  // assign the relevant roles, and then remove the previous user account
  async update(email: string, updates: Partial<Omit<User, "id" | "email" | "createdAt">>): Promise<User | null> {
    if (!updates.name && !updates.picture && !updates.provider && !updates.metadata) {
      return this.get(email);
    }

    const now = this.now();
    const setClauses: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    if (updates.name !== undefined) {
      setClauses.push(`name = $${paramIndex++}`);
      values.push(updates.name);
    }
    if (updates.picture !== undefined) {
      setClauses.push(`picture = $${paramIndex++}`);
      values.push(updates.picture);
    }
    if (updates.provider !== undefined) {
      setClauses.push(`provider = $${paramIndex++}`);
      values.push(updates.provider);
    }
    if (updates.metadata !== undefined) {
      setClauses.push(`metadata = COALESCE(metadata, '{}'::jsonb) || $${paramIndex++}::jsonb`);
      values.push(updates.metadata);
    }

    setClauses.push(`updated_at = $${paramIndex++}`);
    values.push(now, email);

    const query = `
            UPDATE users 
            SET ${setClauses.join(", ")} 
            WHERE email = $${paramIndex}
            RETURNING id, email, name, picture, provider, metadata, created_at, updated_at
        `;

    const result = await this.db
      .prepare(query)
      .bind(...values)
      .first<{
        id: string;
        email: string;
        name: string | null;
        picture: string | null;
        provider: string;
        metadata: Record<string, unknown>;
        created_at: number;
        updated_at: number;
      }>();

    if (!result) return null;

    return {
      id: result.id,
      email: result.email,
      name: result.name || "",
      picture: result.picture || "",
      provider: result.provider as OAuthProvider,
      metadata: result.metadata,
      createdAt: result.created_at,
      updatedAt: result.updated_at,
    };
  }
}
