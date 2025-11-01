import { User } from "@/types";
import { BaseStore } from "./base";

export class UserStore extends BaseStore {
    async save(user: User): Promise<void> {
        const stmt = this.db.prepare(`
      INSERT INTO users (id, email, name, provider, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(email) DO UPDATE SET
        name = excluded.name,
        provider = excluded.provider,
        metadata = COALESCE(excluded.metadata, users.metadata),
        updated_at = excluded.updated_at
    `);

        const now = this.now();
        await stmt.bind(
            user.id,
            user.email,
            user.name,
            user.provider,
            JSON.stringify(user.metadata || {}),
            now,
            now
        ).run();
    }

    async get(email: string): Promise<User | null> {
        const stmt = this.db.prepare(`
      SELECT id, email, name, provider, metadata, created_at, updated_at 
      FROM users WHERE email = ?
    `);

        const result = await stmt.bind(email).first();
        if (!result) return null;

        return {
            ...result,
            metadata: result.metadata ? JSON.parse(result.metadata as string) : {},
        } as User;
    }

    async update(
        email: string,
        updates: Partial<Omit<User, "id" | "email" | "createdAt">>
    ): Promise<User | null> {
        if (!updates.name && !updates.provider && !updates.metadata) {
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