// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const domains = `
CREATE TABLE IF NOT EXISTS domains (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  domain TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'active')),
  verification_token TEXT NOT NULL,
  provider TEXT,
  created_at BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  activated_at BIGINT,
  FOREIGN KEY (instance_id) REFERENCES instances(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_domains_instance ON domains(instance_id);
CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);

-- Prevent token modification after creation
CREATE OR REPLACE FUNCTION prevent_token_update()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.verification_token IS DISTINCT FROM OLD.verification_token THEN
    RAISE EXCEPTION 'verification_token is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER prevent_token_update
BEFORE UPDATE ON domains
FOR EACH ROW
EXECUTE FUNCTION prevent_token_update();
`;
