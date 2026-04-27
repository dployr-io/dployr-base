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
export const HEARTBEAT_WINDOW = 60 * 2; // 2 minutes

// Jobs (milliseconds — used with setInterval)
export const THIRTY_SECONDS_MS = 30 * 1000;
export const FIVE_MINUTES_MS = 5 * 60 * 1000;
export const THIRTY_MINUTES_MS = 30 * 60 * 1000;

export const POOL_SYNC_JOB = "pool-sync";
export const POOL_PING_JOB = "pool-ping";
export const POOL_PING_DIRECT_JOB = "pool-ping-direct";
export const POOL_HEALTH_JOB = "pool-health";
export const POOL_DRAIN_JOB = "pool-drain";

// 5 min — enough for a droplet to spin up and appear in vm.list()
export const POOL_PROVISION_LOCK_TTL = 60 * 5;
export const NODE_CONNECTED_TTL = 60; // 60 seconds — refreshed on every node message