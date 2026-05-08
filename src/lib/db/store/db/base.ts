// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ulid } from "ulid";
import type { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import { ALLOWED_TABLES, TABLE_ID_COLUMNS, type AllowedTable, type AllowedJsonField } from "@/lib/constants/index.js";
import { DatabaseConflictError, ResourceNotFoundError, ValidationError } from "@/lib/errors/errors.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Postgres");

/** Scalar value that can appear in a WHERE binding. */
export type WhereValue = string | number | boolean | null;

/** Pagination parameters shared by all list methods. */
export type Pagination = { limit?: number; offset?: number };

function assertAllowedTable(table: string): asserts table is AllowedTable {
  if (!(ALLOWED_TABLES as readonly string[]).includes(table)) {
    throw new ValidationError(`Disallowed table reference: ${table}`);
  }
}

export abstract class BaseStore {
  protected abstract readonly storeTable: AllowedTable;

  constructor(protected db: PostgresAdapter) {}

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
   * // Result: { theme: "light", lang: "en" }
   * ```
   */
  protected mergeJson({ existing, updates }: { existing: any; updates: any }): any {
    const existingObj = existing || {};
    const updatesObj = updates || {};
    return { ...existingObj, ...updatesObj };
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
   *   metadata: { theme: "dark" }
   * });
   * ```
   */
  protected async updateEntity({ table, id, updates }: { table: AllowedTable; id: string; updates: Record<string, any> }): Promise<void> {
    assertAllowedTable(table);
    const idColumn = TABLE_ID_COLUMNS[table];

    const fields: string[] = [];
    const values: any[] = [];
    let paramIndex = 1;

    for (const [field, value] of Object.entries(updates)) {
      if (value !== null && value !== undefined) {
        fields.push(`${field} = $${paramIndex++}`);
        values.push(value);
      }
    }

    if (fields.length === 0) return;

    fields.push(`updated_at = $${paramIndex++}`);
    values.push(Date.now(), id);

    const query = `UPDATE ${table} SET ${fields.join(", ")} WHERE ${idColumn} = $${paramIndex}`;
    await this.db
      .prepare(query)
      .bind(...values)
      .run();
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
   * // Existing metadata: { theme: "dark", lang: "en" }
   * // Updates: { theme: "light", notifications: true }
   * await this.mergeJsonField("users", "user123", "metadata", {
   *   theme: "light",
   *   notifications: true
   * });
   * // Result in DB: { theme: "light", lang: "en", notifications: true }
   * ```
   */
  protected async mergeJsonField({ table, id, field, updates }: { table: AllowedTable; id: string; field: AllowedJsonField; updates: any }): Promise<void> {
    assertAllowedTable(table);
    const idColumn = TABLE_ID_COLUMNS[table];

    const stmt = this.db.prepare(`
            UPDATE ${table} 
            SET ${field} = COALESCE(${field}, '{}'::jsonb) || $1::jsonb,
                updated_at = $2
            WHERE ${idColumn} = $3
        `);

    const result = await stmt.bind(updates, this.now(), id).run();

    if (result.meta.changes === 0) {
      throw new ResourceNotFoundError(table);
    }
  }

  /**
   * Builds a parameterized WHERE clause from a plain column→value map.
   * Keys must be DB column names (snake_case). Entries with `undefined` values
   * are ignored; pass an empty object to get an empty clause (no WHERE).
   *
   * @example
   * const { clause, bindings } = this.buildWhere({ id: 'abc', status: 'healthy' });
   * // clause  → "WHERE id = $1 AND status = $2"
   * // bindings → ['abc', 'healthy']
   */
  protected buildWhere(cols: Record<string, WhereValue | undefined>): { clause: string; bindings: WhereValue[] } {
    const entries = Object.entries(cols).filter((e): e is [string, WhereValue] => e[1] !== undefined);
    if (!entries.length) return { clause: "", bindings: [] };
    const bindings: WhereValue[] = [];
    const parts = entries.map(([col, val]) => {
      bindings.push(val);
      return `${col} = $${bindings.length}`;
    });
    return { clause: `WHERE ${parts.join(" AND ")}`, bindings };
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

  /**
   * Parses PostgreSQL error codes and throws appropriate DatabaseConflictError instances.
   * Handles unique constraint violations (23505) and foreign key violations (23503).
   *
   * @param error - The error object to parse (typically from a database operation)
   * @param table - The database table name for context in error messages
   * @throws DatabaseConflictError - For constraint violations with field and table info
   * @throws Error - For any other error types (re-thrown as-is)
   *
   * @example
   * ```typescript
   * try {
   *   await this.db.insert(...);
   * } catch (error) {
   *   this.parsePostgresError(error, "users");
   * }
   * // Throws DatabaseConflictError with field="email", table="users"
   * // for duplicate key violation
   * ```
   */
  protected parsePostgresError(error: unknown): never {
    if (error instanceof Error) {
      // Postgres unique violation
      if ((error as any).code === "23505") {
        // Extract constraint name from detail: Key (field)=(value) already exists
        const match = (error as any).detail?.match(/Key \(([^)]+)\)/);
        const field = match?.[1] ?? "unknown";
        throw new DatabaseConflictError(field, this.storeTable);
      }
      // Postgres FK violation
      if ((error as any).code === "23503") {
        throw new DatabaseConflictError("foreign_key", this.storeTable);
      }
    }
    throw error;
  }
}
