// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { BackgroundWorker } from "../index.js";
import { poolSync } from "./pool-sync.js";
import { poolPing } from "./pool-ping.js";
import { poolHealth } from "./pool-health.js";
import { THIRTY_SECONDS_MS, FIVE_MINUTES_MS, THIRTY_MINUTES_MS, POOL_HEALTH_JOB, POOL_PING_JOB, POOL_PING_DIRECT_JOB, POOL_SYNC_JOB } from "@/lib/constants/duration.js";

export function registerJobs(worker: BackgroundWorker): void {
  worker
    .schedule(POOL_SYNC_JOB, FIVE_MINUTES_MS, poolSync, { runImmediately: true })
    .schedule(POOL_PING_DIRECT_JOB, THIRTY_SECONDS_MS, poolPing({ mode: "tcp" }))
    .schedule(POOL_PING_JOB, THIRTY_MINUTES_MS, poolPing({ mode: "provider" }))
    .schedule(POOL_HEALTH_JOB, FIVE_MINUTES_MS, poolHealth)
    .on(POOL_SYNC_JOB, poolSync);
}
