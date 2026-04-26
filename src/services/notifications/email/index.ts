// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Notifier, NotificationPayload, NotificationEvent } from "../notifier.js";
import { notificationTemplate } from "@/lib/templates/emails/notification.js";
import { EVENT_METADATA } from "@/lib/constants/events.js";
import type { Bindings } from "@/types/index.js";

export interface EmailPayload {
  name?: string | null;
  to: string;
  subject: string;
  body: string;
}

export interface EmailProvider {
  sendEmail({ name, to, subject, body }: EmailPayload): Promise<{ success: boolean; error?: string }>;
}

export class EmailService implements Notifier {
  constructor(
    private provider: EmailProvider,
    private env: Bindings,
  ) {}

  public async send({ event, data, to }: NotificationPayload): Promise<void> {
    if (!to) {
      throw new Error("Email recipient is required");
    }

    const subject = this.formatEventSubject(event as NotificationEvent);
    const body = this.formatEventBody(event as NotificationEvent, data);

    await this.provider.sendEmail({ subject, body, to });
  }

  private formatEventSubject(event: NotificationEvent): string {
    const metadata = EVENT_METADATA[event];
    return metadata?.title || "Cluster Notification";
  }

  private formatEventBody(event: NotificationEvent, data: Record<string, any>): string {
    return notificationTemplate(event, data);
  }
}

export { ZeptoProvider } from "./zepto.js";
