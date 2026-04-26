// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { InstancePoolService } from "@/services/pool.js";
import type { JobFn } from "../index.js";


export const poolPing: JobFn = async ({ db, adapters }) => {
  const vm = adapters.vmProvider;
  if (!vm) return;

  const service = new InstancePoolService();
  service.poolPing({ vm, db });
};
