import { Bootstrap, BootstrapType } from "@/types";
import { BaseStore } from "./base";

export class BootstrapStore extends BaseStore {
  async create(id: number): Promise<Bootstrap> {
    const now = this.now();
    const type = "github";

    const stmt = this.db.prepare(`
      INSERT INTO bootstraps (id, type, created_at)
      VALUES (?, ?, ?)
    `);

    try {
      await stmt.bind(id, type, now).run();
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "message" in error &&
        (error.message as string).includes("UNIQUE constraint failed")
      ) {
        const existing = await this.get(id);
        if (!existing) {
          throw new Error("Failed to retrieve existing installation");
        }
        return existing;
      }
      throw error;
    }

    return {
      id,
      type,
      createdAt: now,
    };
  }

  async get(id: number): Promise<Bootstrap | null> {
    const stmt = this.db.prepare(`
      SELECT id, type, created_at
      FROM bootstraps WHERE id = ?
    `);

    const result = await stmt.bind(id).first();
    if (!result) return null;

    return {
      id: result.id as number,
      type: result.type as BootstrapType,
      createdAt: result.created_at as number,
    };
  }
}
