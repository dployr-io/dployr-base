// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { InstancePoolService } from "@/services/pool.js";
import type { JobFn } from "../index.js";


export const poolHealth: JobFn = async ({ db, kv }) => {
  const service = new InstancePoolService();
  service.poolHealth({ db, kv });
};
