// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { NotificationData } from "@/types/index.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { EmailService } from "./email/index.js";
import { type NotificationEvent } from "./notifier.js";
import { DiscordService } from "../integrations/discord.js";
import { SlackService } from "../integrations/slack.js";
import { WebhookService } from "../integrations/webhook.js";
import { Logger } from "@/lib/logger.js";
import { EVENTS } from "@/lib/constants/index.js";
import {
  inviteEmail,
  memberJoinedEmail,
  sessionAlertEmail,
  instanceCreatedEmail,
  instanceUpdatedEmail,
  instanceDeletedEmail,
  userRemovedEmail,
  roleChangedEmail,
  serviceUnhealthyEmail,
} from "@/lib/templates/emails/index.js";

const log = new Logger("NotificationService");

/**
 * Maps a notification event to a rendered { subject, html } pair.
 * Returns null if the event has no email template (no email is sent).
 *
 * Add a case here whenever a new event should trigger an email.
 */
function buildEmail(event: NotificationEvent, data: NotificationData): { subject: string; html: string } | null {
  const clusterName = data.clusterName ?? data.clusterId;

  switch (event) {
    case EVENTS.CLUSTER.USER_INVITED.code:
      return inviteEmail({ clusterName, clusterId: data.clusterId });

    case EVENTS.CLUSTER.INVITE_ACCEPTED.code:
      if (!data.userEmail) return null;
      return memberJoinedEmail({ memberEmail: data.userEmail, clusterName, clusterId: data.clusterId });

    case EVENTS.AUTH.SESSION_CREATED.code:
      if (!data.userEmail) return null;
      return sessionAlertEmail({ userEmail: data.userEmail, clusterName, clusterId: data.clusterId, ipAddress: data.ipAddress });

    case EVENTS.INSTANCE.CREATED.code:
      if (!data.instanceId) return null;
      return instanceCreatedEmail({ instanceId: data.instanceId, clusterName, clusterId: data.clusterId });

    case EVENTS.INSTANCE.UPDATED.code:
      if (!data.instanceId) return null;
      return instanceUpdatedEmail({ instanceId: data.instanceId, clusterName, clusterId: data.clusterId });

    case EVENTS.INSTANCE.DELETED.code:
      if (!data.instanceId) return null;
      return instanceDeletedEmail({ instanceId: data.instanceId, clusterName, clusterId: data.clusterId });

    case EVENTS.CLUSTER.REMOVED_USER.code:
      if (!data.userEmail) return null;
      return userRemovedEmail({ memberEmail: data.userEmail, clusterName, clusterId: data.clusterId });

    case EVENTS.CLUSTER.USER_ROLE_CHANGED.code:
      if (!data.userEmail || !data.oldRole || !data.newRole) return null;
      return roleChangedEmail({ memberEmail: data.userEmail, oldRole: data.oldRole, newRole: data.newRole, clusterName, clusterId: data.clusterId });

    case EVENTS.SERVICE.UNHEALTHY.code:
      if (!data.serviceName) return null;
      return serviceUnhealthyEmail({ serviceName: data.serviceName, clusterName, clusterId: data.clusterId });

    default:
      return null;
  }
}

export class NotificationService {
  private discordService: DiscordService;
  private slackService: SlackService;
  private webhookService: WebhookService;
  private emailService: EmailService | null;

  constructor(emailService: EmailService | null) {
    this.discordService = new DiscordService();
    this.slackService = new SlackService();
    this.webhookService = new WebhookService();
    this.emailService = emailService;
  }

  private isEventSubscribed(integration: { enabled: boolean; events?: NotificationEvent[] }, event: NotificationEvent): boolean {
    if (!integration.enabled) return false;
    if (!integration.events) return true;
    return integration.events.includes(event);
  }

  async triggerEvent(event: NotificationEvent, data: NotificationData, db: DatabaseStore): Promise<void> {
    try {
      const integrations = await db.clusters.listClusterIntegrations(data.clusterId);

      const promises: Promise<void>[] = [];

      // Discord notification
      if (integrations.notification?.discord?.webhookUrl && this.isEventSubscribed(integrations.notification.discord, event)) {
        promises.push(
          this.discordService
            .send({ webhookUrl: integrations.notification.discord.webhookUrl, event, data })
            .catch((err) => log.error(`Discord notification failed:`, { error: err instanceof Error ? err.message : String(err) })),
        );
      }

      // Slack notification
      if (integrations.notification?.slack?.webhookUrl && this.isEventSubscribed(integrations.notification.slack, event)) {
        promises.push(
          this.slackService
            .send({ webhookUrl: integrations.notification.slack.webhookUrl, event, data })
            .catch((err) => log.error(`Slack notification failed:`, { error: err instanceof Error ? err.message : String(err) })),
        );
      }

      // Custom webhook notification
      if (integrations.notification?.customWebhook?.webhookUrl && this.isEventSubscribed(integrations.notification.customWebhook, event)) {
        promises.push(
          this.webhookService
            .send({ webhookUrl: integrations.notification.customWebhook.webhookUrl, event, data })
            .catch((err) => log.error(`Custom webhook notification failed:`, { error: err instanceof Error ? err.message : String(err) })),
        );
      }

      // Email notification
      if (this.emailService && integrations.notification?.email && this.isEventSubscribed(integrations.notification.email, event)) {
        const email = buildEmail(event, data);

        if (email) {
          // Use the explicit recipient; fall back to cluster owner for owner-targeted events.
          let recipient: string | undefined = data.to;
          if (!recipient) {
            const ownerUserId = await db.clusters.getOwner(data.clusterId);
            if (ownerUserId) {
              const owner = await db.users.find({ id: ownerUserId });
              recipient = owner?.email;
            }
          }

          if (recipient) {
            const { subject, html } = email;
            promises.push(
              this.emailService
                .send(recipient, () => ({ subject, html }), {})
                .catch((err) => log.error(`Email notification failed:`, { error: err instanceof Error ? err.message : String(err) })),
            );
          }
        }
      }

      await Promise.allSettled(promises);
    } catch (error) {
      log.error(`Failed to trigger notifications for event ${event}:`, { error: error instanceof Error ? error.message : String(error) });
    }
  }
}
