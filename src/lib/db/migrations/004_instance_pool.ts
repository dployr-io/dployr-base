// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const _004_instance_pool = `
CREATE TABLE IF NOT EXISTS instance_pool (
  id TEXT PRIMARY KEY,
  address TEXT NOT NULL UNIQUE,
  tag TEXT NOT NULL UNIQUE,
  capacity INTEGER NOT NULL DEFAULT 10,
  region TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

ALTER TABLE clusters ADD COLUMN IF NOT EXISTS pool_instance_id TEXT REFERENCES instance_pool(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_instance_pool_status ON instance_pool(status);
CREATE INDEX IF NOT EXISTS idx_clusters_pool_instance ON clusters(pool_instance_id) WHERE pool_instance_id IS NOT NULL;
`;
