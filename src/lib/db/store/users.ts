// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { type OAuthProvider, User, type RequiredOnly } from "@/types";
import { BaseStore } from "./base";

export class UserStore extends BaseStore {
    async save(user: RequiredOnly<Omit<User, "id" | "createdAt" | "updatedAt">,
        "email" | "provider" | "metadata"
    >): Promise<User | null> {
        const id = this.generateId();
        const now = this.now();
        const metadataJson = JSON.stringify(user.metadata || {});

        const statements = [];

        // Insert or update user
        const userStatement = this.db.prepare(`
            INSERT INTO users (id, email, name, picture, provider, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                name = COALESCE(excluded.name, users.name),
                picture = COALESCE(excluded.picture, users.picture),
                provider = excluded.provider,
                metadata = COALESCE(excluded.metadata, users.metadata),
                updated_at = excluded.updated_at
            RETURNING id, email, name, picture, provider, metadata, created_at, updated_at
        `).bind(
            id,
            user.email,
            user.name || null,
            user.picture || null,
            user.provider,
            metadataJson,
            now,
            now
        );
        
        // Sync metadata to admin clusters
        if (user.metadata && Object.keys(user.metadata).length > 0) {
            statements.push(
                this.db.prepare(`
                    UPDATE clusters
                    SET metadata = json_patch(COALESCE(metadata, '{}'), ?),
                        updated_at = ?
                    WHERE id IN (
                        SELECT uc.cluster_id 
                        FROM user_clusters uc
                        JOIN users u ON uc.user_id = u.id
                        WHERE u.email = ? AND uc.role IN ('owner', 'admin')
                    )
                `).bind(metadataJson, now, user.email)
            );
        }

        const savedUser = await userStatement.first<{
            id: string;
            email: string;
            name: string | null;
            picture: string | null;
            provider: string;
            metadata: string;
            created_at: number;
            updated_at: number;
        }>();

        if (statements.length > 0) {
            await this.db.batch(statements);
        }

        if (!savedUser) return null;

        return {
            id: savedUser.id,
            email: savedUser.email,
            name: savedUser.name || "",
            picture: savedUser.picture || "",
            provider: savedUser.provider as OAuthProvider,
            metadata: JSON.parse(savedUser.metadata),
            createdAt: savedUser.created_at,
            updatedAt: savedUser.updated_at,
        };
    }

    async get(email: string): Promise<User | null> {
        const stmt = this.db.prepare(`
            SELECT id, email, name, picture, provider, metadata, created_at, updated_at 
            FROM users WHERE email = ?
        `);

        const result = await stmt.bind(email).first();
        if (!result) return null;

        return {
            ...result,
            metadata: result.metadata ? JSON.parse(result.metadata as string) : {},
        } as User;
    }

    // By deliberate design, users cannot update their email addresses
    // To change a user's email, create a new user with the desired email,
    // assign the relevant roles, and then remove the previous user account
    async update(
        email: string,
        updates: Partial<Omit<User, "id" | "email" | "createdAt">>
    ): Promise<User | null> {
        if (!updates.name && !updates.picture && !updates.provider && !updates.metadata) {
            return this.get(email);
        }

        const now = this.now();
        const setClauses: string[] = [];
        const values: any[] = [];

        if (updates.name !== undefined) {
            setClauses.push("name = ?");
            values.push(updates.name);
        }
        if (updates.picture !== undefined) {
            setClauses.push("picture = ?");
            values.push(updates.picture);
        }
        if (updates.provider !== undefined) {
            setClauses.push("provider = ?");
            values.push(updates.provider);
        }
        if (updates.metadata !== undefined) {
            setClauses.push("metadata = json_patch(COALESCE(metadata, '{}'), ?)");
            values.push(JSON.stringify(updates.metadata));
        }

        setClauses.push("updated_at = ?");
        values.push(now, email);

        const query = `
            UPDATE users 
            SET ${setClauses.join(", ")} 
            WHERE email = ?
            RETURNING id, email, name, picture, provider, metadata, created_at, updated_at
        `;

        const result = await this.db.prepare(query).bind(...values).first<{
            id: string;
            email: string;
            name: string | null;
            picture: string | null;
            provider: string;
            metadata: string;
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
            metadata: JSON.parse(result.metadata),
            createdAt: result.created_at,
            updatedAt: result.updated_at,
        };
    }
}