// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ERROR } from "./error.js";
export { ERROR };

import { SUCCESS } from "./success.js";
export { SUCCESS };

import { EVENTS, DEFAULT_EVENTS } from "./events.js";
export { EVENTS, DEFAULT_EVENTS };

export {
  NODES_DRAIN_JOB,
  NODES_HEALTH_JOB,
  NODES_SYNC_JOB,
  SECRETS_CLEANUP_JOB,
  WORKLOAD_SUPERVISOR_JOB,
  BUILD_NODE_SUPERVISOR_JOB,
  HOBBY_SLEEP_SUPERVISOR_JOB,
  HOBBY_ICE_SUPERVISOR_JOB,
  TRAEFIK_METRICS_SCRAPER_JOB,
  DOCKER_PRUNE_JOB,
  DOMAIN_VERIFICATION_JOB,
} from "./nodes.js";

export * from "./db.js";

export * from "./duration.js";

export const WORKFLOW_NAME = "dployr-bootstrap";

// Versioning
export const LATEST_COMPATIBILITY_DATE = "2025-12-28";

// Loading page on traefik server
export const SERVICE_STUB_ADDRESS = "http://127.0.0.1:19503";
