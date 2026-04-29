// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { InstancePool } from "@/services/pool.js";
import { JWTService } from "@/services/auth/jwt.js";
import { NodeDoctor } from "@/lib/node/node-doctor.js";

export const nodesSync: JobFn = async ({ db, kv, adapters }) => {
  const jwt = new JWTService(kv);
  const sshKey = adapters.config.virtual_machines?.ssh_key;
  const pool = new InstancePool({ db, kv, vm: adapters.vmProvider ?? undefined, jwt, sshKey });
  const service = new NodeDoctor({ db, kv, vm: adapters.vmProvider, conn: adapters.ws.connectionManager, pool });
  await service.nodesSync();
};
