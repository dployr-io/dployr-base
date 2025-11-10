export const init = `CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  provider TEXT NOT NULL,
  picture TEXT,
  metadata JSON NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE bootstraps (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE clusters (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  bootstrap_id INTEGER,
  metadata JSON NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (bootstrap_id) REFERENCES bootstraps(id) ON DELETE SET NULL
);

CREATE TABLE user_clusters (
  user_id TEXT NOT NULL,
  cluster_id TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('owner', 'admin', 'developer', 'viewer')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  PRIMARY KEY (user_id, cluster_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE TABLE instances (
  id TEXT PRIMARY KEY,
  cluster_id TEXT NOT NULL,
  address TEXT NOT NULL UNIQUE,
  tag TEXT NOT NULL UNIQUE,
  public_key TEXT,
  metadata JSON NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (cluster_id) REFERENCES clusters(id) ON DELETE CASCADE
);

CREATE INDEX idx_user_clusters_user ON user_clusters(user_id);
CREATE INDEX idx_user_clusters_org ON user_clusters(cluster_id);
CREATE INDEX idx_instances_org ON instances(cluster_id);
CREATE INDEX idx_user_email ON users(email);
CREATE INDEX idx_instances_address ON instances(address);
CREATE INDEX idx_instances_tag ON instances(tag);
CREATE INDEX idx_clusters_github_installation ON clusters(bootstrap_id);`;