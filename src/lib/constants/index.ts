export const WORKFLOW_NAME = 'dployr-bootstrap';

// KVs
export const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
export const STATE_TTL = 60 * 10; // 10 minutes
export const OTP_TTL = 60 * 10; // 10 minutes
export const FAILED_WORKFLOW_EVENT_TTL = 60 * 60 * 24 * 90; // 90 days

export const ERROR = {
    REQUEST: {
        MISSING_PARAMS: { code: "request.missing_params", status: 400, message: "Missing required parameters" },
        BAD_REQUEST: { code: "request.bad_request", status: 400, message: "Bad request" },
        INVALID_OTP: { code: "request.invalid_otp", status: 400, message: "Invalid OTP" }
    },
    AUTH: {
        BAD_SESSION: { code: "auth.bad_session", status: 401, message: "Session invalid" },
        INVALID_OAUTH_PROVIDER: { code: "auth.invalid_oauth_provider", status: 401, message: "OAuth provider not supported" },
        BAD_OAUTH_STATE: { code: "auth.bad_oauth_state", status: 401, message: "Invalid OAuth state" }
    },
    PERMISSION: {
        OWNER_ROLE_REQUIRED: { code: "permission.owner_role_required", status: 403, message: "Owner role required" },
        ADMIN_ROLE_REQUIRED: { code: "permission.admin_role_required", status: 403, message: "Admin role required" },
        DEVELOPER_ROLE_REQUIRED: { code: "permission.developer_role_required", status: 403, message: "Developer role required" }
    },
    RESOURCE: {
        MISSING_RESOURCE: { code: "resource.missing_resource", status: 404, message: "Resource not found" }
    },
    BOOTSTRAP: {
        BOOTSTRAP_SETUP_FAILURE: { code: "bootstrap.bootstrap_setup_failure", status: 500, message: "Bootstrap setup failed" },
        BOOTSTRAP_RUN_FAILURE: { code: "bootstrap.bootstrap_run_failure", status: 500, message: "Bootstrap run failed" },
    },
    RUNTIME: {
        BAD_WEBHOOK_SIGNATURE: { code: "runtime.bad_webhook_signature", status: 500, message: "Invalid webhook signature" },
        INTERNAL_SERVER_ERROR: { code: "runtime.internal_server_error", status: 500, message: "Internal server error" }
    }
} as const;

export const EVENTS = {
    AUTH: {
        SESSION_CREATED: { code: "auth.session_created", message: "Sign-in successful" },
    },
    CLUSTER: {
        USER_INVITED: { code: "cluster.user_invited", message: "Successfully sent invite" },
        INVITE_REVOKED: { code: "cluster.invite_revoked", message: "Revoked invite to join cluster successfully" },
        INVITE_ACCEPTED: { code: "cluster.invite_accepted", message: "Accepted invite to join cluster" },
        INVITE_DECLINED: { code: "cluster.invite_declined", message: "Declined invite to join cluster" },
        REMOVED_USER: { code: "cluster.removed_user", message: "Removed user from cluster" },
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
    }
} as const;
