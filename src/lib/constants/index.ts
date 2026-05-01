// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ERROR } from "./error.js";
export { ERROR };

import { SUCCESS } from "./success.js";
export { SUCCESS };

import { EVENTS, DEFAULT_EVENTS } from "./events.js";
export { EVENTS, DEFAULT_EVENTS };

export { NODES_DRAIN_JOB, NODES_HEALTH_JOB, NODES_SYNC_JOB, SECRETS_CLEANUP_JOB } from "./nodes.js";

export * from "./db.js";

export * from "./duration.js";

export const WORKFLOW_NAME = "dployr-bootstrap";

// Versioning
export const LATEST_COMPATIBILITY_DATE = "2025-12-28";
