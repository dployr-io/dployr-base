// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { DeploymentPayload } from "@/lib/tasks/types.js";
import type { Session } from "@/types/index.js";

/**
 * Error codes for WebSocket operations
 */
export enum WSErrorCode {
  // Validation errors (1xxx)
  VALIDATION_ERROR = 1000,
  MISSING_FIELD = 1001,
  INVALID_FORMAT = 1002,
  
  // Permission errors (2xxx)
  PERMISSION_DENIED = 2000,
  NOT_FOUND = 2001,
  UNAUTHORIZED = 2002,
  
  // Agent errors (3xxx)
  AGENT_TIMEOUT = 3000,
  AGENT_DISCONNECTED = 3001,
  AGENT_ERROR = 3002,
  
  // Rate limiting (4xxx)
  RATE_LIMITED = 4000,
  TOO_MANY_PENDING = 4001,
  
  // Internal errors (5xxx)
  INTERNAL_ERROR = 5000,
  TASK_FAILED = 5001,
}

/**
 * Structured error response
 */
export interface WSErrorResponse {
  kind: "error";
  requestId: string;
  code: WSErrorCode;
  message: string;
  details?: Record<string, unknown>;
  timestamp: number;
}

/**
 * Message kind constants
 */
export const MessageKind = {
  // Agent -> Server
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

  // Server -> Client
  TASK: "task",
  ERROR: "error",
  
  // Acknowledgments
  ACK: "ack",
} as const;

export type MessageKindType = (typeof MessageKind)[keyof typeof MessageKind];

/**
 * Base message interface - all messages must have requestId for correlation
 */
export interface BaseMessage {
  kind: string;
  requestId?: string;
}

/**
 * Base request message - client messages requiring response
 */
export interface BaseRequestMessage extends BaseMessage {
  requestId: string;
}

/**
 * Agent messages
 */
export interface UpdateMessage extends BaseMessage {
  kind: typeof MessageKind.UPDATE;
  [key: string]: unknown;
}

export interface LogChunkMessage extends BaseMessage {
  kind: typeof MessageKind.LOG_CHUNK;
  streamId?: string;
  data?: string;
  [key: string]: unknown;
}

export interface TaskResponseMessage extends BaseMessage {
  kind: typeof MessageKind.TASK_RESPONSE;
  taskId: string;
  requestId: string;
  success: boolean;
  data?: Record<string, any>;
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export type AgentMessage = UpdateMessage | LogChunkMessage | TaskResponseMessage;

/**
 * Acknowledgment message
 */
export interface AckMessage extends BaseMessage {
  kind: typeof MessageKind.ACK;
  messageId: string;
}

/**
 * Client messages - all require requestId
 */
export interface ClientSubscribeMessage extends BaseRequestMessage {
  kind: typeof MessageKind.CLIENT_SUBSCRIBE;
}

export interface LogSubscribeMessage extends BaseRequestMessage {
  kind: typeof MessageKind.LOG_SUBSCRIBE;
  instanceName: string;
  path: string;
  startOffset?: number;
  limit?: number;
  duration?: string;
}

export interface LogUnsubscribeMessage extends BaseRequestMessage {
  kind: typeof MessageKind.LOG_UNSUBSCRIBE;
  path?: string;
}

export interface DeployMessage extends BaseRequestMessage {
  kind: typeof MessageKind.DEPLOY;
  instanceName: string;
  payload: DeploymentPayload;
}

export interface ServiceCreateMessage extends BaseMessage {
  kind: typeof MessageKind.SERVICE_CREATE;
  instanceName: string;
  name: string;
}

export interface ServiceRemoveMessage extends BaseRequestMessage {
  kind: typeof MessageKind.SERVICE_REMOVE;
  name: string;
}

export interface DeploymentListMessage extends BaseRequestMessage {
  kind: typeof MessageKind.DEPLOYMENT_LIST;
  instanceName: string;
}

export interface LogStreamMessage extends BaseRequestMessage {
  kind: typeof MessageKind.LOG_STREAM;
  token: string;
  path: string;
  streamId: string;
  startFrom: number;
  duration: string;
}

/**
 * File operation messages - all require requestId
 */
export interface FileReadMessage extends BaseRequestMessage {
  kind: typeof MessageKind.FILE_READ;
  instanceId: string;
  path: string;
}

export interface FileWriteMessage extends BaseRequestMessage {
  kind: typeof MessageKind.FILE_WRITE;
  instanceId: string;
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface FileCreateMessage extends BaseRequestMessage {
  kind: typeof MessageKind.FILE_CREATE;
  instanceId: string;
  path: string;
  type: "file" | "directory";
}

export interface FileDeleteMessage extends BaseRequestMessage {
  kind: typeof MessageKind.FILE_DELETE;
  instanceId: string;
  path: string;
}

export interface FileTreeMessage extends BaseRequestMessage {
  kind: typeof MessageKind.FILE_TREE;
  instanceId: string;
  path?: string;
}

export interface FileWatchMessage extends BaseRequestMessage {
  kind: typeof MessageKind.FILE_WATCH;
  instanceId: string;
  path: string;
  recursive?: boolean;
}

export interface FileUnwatchMessage extends BaseRequestMessage {
  kind: typeof MessageKind.FILE_UNWATCH;
  instanceId: string;
  path: string;
}

export interface FileUpdateMessage extends BaseMessage {
  kind: typeof MessageKind.FILE_UPDATE;
  instanceId: string;
  event: FileUpdateEvent;
}

/**
 * File operation response messages
 */
export interface FileReadResponseMessage extends BaseMessage {
  kind: "file_read_response";
  requestId: string;
  taskId: string;
  success: boolean;
  content?: string;
  encoding?: "utf8" | "base64";
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface FileWriteResponseMessage extends BaseMessage {
  kind: "file_write_response";
  requestId: string;
  taskId: string;
  success: boolean;
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface FileCreateResponseMessage extends BaseMessage {
  kind: "file_create_response";
  requestId: string;
  taskId: string;
  success: boolean;
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface FileDeleteResponseMessage extends BaseMessage {
  kind: "file_delete_response";
  requestId: string;
  taskId: string;
  success: boolean;
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface FileTreeResponseMessage extends BaseMessage {
  kind: "file_tree_response";
  requestId: string;
  taskId: string;
  success: boolean;
  root?: FileNode;
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface FileUpdateEvent {
  path: string;
  type: "create" | "modify" | "delete" | "rename";
  isDir: boolean;
  timestamp: number;
  oldPath?: string;
}

export type FileOperationResponse = 
  | FileReadResponseMessage 
  | FileWriteResponseMessage 
  | FileCreateResponseMessage 
  | FileDeleteResponseMessage 
  | FileTreeResponseMessage;

/**
 * Instance operation messages
 */
export interface InstanceTokenRotateMessage extends BaseRequestMessage {
  kind: typeof MessageKind.INSTANCE_TOKEN_ROTATE;
  instanceName: string;
  token: string;
}

export interface InstanceSystemInstallMessage extends BaseRequestMessage {
  kind: typeof MessageKind.INSTANCE_SYSTEM_INSTALL;
  instanceName: string;
  clusterId: string;
  version?: string;
}

export interface InstanceSystemRebootMessage extends BaseRequestMessage {
  kind: typeof MessageKind.INSTANCE_SYSTEM_REBOOT;
  instanceName: string;
  clusterId: string;
  force?: boolean;
}

export interface InstanceSystemRestartMessage extends BaseRequestMessage {
  kind: typeof MessageKind.INSTANCE_SYSTEM_RESTART;
  instanceName: string;
  clusterId: string;
  force?: boolean;
}

/**
 * Proxy operation messages
 */
export interface ProxyStatusMessage extends BaseRequestMessage {
  kind: typeof MessageKind.PROXY_STATUS;
  instanceName: string;
  clusterId: string;
}

export interface ProxyRestartMessage extends BaseRequestMessage {
  kind: typeof MessageKind.PROXY_RESTART;
  instanceName: string;
  clusterId: string;
  force?: boolean;
}

export interface ProxyAddMessage extends BaseRequestMessage {
  kind: typeof MessageKind.PROXY_ADD;
  instanceName: string;
  clusterId: string;
  serviceName: string;
  upstream: string;
  domain?: string;
}

export interface ProxyRemoveMessage extends BaseRequestMessage {
  kind: typeof MessageKind.PROXY_REMOVE;
  instanceName: string;
  clusterId: string;
  serviceName: string;
}

/**
 * Instance operation response messages
 */
export interface InstanceListResponseMessage extends BaseMessage {
  kind: "instance_list_response";
  requestId: string;
  success: boolean;
  data?: {
    instances: any[];
    page: number;
    pageSize: number;
    total: number;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface InstanceCreateResponseMessage extends BaseMessage {
  kind: "instance_create_response";
  requestId: string;
  success: boolean;
  data?: {
    instance: any;
    token: string;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface InstanceDeleteResponseMessage extends BaseMessage {
  kind: "instance_delete_response";
  requestId: string;
  success: boolean;
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface InstanceTokenRotateResponseMessage extends BaseMessage {
  kind: "instance_token_rotate_response";
  requestId: string;
  success: boolean;
  data?: {
    token: string;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface InstanceSystemInstallResponseMessage extends BaseMessage {
  kind: "instance_system_install_response";
  requestId: string;
  success: boolean;
  data?: {
    status: string;
    taskId: string;
    message: string;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface InstanceSystemRebootResponseMessage extends BaseMessage {
  kind: "instance_system_reboot_response";
  requestId: string;
  success: boolean;
  data?: {
    status: string;
    taskId: string;
    message: string;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface InstanceSystemRestartResponseMessage extends BaseMessage {
  kind: "instance_system_restart_response";
  requestId: string;
  success: boolean;
  data?: {
    status: string;
    taskId: string;
    message: string;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

/**
 * Proxy operation response messages
 */
export interface ProxyStatusResponseMessage extends BaseMessage {
  kind: "proxy_status_response";
  requestId: string;
  success: boolean;
  data?: {
    status: string;
    services: any[];
    stats?: any;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface ProxyRestartResponseMessage extends BaseMessage {
  kind: "proxy_restart_response";
  requestId: string;
  success: boolean;
  data?: {
    status: string;
    message: string;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface ProxyAddResponseMessage extends BaseMessage {
  kind: "proxy_add_response";
  requestId: string;
  success: boolean;
  data?: {
    serviceName: string;
    upstream: string;
    message: string;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export interface ProxyRemoveResponseMessage extends BaseMessage {
  kind: "proxy_remove_response";
  requestId: string;
  success: boolean;
  data?: {
    serviceName: string;
    message: string;
  };
  error?: {
    code: WSErrorCode;
    message: string;
  };
}

export type InstanceOperationResponse =
  | InstanceListResponseMessage
  | InstanceCreateResponseMessage
  | InstanceDeleteResponseMessage
  | InstanceTokenRotateResponseMessage
  | InstanceSystemInstallResponseMessage
  | InstanceSystemRebootResponseMessage
  | InstanceSystemRestartResponseMessage;

export type ProxyOperationResponse =
  | ProxyStatusResponseMessage
  | ProxyRestartResponseMessage
  | ProxyAddResponseMessage
  | ProxyRemoveResponseMessage;

export type ClientMessage = 
  | ClientSubscribeMessage 
  | LogSubscribeMessage 
  | LogUnsubscribeMessage 
  | DeployMessage 
  | LogStreamMessage 
  | FileReadMessage 
  | FileWriteMessage 
  | FileCreateMessage 
  | FileDeleteMessage 
  | FileTreeMessage
  | FileWatchMessage
  | FileUnwatchMessage
  | InstanceTokenRotateMessage
  | InstanceSystemInstallMessage
  | InstanceSystemRebootMessage
  | InstanceSystemRestartMessage
  | ProxyStatusMessage
  | ProxyRestartMessage
  | ProxyAddMessage
  | ProxyRemoveMessage
  | AckMessage;

/**
 * All inbound messages
 */
export type InboundMessage = AgentMessage | ClientMessage;

/**
 * Connection types
 */
export type ConnectionRole = "agent" | "client";

export interface ClusterConnection {
  ws: WebSocket;
  role: ConnectionRole;
  clusterId: string;
  session?: Session;
  connectionId: string;
  connectedAt: number;
}

export interface LogStreamSubscription {
  ws: WebSocket;
  streamId: string;
  path: string;
  startOffset?: number;
  limit?: number;
  duration?: string;
}

export interface FileNode {
  path: string;
  name: string;
  type: "file" | "directory";
  readable: boolean;
  writable: boolean;
  size?: number;
  modified?: number;
  children?: FileNode[];
}

export interface FileReadRequest {
  path: string;
}

export interface FileWriteRequest {
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface FileCreateRequest {
  path: string;
  type: "file" | "directory";
}

export interface FileDeleteRequest {
  path: string;
}

export interface FileTreeResponse {
  root: FileNode;
}

/**
 * Pending request tracking
 */
export interface PendingRequest {
  requestId: string;
  taskId: string;
  ws: WebSocket;
  clusterId: string;
  kind: string;
  createdAt: number;
  timeoutMs: number;
}

/**
 * Create error response helper
 */
export function createWSError(
  requestId: string,
  code: WSErrorCode,
  message: string,
  details?: Record<string, unknown>
): WSErrorResponse {
  return {
    kind: "error",
    requestId,
    code,
    message,
    details,
    timestamp: Date.now(),
  };
}

/**
 * Parse and validate an inbound message
 */
export function parseMessage(data: unknown): BaseMessage | null {
  try {
    const payload = JSON.parse(String(data));
    if (typeof payload?.kind !== "string") {
      return null;
    }
    return payload as BaseMessage;
  } catch {
    return null;
  }
}

/**
 * Validate request message has required requestId
 */
export function validateRequestMessage(msg: BaseMessage): msg is BaseRequestMessage {
  return typeof msg.requestId === "string" && msg.requestId.length > 0;
}

/**
 * Type guards for message types
 */
export function isAgentBroadcastMessage(msg: BaseMessage): msg is UpdateMessage {
  return msg.kind === MessageKind.UPDATE;
}

export function isLogChunkMessage(msg: BaseMessage): msg is LogChunkMessage {
  return msg.kind === MessageKind.LOG_CHUNK;
}

export function isTaskResponseMessage(msg: BaseMessage): msg is TaskResponseMessage {
  return msg.kind === MessageKind.TASK_RESPONSE;
}

export function isClientSubscribeMessage(msg: BaseMessage): msg is ClientSubscribeMessage {
  return msg.kind === MessageKind.CLIENT_SUBSCRIBE;
}

export function isLogSubscribeMessage(msg: BaseMessage): msg is LogSubscribeMessage {
  return msg.kind === MessageKind.LOG_SUBSCRIBE;
}

export function isLogUnsubscribeMessage(msg: BaseMessage): msg is LogUnsubscribeMessage {
  return msg.kind === MessageKind.LOG_UNSUBSCRIBE;
}

export function isDeployMessage(msg: BaseMessage): msg is DeployMessage {
  return msg.kind === MessageKind.DEPLOY;
}

export function isServiceCreateMessage(msg: BaseMessage): msg is ServiceCreateMessage {
  return msg.kind === MessageKind.SERVICE_CREATE;
}

export function isServiceRemoveMessage(msg: BaseMessage): msg is ServiceRemoveMessage {
  return msg.kind === MessageKind.SERVICE_REMOVE;
}

export function isDeploymentListMessage(msg: BaseMessage): msg is DeploymentListMessage {
  return msg.kind === MessageKind.DEPLOYMENT_LIST;
}

export function isLogStreamMessage(msg: BaseMessage): msg is LogStreamMessage {
  return msg.kind === MessageKind.LOG_STREAM;
}

export function isFileReadMessage(msg: BaseMessage): msg is FileReadMessage {
  return msg.kind === MessageKind.FILE_READ;
}

export function isFileWriteMessage(msg: BaseMessage): msg is FileWriteMessage {
  return msg.kind === MessageKind.FILE_WRITE;
}

export function isFileCreateMessage(msg: BaseMessage): msg is FileCreateMessage {
  return msg.kind === MessageKind.FILE_CREATE;
}

export function isFileDeleteMessage(msg: BaseMessage): msg is FileDeleteMessage {
  return msg.kind === MessageKind.FILE_DELETE;
}

export function isFileTreeMessage(msg: BaseMessage): msg is FileTreeMessage {
  return msg.kind === MessageKind.FILE_TREE;
}

export function isFileWatchMessage(msg: BaseMessage): msg is FileWatchMessage {
  return msg.kind === MessageKind.FILE_WATCH;
}

export function isFileUnwatchMessage(msg: BaseMessage): msg is FileUnwatchMessage {
  return msg.kind === MessageKind.FILE_UNWATCH;
}

export function isFileUpdateMessage(msg: BaseMessage): msg is FileUpdateMessage {
  return msg.kind === MessageKind.FILE_UPDATE;
}

export function isAckMessage(msg: BaseMessage): msg is AckMessage {
  return msg.kind === MessageKind.ACK;
}

export function isInstanceTokenRotateMessage(msg: BaseMessage): msg is InstanceTokenRotateMessage {
  return msg.kind === MessageKind.INSTANCE_TOKEN_ROTATE;
}

export function isInstanceSystemInstallMessage(msg: BaseMessage): msg is InstanceSystemInstallMessage {
  return msg.kind === MessageKind.INSTANCE_SYSTEM_INSTALL;
}

export function isInstanceSystemRebootMessage(msg: BaseMessage): msg is InstanceSystemRebootMessage {
  return msg.kind === MessageKind.INSTANCE_SYSTEM_REBOOT;
}

export function isInstanceSystemRestartMessage(msg: BaseMessage): msg is InstanceSystemRestartMessage {
  return msg.kind === MessageKind.INSTANCE_SYSTEM_RESTART;
}

export function isProxyStatusMessage(msg: BaseMessage): msg is ProxyStatusMessage {
  return msg.kind === MessageKind.PROXY_STATUS;
}

export function isProxyRestartMessage(msg: BaseMessage): msg is ProxyRestartMessage {
  return msg.kind === MessageKind.PROXY_RESTART;
}

export function isProxyAddMessage(msg: BaseMessage): msg is ProxyAddMessage {
  return msg.kind === MessageKind.PROXY_ADD;
}

export function isProxyRemoveMessage(msg: BaseMessage): msg is ProxyRemoveMessage {
  return msg.kind === MessageKind.PROXY_REMOVE;
}

/**
 * Type guards for file operation request/response types
 */
export function isFileReadRequest(msg: unknown): msg is FileReadRequest {
  return typeof msg === "object" && msg !== null && "path" in msg && typeof (msg as FileReadRequest).path === "string" && Object.keys(msg).length === 1;
}

export function isFileWriteRequest(msg: unknown): msg is FileWriteRequest {
  const m = msg as FileWriteRequest;
  return typeof msg === "object" && msg !== null && "path" in msg && "content" in msg && typeof m.path === "string" && typeof m.content === "string" && (!m.encoding || m.encoding === "utf8" || m.encoding === "base64");
}

export function isFileCreateRequest(msg: unknown): msg is FileCreateRequest {
  const m = msg as FileCreateRequest;
  return typeof msg === "object" && msg !== null && "path" in msg && "type" in msg && typeof m.path === "string" && (m.type === "file" || m.type === "directory");
}

export function isFileDeleteRequest(msg: unknown): msg is FileDeleteRequest {
  return typeof msg === "object" && msg !== null && "path" in msg && typeof (msg as FileDeleteRequest).path === "string" && Object.keys(msg).length === 1;
}

export function isFileTreeResponse(msg: unknown): msg is FileTreeResponse {
  return typeof msg === "object" && msg !== null && "root" in msg && typeof (msg as FileTreeResponse).root === "object";
}

export function isFileNode(msg: unknown): msg is FileNode {
  const m = msg as FileNode;
  return typeof msg === "object" && msg !== null && "path" in msg && "name" in msg && "type" in msg && "readable" in msg && "writable" in msg && typeof m.path === "string" && typeof m.name === "string" && (m.type === "file" || m.type === "directory") && typeof m.readable === "boolean" && typeof m.writable === "boolean";
}

export function canRead(node: FileNode): boolean {
  return node.readable;
}

export function canWrite(node: FileNode): boolean {
  return node.writable;
}

export function canEditFile(node: FileNode): boolean {
  return node.type === "file" && canWrite(node);
}

export function canDeleteFile(parentNode: FileNode | undefined): boolean {
  return parentNode ? canWrite(parentNode) : false;
}

export function canCreateInDirectory(node: FileNode): boolean {
  return node.type === "directory" && canWrite(node);
}

export function getFileOperationPermissions(node: FileNode, parentNode?: FileNode) {
  return {
    canView: canRead(node),
    canEdit: canEditFile(node),
    canDelete: canDeleteFile(parentNode),
    canCreateChildren: canCreateInDirectory(node),
  };
}

