// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { JWTService } from "@/services/auth/jwt.js";
import { DployrdService } from "@/services/dployrd.js";
import { TraefikService } from "@/services/traefik-router.js";
import { NODES_SYNC_JOB } from "@/lib/constants/index.js";

// survives across job ticks so the cooldown map is never reset
const reprovisionCooldowns = new Map<string, number>();

export const workloadSupervisor: JobFn = async ({ db, kv, adapters, trigger, setOutput }) => {
  const jwtService = new JWTService(kv);
  const dployrdService = new DployrdService();
  const { connectionManager, clientNotifier } = adapters.ws;

  let traefik: TraefikService | null = null;
  if (adapters.traefikRedis && adapters.config.traefik?.enabled) {
    traefik = new TraefikService(adapters.config.traefik.tld ?? "dployr.run", adapters.traefikRedis);
  }

  const supervisor = new WorkloadSupervisor(db, kv, connectionManager, jwtService, dployrdService, clientNotifier, traefik, reprovisionCooldowns);

  supervisor.onClusterNeedsReallocation(async () => {
    trigger(NODES_SYNC_JOB);
  });

  await supervisor.run();
  setOutput(supervisor.getRunSummary());
};
