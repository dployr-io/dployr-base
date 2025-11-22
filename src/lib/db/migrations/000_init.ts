export const init = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  picture TEXT,
  metadata JSON NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  metadata JSON NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS user_clusters (
  user_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'admin', 'developer', 'viewer', 'invited')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, cluster_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS instances (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  tag TEXT NOT NULL UNIQUE,
  metadata JSON NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS bootstrap_tokens (
  instance_id TEXT PRIMARY KEY,
  nonce TEXT UNIQUE NOT NULL,
  used_at INTEGER NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_user_clusters_user ON user_clusters(user_id);
CREATE INDEX IF NOT EXISTS idx_user_clusters_org ON user_clusters(cluster_id);
CREATE INDEX IF NOT EXISTS idx_instances_org ON instances(cluster_id);
CREATE INDEX IF NOT EXISTS idx_user_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_instances_address ON instances(address);
CREATE INDEX IF NOT EXISTS idx_instances_tag ON instances(tag);
CREATE INDEX IF NOT EXISTS idx_clusters_login_id ON clusters (json_extract(metadata, '$.gitHub.loginId'));
CREATE INDEX IF NOT EXISTS idx_clusters_installation_id ON clusters (json_extract(metadata, '$.gitHub.installationId'));
CREATE INDEX IF NOT EXISTS idx_bootstrap_nonce ON bootstrap_tokens(nonce);

CREATE TRIGGER IF NOT EXISTS prevent_email_update
BEFORE UPDATE OF email ON users
BEGIN
  SELECT RAISE(ABORT, 'email is immutable');
END;

CREATE TRIGGER IF NOT EXISTS prevent_role_downgrade_to_invited
BEFORE UPDATE OF role ON user_clusters
BEGIN
  SELECT CASE 
    WHEN OLD.role != 'invited' AND NEW.role = 'invited'
    THEN RAISE(ABORT, 'cannot downgrade role back to invited')
  END;
END;

CREATE TRIGGER IF NOT EXISTS enforce_single_owner_on_insert
BEFORE INSERT ON user_clusters
WHEN NEW.role = 'owner'
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM user_clusters WHERE cluster_id = NEW.cluster_id AND role = 'owner' AND user_id != NEW.user_id) > 0
    THEN RAISE(ABORT, 'cluster can only have one owner')
  END;
END;

CREATE TRIGGER IF NOT EXISTS enforce_single_owner_on_update
BEFORE UPDATE OF role ON user_clusters
WHEN NEW.role = 'owner'
BEGIN
  SELECT CASE
    WHEN (SELECT COUNT(*) FROM user_clusters WHERE cluster_id = NEW.cluster_id AND role = 'owner' AND user_id != NEW.user_id) > 0
    THEN RAISE(ABORT, 'cluster can only have one owner')
  END;
END;
`;