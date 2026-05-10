// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import type { NotificationData } from "@/types/index.js";
import type { NotificationEvent } from "@/services/notifications/notifier.js";
import { NotificationService } from "@/services/notifications/index.js";
import { EmailService } from "@/services/notifications/email/index.js";
import { buildBindings } from "@/lib/config/bootstrap.js";

/**
 * Returns a one-off job that fires a notification event through all integrations
 * configured for the given cluster (Discord, Slack, webhooks, email).
 *
 * @param event - The notification event code (e.g. `cluster.user_invited`).
 * @param data  - Payload for the event; `clusterId` is required to resolve integrations.
 */
export function notify(event: NotificationEvent, data: NotificationData): JobFn {
  return async (ctx) => {
    const emailService = ctx.adapters.email ? new EmailService(ctx.adapters.email, buildBindings(ctx.adapters)) : null;
    const service = new NotificationService(emailService);
    await service.triggerEvent(event, data, ctx.db);
  };
}
