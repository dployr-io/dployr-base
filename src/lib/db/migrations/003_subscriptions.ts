// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const subscriptions = `
CREATE TABLE IF NOT EXISTS cluster_subscriptions (
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

CREATE INDEX IF NOT EXISTS idx_cluster_subscriptions_polar_customer ON cluster_subscriptions(polar_customer_id);
CREATE INDEX IF NOT EXISTS idx_cluster_subscriptions_polar_subscription ON cluster_subscriptions(polar_subscription_id);
CREATE INDEX IF NOT EXISTS idx_cluster_subscriptions_period_end ON cluster_subscriptions(period_end) WHERE period_end IS NOT NULL;
`;