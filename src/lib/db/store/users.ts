import { User, type RequiredOnly } from "@/types";
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
        statements.push(
            this.db.prepare(`
                INSERT INTO users (id, email, name, picture, provider, metadata, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(email) DO UPDATE SET
                    name = COALESCE(excluded.name, users.name),
                    picture = COALESCE(excluded.picture, users.picture),
                    provider = excluded.provider,
                    metadata = COALESCE(excluded.metadata, users.metadata),
                    updated_at = excluded.updated_at
            `).bind(
                id,
                user.email,
                user.name || null,
                user.picture || null,
                user.provider,
                metadataJson,
                now,
                now
            )
        );

        // TODO: Optimize to avoid writing on every request, when there's no new changes (writes are expensive)
        
        // Sync metadata to admin clusters - merge new items from user metadata into cluster metadata
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

        await this.db.batch(statements);

        return this.get(user.email);
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

        // Prepare all statements for atomic execution
        const statements = [];

        // Handle metadata update atomically
        if (updates.metadata) {
            const updatesJson = JSON.stringify(updates.metadata);
            statements.push(
                this.db.prepare(`
                    UPDATE users 
                    SET metadata = json_patch(COALESCE(metadata, '{}'), ?),
                        updated_at = ?
                    WHERE email = ?
                `).bind(updatesJson, this.now(), email)
            );
        }

        // Handle other field updates
        const updateData: Record<string, any> = {};
        if (updates.name) updateData.name = updates.name;
        if (updates.picture) updateData.picture = updates.picture;
        if (updates.provider) updateData.provider = updates.provider;

        if (Object.keys(updateData).length > 0) {
            const fields: string[] = [];
            const values: any[] = [];

            for (const [field, value] of Object.entries(updateData)) {
                fields.push(`${field} = ?`);
                values.push(value);
            }

            fields.push("updated_at = ?");
            values.push(this.now(), email);

            const query = `UPDATE users SET ${fields.join(", ")} WHERE email = ?`;
            statements.push(this.db.prepare(query).bind(...values));
        }

        // Execute all updates atomically
        if (statements.length > 0) {
            await this.db.batch(statements);
        }

        return this.get(email);
    }
}