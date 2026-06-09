// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const _001_oidc_bindings = `
CREATE TABLE IF NOT EXISTS oidc_bindings (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cluster_id  TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  provider    TEXT NOT NULL CHECK (provider IN ('github', 'gitlab', 'bitbucket')),
  issuer      TEXT NOT NULL,
  subject     TEXT NOT NULL,
  name        TEXT,
  created_at  BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  UNIQUE(issuer, subject)
);
CREATE INDEX IF NOT EXISTS idx_oidc_bindings_user   ON oidc_bindings(user_id);
CREATE INDEX IF NOT EXISTS idx_oidc_bindings_lookup ON oidc_bindings(issuer, subject);
`;
