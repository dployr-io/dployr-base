// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { KV_KEYS } from "@/lib/constants/kv.js";
import { DployrdService } from "@/services/dployrd.js";
import { JWTService } from "@/services/auth/jwt.js";
import { MS_30_MINUTES } from "@/lib/constants/duration.js";
import { ulid } from "ulid";
import { Logger } from "@/lib/logger.js";

// Thresholds for the bot-detection algorithm.
// A service is considered genuinely idle only when ALL three signals are bot-like.
const BOT_MAX_SUBNETS = 3;   // fewer than this unique /24s → single-source
const BOT_MAX_CV      = 0.2; // cadence coefficient of variation below this → metronomic
const BOT_MAX_PATHS   = 2;   // fewer than this unique paths → single-endpoint ping

const log = new Logger("hobby-sleep-supervisor");

type TrafficSignal = {
  domain: string;
  request_count: number;
  unique_subnets: number;
  cadence_cv: number;
  unique_paths: number;
  last_request_at: number; // Unix ms, 0 = no traffic
};

/**
 * Returns true when traffic signals suggest the service is genuinely idle —
 * i.e. all three bot-detection criteria are met simultaneously.
 *
 * Any single human-like signal keeps the service awake.
 */
function isGenuinelyIdle(sig: TrafficSignal): boolean {
  // No traffic at all in the last hour — could be idle, but we defer to
  // last_active timestamp check; don't override it here.
  if (sig.request_count === 0) return true;

  const subnetBot  = sig.unique_subnets < BOT_MAX_SUBNETS;
  const cadenceBot = sig.cadence_cv     < BOT_MAX_CV;
  const pathBot    = sig.unique_paths   < BOT_MAX_PATHS;

  // Human traffic: any one signal is human-like → keep alive
  if (!subnetBot || !cadenceBot || !pathBot) return false;

  return true;
}

export const hobbySleepSupervisor: JobFn = async ({ db, kv, adapters }) => {
  const { connectionManager } = adapters.ws;
  const jwtService = new JWTService(kv);
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

    // Service must have been inactive for at least 30 minutes before we
    // even evaluate traffic signals — fast path for recently active services.
    const lastActiveRaw = await kv.kv.get(KV_KEYS.SERVICE.LAST_ACTIVE(service.name));
    const lastActive    = lastActiveRaw ? parseInt(lastActiveRaw, 10) : service.createdAt;
    if (now - lastActive < MS_30_MINUTES) continue;

    // Read the traffic entity reported by the node for this cluster's instance.
    const routingKey = await db.instances.getRoutingKey(service.clusterId);
    if (!routingKey) {
      log.warn(`No instance found for cluster ${service.clusterId}, skipping sleep for ${service.name}`);
      continue;
    }

    const trafficEntity = await kv.entities.getEntity<TrafficSignal[]>(
      KV_KEYS.INSTANCE.ENTITY(routingKey, "traffic"),
    );

    if (trafficEntity?.data) {
      // Match by service name substring — domain is typically {name}.{tld}
      const sig = trafficEntity.data.find((s) => s.domain.startsWith(service.name + "."));

      if (sig && !isGenuinelyIdle(sig)) {
        // Traffic signals indicate real human activity — update last_active and skip.
        if (sig.last_request_at > 0) {
          await kv.kv.put(KV_KEYS.SERVICE.LAST_ACTIVE(service.name), String(sig.last_request_at));
        }
        log.debug(`${service.name}: human-like traffic detected (subnets=${sig.unique_subnets} cv=${sig.cadence_cv.toFixed(2)} paths=${sig.unique_paths}), skipping sleep`);
        continue;
      }

      if (sig) {
        log.debug(`${service.name}: bot-like traffic pattern (subnets=${sig.unique_subnets} cv=${sig.cadence_cv.toFixed(2)} paths=${sig.unique_paths}), proceeding to sleep`);
      }
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
