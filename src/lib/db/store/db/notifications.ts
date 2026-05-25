// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { BaseStore } from "./base.js";
import { type AllowedTable } from "@/lib/constants/index.js";

export interface NotificationsConfig {
  clusterId: string;
  enabled: boolean;
  slackWebhookUrl: string | null;
  discordWebhookUrl: string | null;
  createdAt: number;
  updatedAt: number;
}

export class NotificationsStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "notifications";

  /**
   * Fetch the notification config for a cluster. Returns null if none exists.
   */
  async get(clusterId: string): Promise<NotificationsConfig | null> {
    const row = await this.db
      .prepare(
        `SELECT cluster_id, enabled, slack_webhook_url, discord_webhook_url, created_at, updated_at
         FROM notifications WHERE cluster_id = $1`,
      )
      .bind(clusterId)
      .first();

    if (!row) return null;
    return this.toConfig(row);
  }

  /**
   * Create or fully replace a notification config for a cluster.
   */
  async upsert({
    clusterId,
    enabled,
    slackWebhookUrl,
    discordWebhookUrl,
  }: {
    clusterId: string;
    enabled: boolean;
    slackWebhookUrl?: string | null;
    discordWebhookUrl?: string | null;
  }): Promise<NotificationsConfig> {
    const now = this.now();

    const row = await this.db
      .prepare(
        `INSERT INTO notifications (cluster_id, enabled, slack_webhook_url, discord_webhook_url, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (cluster_id) DO UPDATE
           SET enabled             = EXCLUDED.enabled,
               slack_webhook_url   = EXCLUDED.slack_webhook_url,
               discord_webhook_url = EXCLUDED.discord_webhook_url,
               updated_at          = EXCLUDED.updated_at
         RETURNING cluster_id, enabled, slack_webhook_url, discord_webhook_url, created_at, updated_at`,
      )
      .bind(clusterId, enabled, slackWebhookUrl ?? null, discordWebhookUrl ?? null, now, now)
      .first();

    return this.toConfig(row);
  }

  /**
   * Delete the notification config for a cluster.
   */
  async delete(clusterId: string): Promise<void> {
    await this.db.prepare(`DELETE FROM notifications WHERE cluster_id = $1`).bind(clusterId).run();
  }

  private toConfig(row: any): NotificationsConfig {
    return {
      clusterId: row.cluster_id as string,
      enabled: row.enabled as boolean,
      slackWebhookUrl: row.slack_webhook_url as string | null,
      discordWebhookUrl: row.discord_webhook_url as string | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }
}
