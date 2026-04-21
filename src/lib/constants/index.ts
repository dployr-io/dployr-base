// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ERROR } from "./error.js";
export { ERROR };

import { EVENTS } from "./events.js";
export { EVENTS };

export const WORKFLOW_NAME = "dployr-bootstrap";

// Versioning
export const LATEST_COMPATIBILITY_DATE = "2025-12-28";

// KVs
export const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
export const STATE_TTL = 60 * 10; // 10 minutes
export const OTP_TTL = 60 * 10; // 10 minutes
export const FAILED_WORKFLOW_EVENT_TTL = 60 * 60 * 24 * 90; // 90 days
export const EVENT_TTL = 60 * 60 * 24 * 30; // 30 days
export const TASK_TTL = 60 * 60 * 24; // 1 day
export const TASK_LEASE_TTL = 60; // 1 minute
export const NODE_UPDATE_TTL = 60 * 5; // 5 minutes
export const PROCESS_SNAPSHOT_TTL = 60 * 60 * 24; // 24 hours
export const INSTANCE_STATUS_TTL = 60 * 15; // 15 minutes
export const DEDUP_TTL = 60 * 60; // 1 hour
export const RELEASE_CACHE_TTL = 60 * 10; // 10 minutes
export const PENDING_GITHUB_INSTALL_TTL = 60 * 10; // 10 minutes
export const ADMIN_JWT_TTL = 60 * 30; // 30 minutes

// JWT
export const ADMIN_JWT_REFRESH_THRESHOLD = 60 * 29.5; // 29.5 minutes
