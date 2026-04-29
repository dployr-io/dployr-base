// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { BackgroundWorker } from "../index.js";
import { nodesSync } from "./nodes-sync.js";
import { nodesHealth } from "./nodes-health.js";
import { THIRTY_SECONDS_MS, FIVE_MINUTES_MS } from "@/lib/constants/duration.js";
import { NODES_HEALTH_JOB, NODES_SYNC_JOB } from "@/lib/constants/index.js";

export function registerJobs(worker: BackgroundWorker): void {
  worker
    .schedule(NODES_HEALTH_JOB, THIRTY_SECONDS_MS, nodesHealth)
    .schedule(NODES_SYNC_JOB, FIVE_MINUTES_MS, nodesSync)
    .on(NODES_SYNC_JOB, nodesSync, { runImmediately: true });
}
