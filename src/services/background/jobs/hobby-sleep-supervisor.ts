// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { DployrdService } from "@/services/dployrd.js";
import { MS_30_MINUTES } from "@/lib/constants/duration.js";
import { ulid } from "ulid";
import { Logger } from "@/lib/logger.js";

const log = new Logger("hobby-sleep-supervisor");

export const hobbySleepSupervisor: JobFn = async ({ db, kv, jwt: jwtService, adapters }) => {
  const { connectionManager } = adapters.ws;
  const dployrdService = new DployrdService();

  const { services } = await db.services.list();
  if (services.length === 0) return;

  const now = Date.now();

  for (const service of services) {
    // Only sleep hobby-tier services
    const plan = await db.billing.getEffectivePlan(service.clusterId);
    if (plan !== "hobby") continue;

    // Skip if already sleeping or waking
    if (await kv.kv.get(KV_KEYS.SERVICE.SLEEPING(service.name))) continue;

    const lastActiveRaw = await kv.kv.get(KV_KEYS.SERVICE.LAST_ACTIVE(service.name));
    const lastActive    = lastActiveRaw ? parseInt(lastActiveRaw, 10) : service.createdAt;
    if (now - lastActive < MS_30_MINUTES) continue;

    const routingKey = await db.instances.getRoutingKey(service.clusterId);
    if (!routingKey) {
      log.warn(`No instance found for cluster ${service.clusterId}, skipping sleep for ${service.name}`);
      continue;
    }

    const taskId = ulid();
    const token  = await jwtService.createNodeAccessToken(routingKey, {
      issuer:   adapters.config.server.base_url,
      audience: "dployr-instance",
    });
    const task = dployrdService.createServiceSleepTask(taskId, service.name, token);

    const sent = connectionManager.sendTask(routingKey, task);
    if (sent) {
      await kv.kv.put(KV_KEYS.SERVICE.SLEEPING(service.name), "1");
      log.info(`Sleeping idle hobby service ${service.name} (inactive ${Math.round((now - lastActive) / 60000)}m)`);
    } else {
      log.warn(`No connection to instance ${routingKey} — could not sleep ${service.name}`);
    }
  }
};
