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

    async get(id: string): Promise<Instance | null> {
        const stmt = this.db.prepare(`
      SELECT id, address, public_key, tag, metadata, created_at, updated_at
      FROM instances WHERE id = ?
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
        };
    }

    async update(
        id: string,
        updates: Partial<Omit<Instance, "id" | "createdAt">>
    ): Promise<Instance | null> {
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

    async getByClusters(clusterIds: string[]): Promise<Instance[]> {
        if (clusterIds.length === 0) return [];

        const placeholders = clusterIds.map(() => '?').join(',');
        const stmt = this.db.prepare(`
            SELECT id, address, tag, metadata, created_at, updated_at
            FROM instances WHERE cluster_id IN (${placeholders})
            ORDER BY created_at DESC
        `);

        const results = await stmt.bind(...clusterIds).all();

        return results.results.map((row) => ({
            id: row.id as string,
            address: row.address as string,
            publicKey: row.publicKey as string,
            tag: row.tag as string,
            metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
            createdAt: row.created_at as number,
            updatedAt: row.updated_at as number,
        }));
    }
}