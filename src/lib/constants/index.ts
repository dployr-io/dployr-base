// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

export const WORKFLOW_NAME = 'dployr-bootstrap';

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
export const AGENT_UPDATE_TTL = 60 * 5; // 5 minutes
export const PROCESS_SNAPSHOT_TTL = 60 * 60 * 24; // 24 hours
export const INSTANCE_STATUS_TTL = 60 * 15; // 15 minutes
export const DEDUP_TTL = 60 * 60; // 1 hour
export const RELEASE_CACHE_TTL = 60 * 10; // 10 minutes
export const PENDING_GITHUB_INSTALL_TTL = 60 * 10; // 10 minutes

export const ERROR = {
    REQUEST: {
        MISSING_PARAMS: { code: "request.missing_params", status: 400, message: "Missing required parameters" },
        BAD_REQUEST: { code: "request.bad_request", status: 400, message: "Bad request" },
        INVALID_OTP: { code: "request.invalid_otp", status: 400, message: "Invalid OTP" },
        TOO_MANY_REQUESTS: { code: "request.too_many_requests", status: 429, message: "Too many requests" }
    },
    AUTH: {
        BAD_SESSION: { code: "auth.bad_session", status: 401, message: "Session invalid" },
        BAD_TOKEN: { code: "auth.bad_token", status: 401, message: "Invalid token" },
        INVALID_OAUTH_PROVIDER: { code: "auth.invalid_oauth_provider", status: 401, message: "OAuth provider not supported" },
        BAD_OAUTH_STATE: { code: "auth.bad_oauth_state", status: 401, message: "Invalid OAuth state" },
    },
    PERMISSION: {
        OWNER_ROLE_REQUIRED: { code: "permission.owner_role_required", status: 403, message: "Owner role required" },
        ADMIN_ROLE_REQUIRED: { code: "permission.admin_role_required", status: 403, message: "Admin role required" },
        DEVELOPER_ROLE_REQUIRED: { code: "permission.developer_role_required", status: 403, message: "Developer role required" },
        VIEWER_ROLE_REQUIRED: { code: "permission.viewer_role_required", status: 403, message: "Viewer role required" }
    },
    RESOURCE: {
        MISSING_RESOURCE: { code: "resource.missing_resource", status: 404, message: "Resource not found" },
        CONFLICT: { code: "resource.conflict", status: 409, message: "Resource conflict" }
    },
    BOOTSTRAP: {
        BOOTSTRAP_SETUP_FAILURE: { code: "bootstrap.bootstrap_setup_failure", status: 500, message: "Bootstrap setup failed" },
        BOOTSTRAP_RUN_FAILURE: { code: "bootstrap.bootstrap_run_failure", status: 500, message: "Bootstrap run failed" },
    },
    RUNTIME: {
        BAD_WEBHOOK_SIGNATURE: { code: "runtime.bad_webhook_signature", status: 500, message: "Invalid webhook signature" },
        INTERNAL_SERVER_ERROR: { code: "runtime.internal_server_error", status: 500, message: "Internal server error" },
        INSTANCE_NOT_CONNECTED: { code: "runtime.agent_not_connected", status: 503, message: "Instance is not connected or unresponsive to instance" }
    }
} as const;

export const EVENTS = {
    AUTH: {
        SESSION_CREATED: { code: "auth.session_created", message: "Sign-in successful" },
    },
    CLUSTER: {
        MODIFIED: { code: "cluster.modified", message: "Cluster modified successfully" },
        USER_INVITED: { code: "cluster.user_invited", message: "Successfully sent invite" },
        INVITE_REVOKED: { code: "cluster.invite_revoked", message: "Revoked invite to join cluster successfully" },
        INVITE_ACCEPTED: { code: "cluster.invite_accepted", message: "Accepted invite to join cluster" },
        INVITE_DECLINED: { code: "cluster.invite_declined", message: "Declined invite to join cluster" },
        REMOVED_USER: { code: "cluster.removed_user", message: "Removed user from cluster" },
        USER_ROLE_CHANGED: { code: "cluster.user_role_changed", message: "User role changed" },
        OWNERSHIP_TRANSFERRED: { code: "cluster.ownership_transferred", message: "Cluster ownership transferred" },
    },
    INSTANCE: {
        CREATED: { code: "instance.created", message: "Instance created successfully" },
        MODIFIED: { code: "instance.modified", message: "Instance modified successfully" },
        DELETED: { code: "instance.deleted", message: "Instance deleted successfully" },
    },
    PERMISSION: {
        OWNER_ACCESS_GRANTED: { code: "permission.owner_access_granted", message: "Owner access granted" },
        ADMIN_ACCESS_GRANTED: { code: "permission.admin_access_granted", message: "Admin access granted" },
        WRITE_ACCESS_GRANTED: { code: "permission.write_access_granted", message: "Write access granted" },
        READ_ACCESS_GRANTED: { code: "permission.read_access_granted", message: "Read access granted" },
    },
    RESOURCE: {
        RESOURCE_CREATED: { code: "resource.resource_created", message: "Resource created successfully" },
        RESOURCE_UPDATED: { code: "resource.resource_updated", message: "Resource updated successfully" },
        RESOURCE_DELETED: { code: "resource.resource_deleted", message: "Resource deleted successfully" }
    },
    BOOTSTRAP: {
        BOOTSTRAP_SETUP_COMPLETED: { code: "bootstrap.bootstrap_setup_completed", message: "Bootstrap setup completed successfully" },
        BOOTSTRAP_RUN_STARTED: { code: "bootstrap.bootstrap_run_started", message: "Bootstrap run initiated" },
        BOOTSTRAP_RUN_COMPLETED: { code: "bootstrap.bootstrap_run_completed", message: "Bootstrap run completed successfully" },
    },
    RUNTIME: {
        WEBHOOK_RECEIVED: { code: "runtime.webhook_received", message: "Webhook received successfully" },
        WEBHOOK_PROCESSED: { code: "runtime.webhook_processed", message: "Webhook processed successfully" }
    },
    INTEGRATIONS: {
        GITHUB_INSTALLED: { code: "integrations.github_installed", message: "GitHub integration setup successfully" }
    },
    READ: {
        BOOTSTRAP_LOGS: { code: "read.bootstrap_logs", message: "Bootstrap logs read" }   
    }
} as const;

export const DEFAULT_EVENTS = [
    EVENTS.INSTANCE.CREATED.code,
    EVENTS.INSTANCE.MODIFIED.code,
    EVENTS.INSTANCE.DELETED.code,
    EVENTS.CLUSTER.INVITE_ACCEPTED.code,
    EVENTS.CLUSTER.USER_INVITED.code,
    EVENTS.CLUSTER.REMOVED_USER.code,
    EVENTS.CLUSTER.USER_ROLE_CHANGED.code,
];
