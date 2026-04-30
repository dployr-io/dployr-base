import { ConnectionManagerConfig } from "@/types/index.js";

export const DEFAULT_CONFIG: ConnectionManagerConfig = {
  requestTimeoutMs: 30000,
  cleanupIntervalMs: 10000,
  maxPendingPerClient: 50,
  connectionTtlMs: 300000,
};

/**
 * Message kind constants
 */
export const MESSAGE_KIND = {
  // Node -> Server
  UPDATE: "update",
  LOG_CHUNK: "log_chunk",
  TASK_RESPONSE: "task_response",

  // Client -> Server
  CLIENT_SUBSCRIBE: "client_subscribe",
  LOG_SUBSCRIBE: "log_subscribe",
  LOG_UNSUBSCRIBE: "log_unsubscribe",
  LOG_STREAM: "log_stream",
  DEPLOY: "deploy",
  DEPLOYMENT_LIST: "deployment_list",
  SERVICE_CREATE: "service_create",
  SERVICE_REMOVE: "service_remove",
  FILE_READ: "file_read",
  FILE_WRITE: "file_write",
  FILE_CREATE: "file_create",
  FILE_DELETE: "file_delete",
  FILE_TREE: "file_tree",
  FILE_WATCH: "file_watch",
  FILE_UNWATCH: "file_unwatch",
  FILE_UPDATE: "file_update",

  // Terminal operations
  TERMINAL: "terminal",
  TERMINAL_OPEN: "terminal_open",

  // Instance operations
  INSTANCE_TOKEN_ROTATE: "instance_token_rotate",
  INSTANCE_SYSTEM_INSTALL: "instance_system_install",
  INSTANCE_SYSTEM_REBOOT: "instance_system_reboot",
  INSTANCE_SYSTEM_RESTART: "instance_system_restart",

  // Proxy operations
  PROXY_STATUS: "proxy_status",
  PROXY_RESTART: "proxy_restart",
  PROXY_ADD: "proxy_add",
  PROXY_REMOVE: "proxy_remove",

  // Process history
  PROCESS_HISTORY: "process_history",

  // Server -> Client
  TASK: "task",
  ERROR: "error",

  // Acknowledgments
  ACK: "ack",
} as const;


/**
 * Error codes for WebSocket operations
 */
export enum WSErrorCode {
  // Validation errors (1xxx)
  VALIDATION_ERROR = 1000,
  MISSING_FIELD = 1001,
  INVALID_FORMAT = 1002,
  CONFLICT = 1003,

  // Permission errors (2xxx)
  PERMISSION_DENIED = 2000,
  NOT_FOUND = 2001,
  UNAUTHORIZED = 2002,

  // Node errors (3xxx)
  NODE_TIMEOUT = 3000,
  NODE_DISCONNECTED = 3001,
  NODE_ERROR = 3002,

  // Rate limiting (4xxx)
  RATE_LIMITED = 4000,
  TOO_MANY_PENDING = 4001,

  // Internal errors (5xxx)
  INTERNAL_ERROR = 5000,
  TASK_FAILED = 5001,
}