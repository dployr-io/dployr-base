export const WORKFLOW_NAME = 'dployr-bootstrap';

// KVs
export const SESSION_TTL = 60 * 60 * 24 * 7; // 7 days
export const STATE_TTL = 60 * 10; // 10 minutes
export const OTP_TTL = 60 * 10; // 10 minutes
export const FAILED_WORKFLOW_EVENT_TTL = 60 * 60 * 24 * 90; // 90 days

// 400 Error codes
export const MISSING_PARAMS = "MISSING_PARAMS";
export const BAD_REQUEST = "BAD_REQUEST";
export const INVALID_OTP = "INVALID_OTP";

// 401 Error codes
export const BAD_SESSION = "BAD_SESSION";
export const INVALID_OAUTH_PROVIDER = "INVALID_OAUTH_PROVIDER";
export const BAD_OAUTH_STATE = "BAD_OAUTH_STATE";

// 403 Error codes
export const OWNER_ROLE_REQUIRED = "OWNER_ROLE_REQUIRED";
export const ADMIN_ROLE_REQUIRED = "ADMIN_ROLE_REQUIRED";
export const DEVELOPER_ROLE_REQUIRED = "DEVELOPER_ROLE_REQUIRED";

// 404 Error codes
export const MISSING_RESOURCE = "MISSING_RESOURCE";

// 5xx Error codes
export const BOOTSTRAP_SETUP_FAILURE = "BOOTSTRAP_SETUP_FAILURE";
export const BOOTSTRAP_RUN_FAILURE = "BOOTSTRAP_RUN_FAILURE"; 
export const BAD_WEBHOOK_SIGNATURE = "BAD_WEBHOOK_SIGNATURE"; 
export const INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR";
