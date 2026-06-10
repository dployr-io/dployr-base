// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const _004_user_2fa = `
CREATE TABLE IF NOT EXISTS user_2fa (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  method              TEXT NOT NULL DEFAULT 'email' CHECK (method IN ('email', 'totp')),
  totp_secret         BYTEA,
  totp_secret_dek     BYTEA,
  backup_codes        JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at          BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
);

CREATE INDEX IF NOT EXISTS idx_user_2fa_user ON user_2fa(user_id);
`;
