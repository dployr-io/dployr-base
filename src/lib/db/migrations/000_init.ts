// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const init = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  picture TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE TABLE IF NOT EXISTS user_clusters (
  user_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'admin', 'developer', 'viewer', 'invited')),
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  PRIMARY KEY (user_id, cluster_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  tag TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bootstrap_tokens (
  instance_id TEXT PRIMARY KEY,
  nonce TEXT UNIQUE NOT NULL,
  used_at BIGINT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT
);

CREATE INDEX IF NOT EXISTS idx_user_clusters_user ON user_clusters(user_id);
CREATE INDEX IF NOT EXISTS idx_user_clusters_org ON user_clusters(cluster_id);
CREATE INDEX IF NOT EXISTS idx_instances_org ON instances(cluster_id);
CREATE INDEX IF NOT EXISTS idx_user_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_instances_address ON instances(address);
CREATE INDEX IF NOT EXISTS idx_instances_tag ON instances(tag);
CREATE INDEX IF NOT EXISTS idx_clusters_login_id ON clusters ((metadata->'gitHub'->>'loginId'));
CREATE INDEX IF NOT EXISTS idx_clusters_installation_id ON clusters ((metadata->'gitHub'->>'installationId'));
CREATE INDEX IF NOT EXISTS idx_bootstrap_nonce ON bootstrap_tokens(nonce);

CREATE OR REPLACE FUNCTION prevent_email_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'email is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_email_update
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION prevent_email_update();

CREATE OR REPLACE FUNCTION prevent_role_downgrade_to_invited()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role != 'invited' AND NEW.role = 'invited' THEN
    RAISE EXCEPTION 'cannot downgrade role back to invited';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_role_downgrade_to_invited
BEFORE UPDATE OF role ON user_clusters
FOR EACH ROW
EXECUTE FUNCTION prevent_role_downgrade_to_invited();

CREATE OR REPLACE FUNCTION enforce_single_owner_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'owner' THEN
    IF EXISTS (SELECT 1 FROM user_clusters WHERE cluster_id = NEW.cluster_id AND role = 'owner' AND user_id != NEW.user_id) THEN
      RAISE EXCEPTION 'cluster can only have one owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_single_owner_on_insert
BEFORE INSERT ON user_clusters
FOR EACH ROW
EXECUTE FUNCTION enforce_single_owner_on_insert();

CREATE OR REPLACE FUNCTION enforce_single_owner_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'owner' THEN
    IF EXISTS (SELECT 1 FROM user_clusters WHERE cluster_id = NEW.cluster_id AND role = 'owner' AND user_id != NEW.user_id) THEN
      RAISE EXCEPTION 'cluster can only have one owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER enforce_single_owner_on_update
BEFORE UPDATE OF role ON user_clusters
FOR EACH ROW
EXECUTE FUNCTION enforce_single_owner_on_update();
`;