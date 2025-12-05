// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// Auto-import all migrations
import * as migrations from '@/lib/db/migrations/index.js';
import type { PostgresAdapter } from './pg-adapter.js';

const MIGRATION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS _migrations (
  filename TEXT PRIMARY KEY,
  applied_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);
`;

async function getAppliedMigrations(db: PostgresAdapter): Promise<Set<string>> {
  try {
    const result = await db.prepare("SELECT filename FROM _migrations").all();
    return new Set(result.results.map((row: any) => row.filename));
  } catch (error) {
    return new Set();
  }
}

// Auto-discover migrations from the migrations module
function getMigrations(): Record<string, string> {
  const migrationMap: Record<string, string> = {};

  for (const [key, value] of Object.entries(migrations)) {
    if (typeof value === 'string') {
      // Use the export name as filename with .sql extension
      const filename = `${key}.sql`;
      migrationMap[filename] = value;
    }
  }

  return migrationMap;
}

async function applyMigration(db: PostgresAdapter, filename: string, sql: string): Promise<void> {
  console.log(`Applying migration: ${filename}`);

  // Check if already applied
  try {
    const existing = await db.prepare("SELECT filename FROM _migrations WHERE filename = $1")
      .bind(filename)
      .first();

    if (existing) {
      console.log(`Migration ${filename} already applied, skipping`);
      return;
    }
  } catch (e) {
    // Continue
  }

  // Split SQL statements by semicolon (PostgreSQL handles triggers differently)
  const statements = sql.split(';').filter(s => s.trim());

  for (const statement of statements) {
      const trimmed = statement.trim();
      if (trimmed) {
        try {
          await db.prepare(trimmed + ';').run();
        } catch (error) {
          console.error(`Failed statement: ${trimmed}`);
          throw error;
        }
      }
    }

  await db.prepare("INSERT INTO _migrations (filename) VALUES ($1) ON CONFLICT (filename) DO NOTHING")
    .bind(filename)
    .run();

  console.log(`Migration ${filename} applied successfully`);
}

export async function runMigrations(db: PostgresAdapter): Promise<void> {
  console.log("Starting database migrations...");

  await db.prepare(MIGRATION_TABLE_DDL).run();

  const appliedMigrations = await getAppliedMigrations(db);
  const discoveredMigrations = getMigrations();
  const migrationFiles = Object.keys(discoveredMigrations).sort();

  console.log(`Found ${migrationFiles.length} migration(s): ${migrationFiles.join(', ')}`);

  for (const filename of migrationFiles) {
    if (!appliedMigrations.has(filename)) {
      await applyMigration(db, filename, discoveredMigrations[filename]);
    } else {
      console.log(`Migration ${filename} already applied, skipping`);
    }
  }

  console.log("Database migrations completed successfully");
}

export const initializeDatabase = runMigrations;