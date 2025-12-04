// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Notifier, NotificationPayload, NotificationEvent } from "./notifier.js";
import { EmailService } from "./email.js";
import { notificationTemplate } from "@/lib/templates/emails/notification.js";
import { EVENT_METADATA } from "./event-metadata.js";
import type { Bindings } from "@/types/index.js";

export class EmailNotificationService implements Notifier {
  constructor(private env: Bindings) {}

  async sendNotification({
    event,
    data,
    to,
  }: NotificationPayload): Promise<void> {
    if (!to) {
      throw new Error("Email recipient (to) is required");
    }

    const emailService = new EmailService({
      env: this.env,
      to,
    });

    const subject = this.formatEventSubject(event as NotificationEvent);
    const body = this.formatEventBody(event as NotificationEvent, data);

    await emailService.sendEmail(subject, body);
  }

  private formatEventSubject(event: NotificationEvent): string {
    const metadata = EVENT_METADATA[event];
    return metadata?.title || "Cluster Notification";
  }

  private formatEventBody(event: NotificationEvent, data: Record<string, any>): string {
    return notificationTemplate(event, data);
  }
}
