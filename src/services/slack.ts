// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Notifier, NotificationPayload, NotificationEvent } from "./notifier.js";
import { EVENT_METADATA } from "@/lib/constants/event-metadata.js";

export class SlackService implements Notifier {
  async sendNotification({
    webhookUrl,
    event,
    data,
  }: NotificationPayload): Promise<void> {
    if (!webhookUrl) {
      throw new Error("Slack webhook URL is required");
    }

    const message = {
      text: this.formatEventTitle(event),
      blocks: [
        {
          type: "header",
          text: {
            type: "plain_text",
            text: this.formatEventTitle(event),
          },
        },
        {
          type: "section",
          text: {
            type: "mrkdwn",
            text: this.formatEventDescription(event, data),
          },
        },
        {
          type: "section",
          fields: this.formatEventFields(data),
        },
        {
          type: "context",
          elements: [
            {
              type: "mrkdwn",
              text: `_${new Date().toISOString()}_`,
            },
          ],
        },
      ],
    };

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(message),
    });
  }

  private formatEventTitle(event: NotificationEvent): string {
    const metadata = EVENT_METADATA[event];
    return metadata?.title || "📢 Event Notification";
  }

  private formatEventDescription(event: NotificationEvent, data: Record<string, any>): string {
    const metadata = EVENT_METADATA[event];
    const description = metadata?.description(data) || "An event occurred in your cluster.";
    return description.replace(/\*\*/g, "*");
  }

  private formatEventFields(data: Record<string, any>): Array<{ type: string; text: string }> {
    const fields: Array<{ type: string; text: string }> = [];

    if (data.instanceId) {
      fields.push({ type: "mrkdwn", text: `*Instance ID:*\n${data.instanceId}` });
    }
    if (data.clusterId) {
      fields.push({ type: "mrkdwn", text: `*Cluster ID:*\n${data.clusterId}` });
    }
    if (data.userEmail) {
      fields.push({ type: "mrkdwn", text: `*User:*\n${data.userEmail}` });
    }

    return fields;
  }
}
