// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

/**
 * Duration constants with explicit units.
 *
 * SECONDS: KV/Redis TTL values (input to .put({ttl: ...}))
 * MILLISECONDS: setTimeout/setInterval values, Date calculations
 */

// --- seconds primitives (for TTL_ constants) ---
const SECOND = 1;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// --- milliseconds primitives (for MS_ constants) ---
const MS_SECOND = 1000;
const MS_MINUTE = 60 * MS_SECOND;
const MS_HOUR = 60 * MS_MINUTE;

// --- TTL primitives (seconds, for KV/Redis) ---
export const TTL_1_MINUTE = MINUTE;
export const TTL_5_MINUTES = 5 * MINUTE;
export const TTL_10_MINUTES = 10 * MINUTE;
export const TTL_15_MINUTES = 15 * MINUTE;
export const TTL_30_MINUTES = 30 * MINUTE;
export const TTL_1_HOUR = HOUR;
export const TTL_24_HOURS = 24 * HOUR;
export const TTL_7_DAYS = 7 * DAY;
export const TTL_30_DAYS = 30 * DAY;
export const TTL_90_DAYS = 90 * DAY;

// --- MS primitives (milliseconds, for timers/Date math) ---
export const MS_10_SECONDS = 10 * MS_SECOND;
export const MS_12_SECONDS = 12 * MS_SECOND;
export const MS_30_SECONDS = 30 * MS_SECOND;
export const MS_1_MINUTE = MS_MINUTE;
export const MS_5_MINUTES = 5 * MS_MINUTE;
export const MS_6_MINUTES = 6 * MS_MINUTE;
export const MS_8_MINUTES = 8 * MS_MINUTE;
export const MS_30_MINUTES = 30 * MS_MINUTE;
export const MS_12_HOURS = 12 * MS_HOUR;
export const MS_24_HOURS = 24 * MS_HOUR;

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

/** Pending deployment payload lobby retention: 30 minutes */
export const PAYLOAD_TTL = TTL_30_MINUTES;

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

/** Pool provision lock duration: 300 seconds */
export const POOL_PROVISION_LOCK_TTL = 300;

/** Node connected heartbeat refresh: 60 seconds */
export const NODE_CONNECTED_TTL = TTL_1_MINUTE;

/** Admin JWT refresh threshold: 29.5 minutes in seconds (checked before 30 min expiry) */
export const ADMIN_JWT_REFRESH_WINDOW = 29.5 * MINUTE;

/** Node heartbeat acceptable window: 3 minutes in seconds */
export const ACCEPTABLE_HEARTBEAT_WINDOW = 3 * MINUTE;

/** Instance decommission recovery window: 30 seconds */
export const INSTANCE_DECOMMISSION_RECOVERY_WINDOW_MS = MS_30_SECONDS;

/** Grace period after instance creation before health checks begin: 6 minutes */
export const INSTANCE_STARTUP_GRACE_MS = MS_6_MINUTES;

/** Entity tombstone retention: 7 days */
export const ENTITY_TOMBSTONE_TTL = TTL_7_DAYS;

/** Domain mapping TTL: 7 days */
export const DOMAIN_MAPPING_TTL = TTL_7_DAYS;

/** Reprovision cooldown for workload processor: 8 minutes */
export const REPROVISION_COOLDOWN_MS = MS_8_MINUTES;
