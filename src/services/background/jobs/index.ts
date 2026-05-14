// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { BackgroundWorker } from "../index.js";
import { nodesSync } from "./nodes-sync.js";
import { nodesHealth } from "./nodes-health.js";
import { secretsCleanup } from "./secrets-cleanup.js";
import { workloadSupervisor } from "./workload-supervisor.js";
import { buildNodeSupervisor } from "./build-node-supervisor.js";
import { hobbySleepSupervisor } from "./hobby-sleep-supervisor.js";
import { hobbyIceSupervisor } from "./hobby-ice-supervisor.js";
import { MS_30_SECONDS, MS_5_MINUTES, MS_12_HOURS, MS_24_HOURS, MS_10_SECONDS } from "@/lib/constants/duration.js";
import { NODES_HEALTH_JOB, NODES_SYNC_JOB, SECRETS_CLEANUP_JOB, WORKLOAD_SUPERVISOR_JOB, BUILD_NODE_SUPERVISOR_JOB, HOBBY_SLEEP_SUPERVISOR_JOB, HOBBY_ICE_SUPERVISOR_JOB } from "@/lib/constants/index.js";

export function registerJobs(worker: BackgroundWorker): void {
  worker
    .schedule(NODES_HEALTH_JOB, MS_30_SECONDS, nodesHealth)
    .schedule(NODES_SYNC_JOB, MS_5_MINUTES, nodesSync)
    .schedule(SECRETS_CLEANUP_JOB, MS_12_HOURS, secretsCleanup)
    .schedule(WORKLOAD_SUPERVISOR_JOB, MS_10_SECONDS, workloadSupervisor)
    .schedule(BUILD_NODE_SUPERVISOR_JOB, MS_5_MINUTES, buildNodeSupervisor, { runImmediately: true })
    .schedule(HOBBY_SLEEP_SUPERVISOR_JOB, MS_5_MINUTES, hobbySleepSupervisor)
    .schedule(HOBBY_ICE_SUPERVISOR_JOB, MS_24_HOURS, hobbyIceSupervisor)
    .on(NODES_HEALTH_JOB, nodesHealth, { runImmediately: true })
    .on(NODES_SYNC_JOB, nodesSync, { runImmediately: true });
}
