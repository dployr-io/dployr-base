// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Notifier, NotificationPayload, NotificationEvent } from "./notifier.js";
import { EVENT_METADATA } from "../lib/constants/event-metadata.js";

export class DiscordService implements Notifier {
  async sendNotification({
    webhookUrl,
    event,
    data,
  }: NotificationPayload): Promise<void> {
    if (!webhookUrl) {
      throw new Error("Discord webhook URL is required");
    }

    const embed = {
      title: this.formatEventTitle(event),
      description: this.formatEventDescription(event, data),
      color: this.getEventColor(event),
      timestamp: new Date().toISOString(),
      fields: this.formatEventFields(data),
    };

    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ embeds: [embed] }),
    });
  }

  private formatEventTitle(event: NotificationEvent): string {
    const metadata = EVENT_METADATA[event];
    return metadata?.title || "📢 Event Notification";
  }

  private formatEventDescription(event: NotificationEvent, data: Record<string, any>): string {
    const metadata = EVENT_METADATA[event];
    return metadata?.description(data) || "An event occurred in your cluster.";
  }

  private getEventColor(event: NotificationEvent): number {
    const metadata = EVENT_METADATA[event];
    return metadata?.color || 0x808080;
  }

  private formatEventFields(data: Record<string, any>): Array<{ name: string; value: string; inline?: boolean }> {
    const fields: Array<{ name: string; value: string; inline?: boolean }> = [];

    if (data.instanceId) {
      fields.push({ name: "Instance ID", value: String(data.instanceId), inline: true });
    }
    if (data.clusterId) {
      fields.push({ name: "Cluster ID", value: String(data.clusterId), inline: true });
    }
    if (data.userEmail) {
      fields.push({ name: "User", value: String(data.userEmail), inline: true });
    }

    return fields;
  }
}
