export const ERROR = {
  REQUEST: {
    MISSING_PARAMS: { code: "request.missing_params", status: 400, message: "Missing required parameters" },
    BAD_REQUEST: { code: "request.bad_request", status: 400, message: "Bad request" },
    INVALID_OTP: { code: "request.invalid_otp", status: 400, message: "Invalid OTP" },
    UNPROCESSABLE_ENTITY: { code: "request.unprocessable_entity", status: 422, message: "Unprocessable entity" },
    TOO_MANY_REQUESTS: { code: "request.too_many_requests", status: 429, message: "Too many requests" },
    INTERNAL_SERVER_ERROR: { code: "request.internal_server_error", status: 500, message: "Something went wrong!" },
  },
  VALIDATION: {
    MISSING_FIELDS: { code: "validation.missing_fields", status: 400, message: "Missing required fields" },
    INVALID_FORMAT: { code: "validation.invalid_format", status: 400, message: "Invalid format" },
  },
  AUTH: {
    BAD_SESSION: { code: "auth.bad_session", status: 401, message: "Session invalid" },
    BAD_TOKEN: { code: "auth.bad_token", status: 401, message: "Invalid token" },
    INVALID_OAUTH_PROVIDER: { code: "auth.invalid_oauth_provider", status: 401, message: "OAuth provider not supported" },
    BAD_OAUTH_STATE: { code: "auth.bad_oauth_state", status: 401, message: "Invalid OAuth state" },
  },
  PERMISSION: {
    FORBIDDEN: { code: "permission.forbidden", status: 403, message: "Forbidden" },
    OWNER_ROLE_REQUIRED: { code: "permission.owner_role_required", status: 403, message: "Owner role required" },
    ADMIN_ROLE_REQUIRED: { code: "permission.admin_role_required", status: 403, message: "Admin role required" },
    DEVELOPER_ROLE_REQUIRED: { code: "permission.developer_role_required", status: 403, message: "Developer role required" },
    VIEWER_ROLE_REQUIRED: { code: "permission.viewer_role_required", status: 403, message: "Viewer role required" },
  },
  RESOURCE: {
    MISSING_RESOURCE: { code: "resource.missing_resource", status: 404, message: "Resource not found" },
    CONFLICT: { code: "resource.conflict", status: 409, message: "Resource conflict" },
  },
  BOOTSTRAP: {
    BOOTSTRAP_SETUP_FAILURE: { code: "bootstrap.bootstrap_setup_failure", status: 500, message: "Bootstrap setup failed" },
    BOOTSTRAP_RUN_FAILURE: { code: "bootstrap.bootstrap_run_failure", status: 500, message: "Bootstrap run failed" },
  },
  RUNTIME: {
    BAD_WEBHOOK_SIGNATURE: { code: "runtime.bad_webhook_signature", status: 500, message: "Invalid webhook signature" },
    INTERNAL_SERVER_ERROR: { code: "runtime.internal_server_error", status: 500, message: "Internal server error" },
    INSTANCE_NOT_CONNECTED: { code: "runtime.node_not_connected", status: 503, message: "Instance is not connected or unresponsive to instance" },
    ADMIN_TOTP_NOT_CONFIGURED: { code: "runtime.admin_totp_not_configured", status: 503, message: "Admin TOTP secret is not configured" }
  },
} as const;
