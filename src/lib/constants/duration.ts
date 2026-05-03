// All in milliseconds

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
export const BILLING_NOTIFICATION_TTL = 60 * 60 * 24; // 24 hours

// JWT
export const ADMIN_JWT_REFRESH_WINDOW = 60 * 29.5; // 29.5 minutes

// VMs
export const ACCEPTABLE_HEARTBEAT_WINDOW = 60 * 3; // 3 minutes

// Jobs (milliseconds — used with setInterval)
export const TEN_SECONDS_MS = 10 * 1000;
export const TWELVE_SECONDS_MS = 12 * 1000;
export const THIRTY_SECONDS_MS = 30 * 1000;
export const FIVE_MINUTES_MS = 5 * 60 * 1000;
export const THIRTY_MINUTES_MS = 30 * 60 * 1000;
export const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;
export const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export const POOL_PROVISION_LOCK_TTL = 100; // 100 seconds
export const NODE_CONNECTED_TTL = 60; // 60 seconds — refreshed on every node message

// During this period, pool sync will skip decommission of degraded, until next window
export const INSTANCE_DECOMMISSION_RECOVERY_WINDOW_MS = 30_000; // 100 seconds
