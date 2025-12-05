// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Instance } from "@/types/index.js";
import { BaseStore } from "./base.js";

export class InstanceConflictError extends Error {
    constructor(public field: "address" | "tag" | "instance") {
        super("Instance conflict on " + field);
        this.name = "InstanceConflictError";
    }
}

export class InstanceStore extends BaseStore {
    async create(
        clusterId: string,
        data: Omit<Instance, "id" | "createdAt" | "updatedAt">
    ): Promise<Instance> {
        const id = this.generateId();
        const now = this.now();

        const stmt = this.db.prepare(`
            INSERT INTO instances (id, cluster_id, address, tag, metadata, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7)
        `);

        try {
            await stmt
                .bind(
                    id,
                    clusterId,
                    data.address || null,
                    data.tag,
                    JSON.stringify(data.metadata || {}),
                    now,
                    now,
                )
                .run();
        } catch (error) {
            if (error instanceof Error && error.message.includes("duplicate key value")) {
                if (error.message.includes("instances_address")) {
                    throw new InstanceConflictError("address");
                }
                if (error.message.includes("instances_tag")) {
                    throw new InstanceConflictError("tag");
                }
                throw new InstanceConflictError("instance");
            }
            throw error;
        }

        return {
            id,
            ...data,
            createdAt: now,
            updatedAt: now,
        };
    }

    async get(id: string): Promise<(Instance & { clusterId: string }) | null> {
        const stmt = this.db.prepare(`
            SELECT instances.id, instances.address, instances.tag, instances.metadata, instances.created_at, instances.updated_at, clusters.id as clusterId
            FROM instances
            JOIN user_clusters ON user_clusters.cluster_id = instances.cluster_id
            JOIN clusters ON clusters.id = user_clusters.cluster_id
            WHERE instances.id = $1
        `);

        const result = await stmt.bind(id).first();
        if (!result) return null;

        return {
            id: result.id as string,
            address: result.address as string,
            tag: result.tag as string,
            metadata: result.metadata ? JSON.parse(result.metadata as string) : {},
            createdAt: result.created_at as number,
            updatedAt: result.updated_at as number,
            clusterId: result.clusterId as string,
        };
    }

    async updateMetadata(id: string, metadata: Record<string, any>): Promise<void> {
        const now = this.now();
        const stmt = this.db.prepare(`
            UPDATE instances
            SET metadata = $1::jsonb, updated_at = $2
            WHERE id = $3
        `);

        await stmt.bind(JSON.stringify(metadata || {}), now, id).run();
    }

    async delete(id: string): Promise<void> {
        await this.db.prepare(`DELETE FROM instances WHERE id = $1`).bind(id).run();
    }

    async getByCluster(
        clusterId: string,
        limit?: number,
        offset?: number
    ): Promise<{ instances: Instance[]; total: number }> {
        if (clusterId.length === 0) return { instances: [], total: 0 };

        // Get total count
        const countStmt = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM instances WHERE cluster_id = $1
        `);
        const countResult = await countStmt.bind(clusterId).first();
        const total = (countResult?.count as number) || 0;
        const limitClause = limit !== undefined ? `LIMIT ${limit}` : '';
        const offsetClause = offset !== undefined ? `OFFSET ${offset}` : '';

        const stmt = this.db.prepare(`
            SELECT id, address, tag, metadata, created_at, updated_at
            FROM instances WHERE cluster_id = $1
            ORDER BY created_at DESC
            ${limitClause} ${offsetClause}
        `);

        const results = await stmt.bind(clusterId).all();

        const instances = results.results.map((row) => ({
            id: row.id as string,
            address: row.address as string,
            tag: row.tag as string,
            metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
        }));

        return { instances, total };
    }
}