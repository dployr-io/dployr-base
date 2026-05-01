// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const _000_init = `
DO $$ BEGIN
  CREATE TYPE instance_status AS ENUM ('healthy', 'degraded', 'offline', 'unreachable', 'maintenance');
  CREATE TYPE instance_region AS ENUM ('us-east', 'us-west', 'us-central', 'eu-west', 'eu-central', 'eu-north', 'ap-south', 'ap-southeast', 'ap-northeast', 'af-south', 'me-central', 'sa-east');
  CREATE TYPE user_role AS ENUM ('owner', 'admin', 'developer', 'viewer', 'invited');
  CREATE TYPE service_type AS ENUM ('static', 'web', 'worker', 'job');
EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  picture TEXT,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  pool_instance_id TEXT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
);

CREATE TABLE IF NOT EXISTS user_clusters (
  user_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'viewer',
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  PRIMARY KEY (user_id, cluster_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL DEFAULT 'dedicated' CHECK (kind IN ('dedicated', 'pool')),
  cluster_id TEXT,
  address TEXT UNIQUE,
  tag TEXT NOT NULL UNIQUE,
  status instance_status NOT NULL DEFAULT 'healthy',
  capacity INTEGER,
  region instance_region NOT NULL DEFAULT 'us-east',
  managed BOOLEAN NOT NULL DEFAULT true,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE,
  CONSTRAINT instances_kind_cluster_check CHECK (
    (kind = 'dedicated' AND cluster_id IS NOT NULL) OR
    (kind = 'pool'      AND cluster_id IS NULL)
  )
);

DO $$ BEGIN
  ALTER TABLE clusters
    ADD CONSTRAINT clusters_pool_instance_id_fkey
    FOREIGN KEY (pool_instance_id) REFERENCES instances(id) ON DELETE SET NULL
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS bootstrap_tokens (
  instance_id TEXT PRIMARY KEY,
  nonce TEXT UNIQUE NOT NULL,
  used_at BIGINT NULL,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
);

CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  verification_token TEXT NOT NULL,
  provider TEXT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  activated_at BIGINT,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS services (
  id            TEXT PRIMARY KEY,
  cluster_id    TEXT NOT NULL,
  name          TEXT NOT NULL UNIQUE,
  type          service_type NOT NULL,
  deployment_id TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  UNIQUE(cluster_id, name),
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS deployments (
  id          TEXT PRIMARY KEY,
  cluster_id  TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  service_id  TEXT REFERENCES services(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  type        service_type NOT NULL,
  source      TEXT NOT NULL CHECK (source IN ('remote', 'image')),
  status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'success', 'failed')),
  blueprint   JSONB NOT NULL,
  logs        TEXT,
  created_at  BIGINT NOT NULL,
  finished_at BIGINT,
  UNIQUE (cluster_id, name)
);

DO $$ BEGIN
  ALTER TABLE services
    ADD CONSTRAINT services_deployment_fkey
    FOREIGN KEY (deployment_id) REFERENCES deployments(id) ON DELETE SET NULL
    NOT VALID;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS service_envs (
  id         TEXT PRIMARY KEY,
  service_id TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  key        TEXT NOT NULL,
  value      TEXT NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  UNIQUE (service_id, key)
);

CREATE TABLE IF NOT EXISTS service_secrets (
  id              TEXT PRIMARY KEY,
  service_id      TEXT NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  key             TEXT NOT NULL,
  value_encrypted BYTEA NOT NULL,
  dek_encrypted   BYTEA NOT NULL,
  created_at      BIGINT NOT NULL,
  updated_at      BIGINT NOT NULL,
  UNIQUE (service_id, key)
);

CREATE TABLE IF NOT EXISTS billing (
  cluster_id TEXT PRIMARY KEY,
  plan TEXT NOT NULL DEFAULT 'hobby' CHECK (plan IN ('hobby', 'indie', 'pro')),
  polar_customer_id TEXT,
  polar_subscription_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'canceled', 'past_due')),
  canceled_at BIGINT,
  period_end BIGINT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  updated_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_clusters_user ON user_clusters(user_id);
CREATE INDEX IF NOT EXISTS idx_user_clusters_org ON user_clusters(cluster_id);
CREATE INDEX IF NOT EXISTS idx_instances_cluster ON instances(cluster_id) WHERE cluster_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instances_kind ON instances(kind);
CREATE INDEX IF NOT EXISTS idx_instances_pool ON instances(kind) WHERE kind = 'pool';
CREATE INDEX IF NOT EXISTS idx_user_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_instances_address ON instances(address) WHERE address IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_instances_tag ON instances(tag);
CREATE INDEX IF NOT EXISTS idx_instances_unhealthy ON instances(status) WHERE status <> 'healthy';
CREATE INDEX IF NOT EXISTS idx_instances_region_kind ON instances(region, kind);
CREATE INDEX IF NOT EXISTS idx_instances_unmanaged ON instances(managed) WHERE managed = false;
CREATE INDEX IF NOT EXISTS idx_clusters_login_id ON clusters ((metadata->'gitHub'->>'loginId'));
CREATE INDEX IF NOT EXISTS idx_clusters_installation_id ON clusters ((metadata->'gitHub'->>'installationId'));
CREATE INDEX IF NOT EXISTS idx_clusters_pool_instance ON clusters(pool_instance_id) WHERE pool_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_bootstrap_nonce ON bootstrap_tokens(nonce);
CREATE INDEX IF NOT EXISTS idx_domains_instance ON domains(cluster_id);
CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
CREATE INDEX IF NOT EXISTS idx_services_instance ON services(cluster_id);
CREATE INDEX IF NOT EXISTS idx_deployments_cluster_status ON deployments(cluster_id, status);
CREATE INDEX IF NOT EXISTS idx_deployments_service ON deployments(service_id);
CREATE INDEX IF NOT EXISTS idx_service_envs_service ON service_envs(service_id);
CREATE INDEX IF NOT EXISTS idx_service_secrets_service ON service_secrets(service_id);
CREATE INDEX IF NOT EXISTS idx_billing_polar_customer ON billing(polar_customer_id);
CREATE INDEX IF NOT EXISTS idx_billing_polar_subscription ON billing(polar_subscription_id);
CREATE INDEX IF NOT EXISTS idx_billing_period_end ON billing(period_end) WHERE period_end IS NOT NULL;

CREATE OR REPLACE FUNCTION prevent_email_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.email IS DISTINCT FROM OLD.email THEN
    RAISE EXCEPTION 'email is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER prevent_email_update
BEFORE UPDATE ON users
FOR EACH ROW
EXECUTE FUNCTION prevent_email_update();

CREATE OR REPLACE FUNCTION prevent_token_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.verification_token IS DISTINCT FROM OLD.verification_token THEN
    RAISE EXCEPTION 'verification_token is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER prevent_token_update
BEFORE UPDATE ON domains
FOR EACH ROW
EXECUTE FUNCTION prevent_token_update();

CREATE OR REPLACE FUNCTION prevent_role_downgrade_to_invited()
RETURNS TRIGGER AS $$
BEGIN
  IF OLD.role != 'invited' AND NEW.role = 'invited' THEN
    RAISE EXCEPTION 'cannot downgrade role back to invited';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER prevent_role_downgrade_to_invited
BEFORE UPDATE OF role ON user_clusters
FOR EACH ROW
EXECUTE FUNCTION prevent_role_downgrade_to_invited();

CREATE OR REPLACE FUNCTION enforce_single_owner_on_insert()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'owner' THEN
    IF EXISTS (
      SELECT 1 FROM user_clusters
      WHERE cluster_id = NEW.cluster_id
        AND role = 'owner'
        AND user_id != NEW.user_id
    ) THEN
      RAISE EXCEPTION 'cluster can only have one owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER enforce_single_owner_on_insert
BEFORE INSERT ON user_clusters
FOR EACH ROW
EXECUTE FUNCTION enforce_single_owner_on_insert();

CREATE OR REPLACE FUNCTION enforce_single_owner_on_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.role = 'owner' THEN
    IF EXISTS (
      SELECT 1 FROM user_clusters
      WHERE cluster_id = NEW.cluster_id
        AND role = 'owner'
        AND user_id != NEW.user_id
    ) THEN
      RAISE EXCEPTION 'cluster can only have one owner';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER enforce_single_owner_on_update
BEFORE UPDATE OF role ON user_clusters
FOR EACH ROW
EXECUTE FUNCTION enforce_single_owner_on_update();
`;
