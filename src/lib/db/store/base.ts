// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ulid } from "ulid";

/**
 * Base class for database stores providing common utilities and patterns.
 * 
 * This abstract class provides shared functionality for all entity stores including:
 * - JSON field merging with existing data preservation
 * - Generic entity update operations with automatic timestamps
 * - Consistent ID generation using ULID
 * - Safe database operations with proper parameter binding
 * 
 * @abstract
 * @example
 * ```typescript
 * class UserStore extends BaseStore {
 *   async update(email: string, updates: Partial<User>) {
 *     const updateData: Record<string, any> = {};
 *     if (updates.name) updateData.name = updates.name;
 *     if (updates.metadata) {
 *       updateData.metadata = await this.mergeJsonField("users", email, "metadata", updates.metadata, "email");
 *     }
 *     await this.updateEntity("users", email, updateData, "email");
 *   }
 * }
 * ```
 */
export abstract class BaseStore {
    /**
     * Creates a new BaseStore instance.
     * @param db - The Database instance to use for all operations
     */
    constructor(protected db: D1Database) { }

    /**
     * Merges existing JSON data with updates, preserving existing fields.
     * 
     * @param existing - The current JSON data (can be null/undefined)
     * @param updates - The updates to merge in
     * @returns JSON string with merged data
     * 
     * @example
     * ```typescript
     * const merged = this.mergeJson(
     *   { theme: "dark", lang: "en" }, 
     *   { theme: "light" }
     * );
     * // Result: '{"theme":"light","lang":"en"}'
     * ```
     */
    protected mergeJson(existing: any, updates: any): string {
        const existingObj = existing || {};
        const updatesObj = updates || {};
        return JSON.stringify({ ...existingObj, ...updatesObj });
    }

    /**
     * Updates an entity in the database with automatic timestamp handling.
     * Only updates fields that are not null or undefined.
     * 
     * @param table - The database table name
     * @param id - The record ID to update
     * @param updates - Object containing field updates
     * @param idColumn - The ID column name (defaults to "id")
     * 
     * @example
     * ```typescript
     * await this.updateEntity("users", "user123", {
     *   name: "John Doe",
     *   metadata: '{"theme":"dark"}'
     * });
     * ```
     */
    protected async updateEntity(
        table: string,
        id: string,
        updates: Record<string, any>,
        idColumn: string = "id"
    ): Promise<void> {
        const fields: string[] = [];
        const values: any[] = [];

        for (const [field, value] of Object.entries(updates)) {
            if (value !== null && value !== undefined) {
                fields.push(`${field} = ?`);
                values.push(value);
            }
        }

        if (fields.length === 0) return;

        fields.push("updated_at = ?");
        values.push(Date.now(), id);

        const query = `UPDATE ${table} SET ${fields.join(", ")} WHERE ${idColumn} = ?`;
        await this.db.prepare(query).bind(...values).run();
    }

    /**
     * Atomically merges updates into an existing JSON field in the database.
     * Uses SQL JSON functions to perform the merge operation atomically.
     * 
     * @param table - The database table name
     * @param id - The record ID
     * @param field - The JSON field name to merge
     * @param updates - The updates to merge into the existing JSON
     * @param idColumn - The ID column name (defaults to "id")
     * @throws Error if the record is not found
     * 
     * @example
     * ```typescript
     * // Existing metadata: {"theme":"dark","lang":"en"}
     * // Updates: {"theme":"light","notifications":true}
     * await this.mergeJsonField("users", "user123", "metadata", {
     *   theme: "light",
     *   notifications: true
     * });
     * // Result in DB: {"theme":"light","lang":"en","notifications":true}
     * ```
     */
    protected async mergeJsonField(
        table: string,
        id: string,
        field: string,
        updates: any,
        idColumn: string = "id"
    ): Promise<void> {
        const updatesJson = JSON.stringify(updates);

        // Use json_patch to atomically merge the updates
        const stmt = this.db.prepare(`
            UPDATE ${table} 
            SET ${field} = json_patch(COALESCE(${field}, '{}'), ?),
                updated_at = ?
            WHERE ${idColumn} = ?
        `);

        const result = await stmt.bind(updatesJson, this.now(), id).run();

        if (result.meta.changes === 0) {
            throw new Error(`Record not found in ${table}`);
        }
    }

    /**
     * Generates a new ULID for use as a record ID.
     * ULIDs are lexicographically sortable and URL-safe.
     * 
     * @returns A new ULID string
     * 
     * @example
     * ```typescript
     * const id = this.generateId(); // "01ARZ3NDEKTSV4RRFFQ69G5FAV"
     * ```
     */
    protected generateId(): string {
        return ulid();
    }

    /**
     * Gets the current timestamp as milliseconds since epoch.
     * Used for created_at and updated_at fields.
     * 
     * @returns Current timestamp in milliseconds
     * 
     * @example
     * ```typescript
     * const timestamp = this.now(); // 1640995200000
     * ```
     */
    protected now(): number {
        return Date.now();
    }
}