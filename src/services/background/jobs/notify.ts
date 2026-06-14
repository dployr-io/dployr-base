// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import type { NotificationData } from "@/types/index.js";
import type { NotificationEvent } from "@/services/notifications/notifier.js";
import { NotificationService } from "@/services/notifications/index.js";
import { EmailService } from "@/services/notifications/email/index.js";
import { buildBindings } from "@/lib/config/bootstrap.js";


/**
 * Resolves the primary target of a notification from its payload.
 *
 * Priority order: serviceName → domain → tokenName → deploymentId → instanceId →
 * userEmail → clusterName, falling back to clusterId.
 *
 * @param data - The notification payload; at least `clusterId` must be present.
 */
export function resolveTargets(data: NotificationData): { id: string; name?: string }[] {
  if (data.serviceName)   return [{ id: data.serviceName,   name: data.serviceName }];
  if (data.domain)        return [{ id: data.domain,        name: data.domain }];
  if (data.tokenName)     return [{ id: data.tokenName,     name: data.tokenName }];
  if (data.deploymentId)  return [{ id: data.deploymentId,  name: data.deploymentId }];
  if (data.instanceId)    return [{ id: data.instanceId,    name: data.instanceId }];
  if (data.userEmail)     return [{ id: data.userEmail,     name: data.userEmail }];
  if (data.clusterName)   return [{ id: data.clusterId,     name: data.clusterName }];
  return [{ id: data.clusterId }];
}


/**
 * Returns a one-off job that fires a notification event through all integrations
 * configured for the given cluster (Discord, Slack, webhooks, email).
 *
 * @param event - The notification event code (e.g. `cluster.user_invited`).
 * @param data  - Payload for the event; `clusterId` is required to resolve integrations.
 */
export function notify(event: NotificationEvent, data: NotificationData): JobFn {
  return async (ctx) => {
    await ctx.kv.logSystemEvent({ type: event, clusterId: data.clusterId, targets: resolveTargets(data), actorId: data.actorId, actorType: data.actorType });
    const emailService = ctx.adapters.email ? new EmailService(ctx.adapters.email, buildBindings(ctx.adapters)) : null;
    const service = new NotificationService(emailService);
    await service.triggerEvent(event, data, ctx.db);
  };
}
