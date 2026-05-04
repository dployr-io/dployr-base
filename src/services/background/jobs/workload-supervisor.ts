// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { WorkloadSupervisor } from "@/lib/node/workload-supervisor.js";
import { JWTService } from "@/services/auth/jwt.js";
import { DployrdService } from "@/services/dployrd.js";
import { TraefikService } from "@/services/traefik-router.js";

export const workloadSupervisor: JobFn = async ({ db, kv, adapters }) => {
  const jwtService = new JWTService(kv);
  const dployrdService = new DployrdService();
  const { connectionManager, clientNotifier } = adapters.ws;

  let traefik: TraefikService | null = null;
  if (adapters.traefikRedis && adapters.config.traefik?.enabled) {
    traefik = new TraefikService(adapters.config.traefik.tld ?? "dployr.run", adapters.traefikRedis);
  }

  const supervisor = new WorkloadSupervisor(db, kv, connectionManager, jwtService, dployrdService, clientNotifier, traefik);
  await supervisor.run();
};
