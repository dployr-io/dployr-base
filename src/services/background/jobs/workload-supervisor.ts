// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { NotificationService } from "@/services/notifications/index.js";
import { EmailService } from "@/services/notifications/email/index.js";
import { NODES_SYNC_JOB } from "@/lib/constants/index.js";

// survives across job ticks so the cooldown map is never reset
const reprovisionCooldowns = new Map<string, number>();

export const workloadSupervisor: JobFn = async ({ db, kv, jwt: jwtService, adapters, trigger, setOutput }) => {
  const { connectionManager, clientNotifier } = adapters.ws;

  const traefik = adapters.traefik;

  const emailService = adapters.email ? new EmailService(adapters.email, adapters.config as any) : null;
  const notificationService = new NotificationService(emailService);

  const supervisor = new WorkloadSupervisor(db, kv, connectionManager, jwtService, clientNotifier, traefik, adapters.config.server.base_url, reprovisionCooldowns, notificationService);

  supervisor.onClusterNeedsReallocation(async () => {
    trigger(NODES_SYNC_JOB);
  });

  await traefik?.ensureWakeupMiddleware();
  await supervisor.run();
  setOutput(supervisor.getRunSummary());
};
