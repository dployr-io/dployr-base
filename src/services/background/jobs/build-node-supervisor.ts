// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { JobFn } from "../index.js";
import { NodeDoctor } from "@/lib/node/node-doctor.js";

export const buildNodeSupervisor: JobFn = async ({ db, kv, pool, adapters }) => {
  const desiredBuildNodeCapacity = adapters.config.virtual_machines?.build_nodes ?? 1;
  const service = new NodeDoctor({ db, kv, vm: adapters.vmProvider, conn: adapters.ws.connectionManager, pool, desiredBuildNodeCapacity });
  await service.buildNodeReconcile();
};
