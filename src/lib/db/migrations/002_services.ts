// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const services = `
CREATE TABLE IF NOT EXISTS services (
  id TEXT PRIMARY KEY,
  instance_id TEXT NOT NULL,
  name TEXT NOT NULL UNIQUE,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_services_instance ON services(instance_id);
`;