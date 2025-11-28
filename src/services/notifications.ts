import type { Bindings } from "@/types";
import { D1Store } from "@/lib/db/store";
import { DiscordService } from "./discord";
import { SlackService } from "./slack";
import { WebhookService } from "./webhook";
import { EmailNotificationService } from "./email-notification";
import { EVENTS, type NotificationEvent } from "./notifier";

export interface NotificationData {
  clusterId: string;
  instanceId?: string;
  userEmail?: string;
  [key: string]: any;
}

export class NotificationService {
  private discordService: DiscordService;
  private slackService: SlackService;
  private webhookService: WebhookService;
  private emailService: EmailNotificationService;

  constructor(private env: Bindings) {
    this.discordService = new DiscordService();
    this.slackService = new SlackService();
    this.webhookService = new WebhookService();
    this.emailService = new EmailNotificationService(env);
  }

  private isEventSubscribed(
    integration: { enabled: boolean; events?: NotificationEvent[] },
    event: NotificationEvent,
  ): boolean {
    if (!integration.enabled) return false;
    if (!integration.events) return true;
    return integration.events.includes(event);
  }

  async triggerEvent(event: NotificationEvent, data: NotificationData): Promise<void> {
    try {
      const d1 = new D1Store(this.env.BASE_DB);
      const integrations = await d1.clusters.listClusterIntegrations(data.clusterId);
      const cluster = await d1.clusters.get(data.clusterId);

      const promises: Promise<void>[] = [];

      // Discord notification
      if (integrations.notification?.discord?.webhookUrl && this.isEventSubscribed(integrations.notification.discord, event)) {
        promises.push(
          this.discordService.sendNotification({
            webhookUrl: integrations.notification.discord.webhookUrl,
            event,
            data,
          }).catch(err => console.error(`Discord notification failed:`, err))
        );
      }

      // Slack notification
      if (integrations.notification?.slack?.webhookUrl && this.isEventSubscribed(integrations.notification.slack, event)) {
        promises.push(
          this.slackService.sendNotification({
            webhookUrl: integrations.notification.slack.webhookUrl,
            event,
            data,
          }).catch(err => console.error(`Slack notification failed:`, err))
        );
      }

      // Custom webhook notification
      if (integrations.notification?.customWebhook?.webhookUrl && this.isEventSubscribed(integrations.notification.customWebhook, event)) {
        promises.push(
          this.webhookService.sendNotification({
            webhookUrl: integrations.notification.customWebhook.webhookUrl,
            event,
            data,
          }).catch(err => console.error(`Custom webhook notification failed:`, err))
        );
      }

      // Email notification
      if (integrations.notification?.email && this.isEventSubscribed(integrations.notification.email, event)) {
        const ownerUserId = await d1.clusters.getOwner(data.clusterId);
        if (ownerUserId) {
          const owner = await d1.users.get(ownerUserId);
          if (owner?.email) {
            promises.push(
              this.emailService.sendNotification({
                event,
                data,
                to: owner.email,
              }).catch(err => console.error(`Email notification failed:`, err))
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
