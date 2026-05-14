// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { InstancePool } from "@/services/pool.js";
import type { JobFn } from "../index.js";
import { NodeDoctor } from "@/lib/node/node-doctor.js";
import { NODES_SYNC_JOB } from "@/lib/constants/index.js";

export const nodesHealth: JobFn = async ({ db, kv, adapters, trigger }) => {
  const pool = new InstancePool({ db, kv, vm: adapters.vmProvider ?? undefined });
  const service = new NodeDoctor({ db, kv, vm: adapters.vmProvider, conn: adapters.ws.connectionManager, pool });
  service.onDecommission(() => trigger(NODES_SYNC_JOB));
  await service.nodeHeartbeat();
  await service.checkDiskPressure();
};
