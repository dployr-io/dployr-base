// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings, NotificationData } from "@/types/index.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { EmailNotifierService } from "./email/email-notifier.js";
import { type NotificationEvent } from "./notifier.js";
import { DiscordService } from "../integrations/discord.js";
import { SlackService } from "../integrations/slack.js";
import { WebhookService } from "../integrations/webhook.js";

export class NotificationService {
  private discordService: DiscordService;
  private slackService: SlackService;
  private webhookService: WebhookService;
  private emailService: EmailNotifierService;

  constructor(private env: Bindings) {
    this.discordService = new DiscordService();
    this.slackService = new SlackService();
    this.webhookService = new WebhookService();
    this.emailService = new EmailNotifierService(env);
  }

  private isEventSubscribed(integration: { enabled: boolean; events?: NotificationEvent[] }, event: NotificationEvent): boolean {
    if (!integration.enabled) return false;
    if (!integration.events) return true;
    return integration.events.includes(event);
  }

  async triggerEvent(event: NotificationEvent, data: NotificationData, d1: DatabaseStore): Promise<void> {
    try {
      const integrations = await d1.clusters.listClusterIntegrations(data.clusterId);
      const cluster = await d1.clusters.get(data.clusterId);

      const promises: Promise<void>[] = [];

      // Discord notification
      if (integrations.notification?.discord?.webhookUrl && this.isEventSubscribed(integrations.notification.discord, event)) {
        promises.push(
          this.discordService
            .sendNotification({
              webhookUrl: integrations.notification.discord.webhookUrl,
              event,
              data,
            })
            .catch((err) => console.error(`Discord notification failed:`, err)),
        );
      }

      // Slack notification
      if (integrations.notification?.slack?.webhookUrl && this.isEventSubscribed(integrations.notification.slack, event)) {
        promises.push(
          this.slackService
            .sendNotification({
              webhookUrl: integrations.notification.slack.webhookUrl,
              event,
              data,
            })
            .catch((err) => console.error(`Slack notification failed:`, err)),
        );
      }

      // Custom webhook notification
      if (integrations.notification?.customWebhook?.webhookUrl && this.isEventSubscribed(integrations.notification.customWebhook, event)) {
        promises.push(
          this.webhookService
            .sendNotification({
              webhookUrl: integrations.notification.customWebhook.webhookUrl,
              event,
              data,
            })
            .catch((err) => console.error(`Custom webhook notification failed:`, err)),
        );
      }

      // Email notification
      if (integrations.notification?.email && this.isEventSubscribed(integrations.notification.email, event)) {
        const ownerUserId = await d1.clusters.getOwner(data.clusterId);
        if (ownerUserId) {
          const owner = await d1.users.find({ id: ownerUserId });
          if (owner?.email) {
            promises.push(
              this.emailService
                .sendNotification({
                  event,
                  data,
                  to: owner.email,
                })
                .catch((err) => console.error(`Email notification failed:`, err)),
            );
          }
        }
      }

      await Promise.allSettled(promises);
    } catch (error) {
      console.error(`Failed to trigger notifications for event ${event}:`, error);
    }
  }
}
