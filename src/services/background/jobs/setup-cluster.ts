// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { DployrdService } from "@/services/dployrd.js";
import { CLUSTER_LIMITS_BY_TIER } from "@/lib/constants/instances.js";
import { Logger } from "@/lib/logger.js";
import { ulid } from "ulid";

const log = new Logger("setup-cluster");

/**
 * Sends a setup_cluster task to the pool node so it creates the cgroup slice
 * immediately after a cluster is first assigned, before any deploy runs.
 */
export function setupCluster(clusterId: string): JobFn {
  return async ({ db, jwt, adapters }) => {
    const plan = await db.billing.getEffectivePlan(clusterId);
    const limits = CLUSTER_LIMITS_BY_TIER[plan];
    if (!limits) return;

    const routingKey = await db.instances.getRoutingKey(clusterId);
    const token = await jwt.createInstanceAccessToken(undefined, routingKey, clusterId);
    const task = new DployrdService().createSetupClusterTask(ulid(), clusterId, limits.clusterMemory, limits.clusterCpu, token);
    const sent = adapters.ws.connectionManager.sendTask(routingKey, task);
    if (sent) {
      log.info(`Sent setup_cluster task for cluster ${clusterId} → ${routingKey}`);
    } else {
      log.warn(`setup_cluster task not delivered for cluster ${clusterId} — ${routingKey} not connected`);
    }
  };
}
