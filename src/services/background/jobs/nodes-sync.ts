// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { NodeDoctor } from "@/lib/node/node-doctor.js";

export const nodesSync: JobFn = async ({ db, kv, pool, adapters }) => {
  const service = new NodeDoctor({ db, kv, vm: adapters.vmProvider, conn: adapters.ws.connectionManager, pool });
  await service.nodesSync();
};
