// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { EVENTS } from "@/lib/constants/index.js";
import { DployrdService } from "@/services/dployrd.js";
import { NotificationService } from "@/services/notifications/index.js";
import { EmailService } from "@/services/notifications/email/index.js";
import { MS_25_DAYS, MS_30_DAYS, TTL_7_DAYS } from "@/lib/constants/duration.js";
import { ulid } from "ulid";
import { Logger } from "@/lib/logger.js";

const log = new Logger("hobby-ice-supervisor");

export const hobbyIceSupervisor: JobFn = async ({ db, kv, jwt: jwtService, adapters }) => {
  const { connectionManager } = adapters.ws;
  const dployrdService = new DployrdService();

  const emailService = adapters.email ? new EmailService(adapters.email, adapters.config as any) : null;
  const notificationService = new NotificationService(emailService);

  const { services } = await db.services.list();
  if (services.length === 0) return;

  const now = Date.now();

  for (const service of services) {
    // Only hobby-tier services
    const plan = await db.billing.getEffectivePlan(service.clusterId);
    if (plan !== "hobby") continue;

    // Already iced — nothing to do
    if (service.icedAt) continue;

    const lastActiveRaw = await kv.kv.get(KV_KEYS.SERVICE.LAST_ACTIVE(service.name));
    const lastActive = lastActiveRaw ? parseInt(lastActiveRaw, 10) : service.createdAt;
    const inactiveDuration = now - lastActive;

    if (inactiveDuration < MS_25_DAYS) continue;

    const clusterId = service.clusterId;
    const clusterName = (await db.clusters.find({ id: clusterId }))?.name ?? clusterId;

    // Day 25–29: send a one-time warning email
    if (inactiveDuration < MS_30_DAYS) {
      const warned = await kv.kv.get(KV_KEYS.SERVICE.ICE_WARNING_SENT(service.name));
      if (!warned) {
        await kv.kv.put(KV_KEYS.SERVICE.ICE_WARNING_SENT(service.name), "1", { ttl: TTL_7_DAYS });
        log.info(`${service.name}: inactive ${Math.round(inactiveDuration / 86400000)}d — sending icing warning`);

        await notificationService.triggerEvent(
          EVENTS.SERVICE.ICING_WARNING.code,
          { clusterId, clusterName, serviceName: service.name },
          db,
        );
      }
      continue;
    }

    // Day 30+: ice the service
    const routingKey = await db.instances.getRoutingKey(service.clusterId);
    if (!routingKey) {
      log.warn(`No instance for cluster ${service.clusterId}, cannot ice ${service.name}`);
      continue;
    }

    const taskId = ulid();
    const token = await jwtService.createNodeAccessToken(routingKey, {
      issuer: adapters.config.server.base_url,
      audience: "dployr-instance",
    });
    const task = dployrdService.createServiceIceTask(taskId, service.name, token);

    const sent = connectionManager.sendTask(routingKey, task);
    if (sent) {
      await db.services.markIced(service.name, now);
      log.info(`Iced hobby service ${service.name} (inactive ${Math.round(inactiveDuration / 86400000)}d)`);

      await notificationService.triggerEvent(
        EVENTS.SERVICE.ICED.code,
        { clusterId, clusterName, serviceName: service.name },
        db,
      );
    } else {
      log.warn(`No connection to instance ${routingKey} — could not ice ${service.name}`);
    }
  }
};
