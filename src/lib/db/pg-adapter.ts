// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Pool, PoolClient, QueryResult, QueryResultRow } from 'pg';

/**
 * PostgreSQL database adapter 
 * This adapter wraps the pg library to provide a consistent API
 */
export class PostgresAdapter {
  private pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 20,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 2000,
    });
  }

  /**
   * Prepare a SQL statement for execution
   */
  prepare(sql: string): PreparedStatement {
    return new PreparedStatement(this.pool, sql);
  }

  /**
   * Execute multiple statements in a transaction
   */
  async batch(statements: PreparedStatement[]): Promise<QueryResult[]> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const results: QueryResult[] = [];
      
      for (const stmt of statements) {
        const result = await stmt.executeWithClient(client);
        results.push(result);
      }
      
      await client.query('COMMIT');
      return results;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Close the connection pool
   */
  async close(): Promise<void> {
    await this.pool.end();
  }
}

/**
 * Prepared statement class that mimics D1PreparedStatement interface
 */
export class PreparedStatement {
  private pool: Pool;
  private sql: string;
  private params: any[] = [];

  constructor(pool: Pool, sql: string) {
    this.pool = pool;
    this.sql = sql;
  }

  /**
   * Bind parameters to the statement
   */
  bind(...params: any[]): this {
    this.params = params;
    return this;
  }

  /**
   * Execute the statement and return all results
   */
  async all<T = QueryResultRow>(): Promise<{ results: T[]; meta: { changes?: number } }> {
    const result = await this.pool.query(this.sql, this.params);
    return {
      results: result.rows as T[],
      meta: { changes: result.rowCount || 0 }
    };
  }

  /**
   * Execute the statement and return the first result
   */
  async first<T = QueryResultRow>(): Promise<T | null> {
    const result = await this.pool.query(this.sql, this.params);
    return result.rows.length > 0 ? (result.rows[0] as T) : null;
  }

  /**
   * Execute the statement without returning results
   */
  async run(): Promise<{ meta: { changes: number } }> {
    const result = await this.pool.query(this.sql, this.params);
    return {
      meta: { changes: result.rowCount || 0 }
    };
  }

  /**
   * Execute with a specific client (used in transactions)
   */
  async executeWithClient(client: PoolClient): Promise<QueryResult> {
    return client.query(this.sql, this.params);
  }
}
