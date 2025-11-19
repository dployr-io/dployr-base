import { Instance } from "@/types";
import { BaseStore } from "./base";

export class InstanceStore extends BaseStore {
    async create(
        clusterId: string,
        publicKey: string,
        data: Omit<Instance, "id" | "createdAt" | "updatedAt">
    ): Promise<Instance> {
        const id = this.generateId();
        const now = this.now();

        const stmt = this.db.prepare(`
            INSERT INTO instances (id, cluster_id, public_key, address, tag, metadata, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        await stmt.bind(
            id,
            clusterId,
            publicKey,
            data.address,
            data.tag,
            JSON.stringify(data.metadata || {}),
            now,
            now
        ).run();

        return {
            id,
            ...data,
            createdAt: now,
            updatedAt: now,
        };
    }

    async get(id: string): Promise<(Omit<Instance, "resources" | "status"> & { clusterId: string }) | null> {
        const stmt = this.db.prepare(`
      SELECT instances.id, instances.address, instances.public_key, instances.tag, instances.metadata, instances.created_at, instances.updated_at, clusters.id as clusterId
      FROM instances
      JOIN user_clusters ON user_clusters.cluster_id = instances.cluster_id
      JOIN clusters ON clusters.id = user_clusters.cluster_id
      WHERE instances.id = ?
    `);

        const result = await stmt.bind(id).first();
        if (!result) return null;

        return {
            id: result.id as string,
            address: result.address as string,
            publicKey: result.public_key as string,
            tag: result.tag as string,
            metadata: result.metadata ? JSON.parse(result.metadata as string) : {},
            createdAt: result.created_at as number,
            updatedAt: result.updated_at as number,
            clusterId: result.clusterId as string,
        };
    }

    async update(
        id: string,
        updates: Partial<Omit<Instance, "id" | "resources" | "status" | "createdAt">>
    ): Promise<(Omit<Instance, "resources" | "status"> & { clusterId: string }) | null> {
        if (!updates.address && !updates.tag && !updates.metadata) {
            return this.get(id);
        }

        // Prepare all statements for atomic execution
        const statements = [];

        // Handle metadata update atomically
        if (updates.metadata) {
            const updatesJson = JSON.stringify(updates.metadata);
            statements.push(
                this.db.prepare(`
                    UPDATE instances 
                    SET metadata = json_patch(COALESCE(metadata, '{}'), ?),
                        updated_at = ?
                    WHERE id = ?
                `).bind(updatesJson, this.now(), id)
            );
        }

        // Handle other field updates
        const updateData: Record<string, any> = {};
        if (updates.address) updateData.address = updates.address;
        if (updates.tag) updateData.tag = updates.tag;

        if (Object.keys(updateData).length > 0) {
            const fields: string[] = [];
            const values: any[] = [];

            for (const [field, value] of Object.entries(updateData)) {
                fields.push(`${field} = ?`);
                values.push(value);
            }

            fields.push("updated_at = ?");
            values.push(this.now(), id);

            const query = `UPDATE instances SET ${fields.join(", ")} WHERE id = ?`;
            statements.push(this.db.prepare(query).bind(...values));
        }

        // Execute all updates atomically
        if (statements.length > 0) {
            await this.db.batch(statements);
        }

        return this.get(id);
    }

    async delete(id: string): Promise<void> {
        await this.db.prepare(`DELETE FROM instances WHERE id = ?`).bind(id).run();
    }

    async getByCluster(
        clusterId: string,
        limit?: number,
        offset?: number
    ): Promise<{ instances: Omit<Instance, "resources" | "status">[]; total: number }> {
        if (clusterId.length === 0) return { instances: [], total: 0 };

        // Get total count
        const countStmt = this.db.prepare(`
            SELECT COUNT(*) as count
            FROM instances WHERE cluster_id = ?
        `);
        const countResult = await countStmt.bind(clusterId).first();
        const total = (countResult?.count as number) || 0;
        const limitClause = limit !== undefined ? `LIMIT ${limit}` : '';
        const offsetClause = offset !== undefined ? `OFFSET ${offset}` : '';

        const stmt = this.db.prepare(`
            SELECT id, address, public_key, tag, metadata, created_at, updated_at
            FROM instances WHERE cluster_id = ?
            ORDER BY created_at DESC
            ${limitClause} ${offsetClause}
        `);

        const results = await stmt.bind(clusterId).all();

        const instances = results.results.map((row) => ({
            id: row.id as string,
            address: row.address as string,
            publicKey: row.public_key as string,
            tag: row.tag as string,
            metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
        }));

        return { instances, total };
    }
}