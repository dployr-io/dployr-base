// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const _003_notifications = `
CREATE TABLE IF NOT EXISTS notifications (
  cluster_id          TEXT PRIMARY KEY REFERENCES clusters(id) ON DELETE CASCADE,
  enabled             BOOLEAN NOT NULL DEFAULT true,
  slack_webhook_url   TEXT,
  discord_webhook_url TEXT,
  created_at          BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
  updated_at          BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000
);
`;
