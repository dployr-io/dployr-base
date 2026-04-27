// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { InstancePoolService } from "@/services/pool.js";

export const poolDrain: JobFn = async ({ db, kv, adapters }) => {
  const service = new InstancePoolService({ db, kv, vm: adapters.vmProvider ?? undefined });
  service.poolDrain();
};
