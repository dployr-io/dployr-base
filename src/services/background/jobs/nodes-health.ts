// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { InstancePool } from "@/services/pool.js";
import type { JobFn } from "../index.js";
import { NodeDoctor } from "@/lib/node/node-doctor.js";

export const nodesHealth: JobFn = async ({ db, kv, adapters }) => {
  const pool = new InstancePool({ db, kv, vm: adapters.vmProvider ?? undefined });
  const service = new NodeDoctor({ db, kv, vm: adapters.vmProvider, conn: adapters.ws.connectionManager, pool });
  service.nodeHeartbeat();
};
