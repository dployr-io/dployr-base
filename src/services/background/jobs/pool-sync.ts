// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { InstancePoolService } from "@/services/pool.js";

export const poolSync: JobFn = async ({ db, adapters }) => {
  const vm = adapters.vmProvider;
  if (!vm) return;

  const service = new InstancePoolService();
  service.poolSync({ db, vm });
};
