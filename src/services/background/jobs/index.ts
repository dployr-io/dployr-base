// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { BackgroundWorker } from "../index.js";
import { nodesSync } from "./nodes-sync.js";
import { nodesHealth } from "./nodes-health.js";
import { secretsCleanup } from "./secrets-cleanup.js";
import { workloadSupervisor } from "./workload-supervisor.js";
import { MS_30_SECONDS, MS_5_MINUTES, MS_12_HOURS, MS_10_SECONDS } from "@/lib/constants/duration.js";
import { NODES_HEALTH_JOB, NODES_SYNC_JOB, SECRETS_CLEANUP_JOB, WORKLOAD_SUPERVISOR_JOB } from "@/lib/constants/index.js";

export function registerJobs(worker: BackgroundWorker): void {
  worker
    .schedule(NODES_HEALTH_JOB, MS_30_SECONDS, nodesHealth)
    .schedule(NODES_SYNC_JOB, MS_5_MINUTES, nodesSync)
    .schedule(SECRETS_CLEANUP_JOB, MS_12_HOURS, secretsCleanup)
    .schedule(WORKLOAD_SUPERVISOR_JOB, MS_10_SECONDS, workloadSupervisor)
    .on(NODES_HEALTH_JOB, nodesHealth, { runImmediately: true })
    .on(NODES_SYNC_JOB, nodesSync, { runImmediately: true });
}
