// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { InstancePoolService } from "@/services/pool.js";
import type { JobFn } from "../index.js";

export const poolPingDirect: JobFn = async ({ db }) => {
  const service = new InstancePoolService();
  service.poolPingDirect({ db });
};
