// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * Duration constants with explicit units.
 *
 * SECONDS: KV/Redis TTL values (input to .put({ttl: ...}))
 * MILLISECONDS: setTimeout/setInterval values, Date calculations
 */

const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 1 minute in seconds (for KV/Redis TTL) */
export const TTL_1_MINUTE = 60;

/** 5 minutes in seconds (for KV/Redis TTL) */
export const TTL_5_MINUTES = 5 * MINUTE;

/** 10 minutes in seconds (for KV/Redis TTL) */
export const TTL_10_MINUTES = 10 * MINUTE;

/** 15 minutes in seconds (for KV/Redis TTL) */
export const TTL_15_MINUTES = 15 * MINUTE;

/** 30 minutes in seconds (for KV/Redis TTL) */
export const TTL_30_MINUTES = 30 * MINUTE;

/** 1 hour in seconds (for KV/Redis TTL) */
export const TTL_1_HOUR = 1 * HOUR;

/** 24 hours in seconds (for KV/Redis TTL) */
export const TTL_24_HOURS = 24 * HOUR;

/** 30 days in seconds (for KV/Redis TTL) */
export const TTL_30_DAYS = 30 * DAY;

/** 90 days in seconds (for KV/Redis TTL) */
export const TTL_90_DAYS = 90 * DAY;

/** 7 days in seconds (for KV/Redis TTL) */
export const TTL_7_DAYS = 7 * DAY;

/** 10 seconds in milliseconds (for setTimeout/setInterval) */
export const MS_10_SECONDS = 10 * 1000;

/** 12 seconds in milliseconds (for setTimeout/setInterval) */
export const MS_12_SECONDS = 12 * 1000;

/** 30 seconds in milliseconds (for setTimeout/setInterval) */
export const MS_30_SECONDS = 30 * 1000;

/** 1 minute in milliseconds (for setTimeout/setInterval) */
export const MS_1_MINUTE = 1 * 60 * 1000;

/** 5 minutes in milliseconds (for setTimeout/setInterval) */
export const MS_5_MINUTES = 5 * 60 * 1000;

/** 30 minutes in milliseconds (for setTimeout/setInterval) */
export const MS_30_MINUTES = 30 * 60 * 1000;

/** 12 hours in milliseconds (for setTimeout/setInterval) */
export const MS_12_HOURS = 12 * 60 * 60 * 1000;

/** 24 hours in milliseconds (for setTimeout/setInterval) */
export const MS_24_HOURS = 24 * 60 * 60 * 1000;

/** Session lifetime: 7 days */
export const SESSION_TTL = TTL_7_DAYS;

/** OAuth state token expiry: 10 minutes */
export const STATE_TTL = TTL_10_MINUTES;

/** One-time password expiry: 10 minutes */
export const OTP_TTL = TTL_10_MINUTES;

/** Event audit log retention: 30 days */
export const EVENT_TTL = TTL_30_DAYS;

/** Workflow failure tracking retention: 90 days */
export const FAILED_WORKFLOW_EVENT_TTL = TTL_90_DAYS;

/** Background task lifetime: 1 day */
export const TASK_TTL = TTL_24_HOURS;

/** Task lease/lock duration: 1 minute */
export const TASK_LEASE_TTL = TTL_1_MINUTE;

/** Node state update cache: 5 minutes */
export const NODE_UPDATE_TTL = TTL_5_MINUTES;

/** Process snapshot cache: 24 hours */
export const PROCESS_SNAPSHOT_TTL = TTL_24_HOURS;

/** Instance status broadcast cache: 15 minutes */
export const INSTANCE_STATUS_TTL = TTL_15_MINUTES;

/** Request deduplication window: 1 hour */
export const DEDUP_TTL = TTL_1_HOUR;

/** Pending GitHub app installation cache: 10 minutes */
export const PENDING_GITHUB_INSTALL_TTL = TTL_10_MINUTES;

/** Admin JWT token lifetime: 30 minutes */
export const ADMIN_JWT_TTL = TTL_30_MINUTES;

/** Billing notification cache: 24 hours */
export const BILLING_NOTIFICATION_TTL = TTL_24_HOURS;

/** Pool provision lock duration: 100 seconds */
export const POOL_PROVISION_LOCK_TTL = 100;

/** Node connected heartbeat refresh: 60 seconds */
export const NODE_CONNECTED_TTL = TTL_1_MINUTE;

/** Admin JWT refresh threshold: 29.5 minutes (checked before 30 min expiry to issue fresh token) */
export const ADMIN_JWT_REFRESH_WINDOW = 29.5 * MINUTE;

/** Node heartbeat acceptable window: 3 minutes */
export const ACCEPTABLE_HEARTBEAT_WINDOW = 3 * MINUTE;

/** Instance decommission recovery window: 30 seconds */
export const INSTANCE_DECOMMISSION_RECOVERY_WINDOW_MS = MS_30_SECONDS;
