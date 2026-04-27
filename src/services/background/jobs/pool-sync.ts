// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { InstancePoolService } from "@/services/pool.js";
import { JWTService } from "@/services/auth/jwt.js";

export const poolSync: JobFn = async ({ db, kv, adapters }) => {
  const jwt = new JWTService(kv);
  const sshKey = adapters.config.virtual_machines?.ssh_key;
  const service = new InstancePoolService({ db, kv, vm: adapters.vmProvider ?? undefined, jwt, sshKey });
  await service.poolSync();
};
