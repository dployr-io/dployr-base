// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { WebSocket } from "ws";
import type { DeploymentPayload } from "@/lib/tasks/types.js";
import type { Session } from "@/types/index.js";

/**
 * Message kind constants
 */
export const MessageKind = {
  // Agent -> Server
  UPDATE: "update",
  LOG_CHUNK: "log_chunk",

  // Client -> Server
  CLIENT_SUBSCRIBE: "client_subscribe",
  LOG_SUBSCRIBE: "log_subscribe",
  LOG_UNSUBSCRIBE: "log_unsubscribe",
  LOG_STREAM: "log_stream",
  DEPLOY: "deploy",
  FILE_READ: "file_read",
  FILE_WRITE: "file_write",
  FILE_CREATE: "file_create",
  FILE_DELETE: "file_delete",
  FILE_TREE: "file_tree",

  // Server -> Agent
  TASK: "task",
} as const;

export type MessageKindType = (typeof MessageKind)[keyof typeof MessageKind];

/**
 * Base message interface
 */
export interface BaseMessage {
  kind: string;
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

export type AgentMessage = UpdateMessage | LogChunkMessage;

/**
 * Client messages
 */
export interface ClientSubscribeMessage extends BaseMessage {
  kind: typeof MessageKind.CLIENT_SUBSCRIBE;
}

export interface LogSubscribeMessage extends BaseMessage {
  kind: typeof MessageKind.LOG_SUBSCRIBE;
  instanceId: string;
  path: string;
  startOffset?: number;
  limit?: number;
  duration?: string;
}

export interface LogUnsubscribeMessage extends BaseMessage {
  kind: typeof MessageKind.LOG_UNSUBSCRIBE;
  path?: string;
}

export interface DeployMessage extends BaseMessage {
  kind: typeof MessageKind.DEPLOY;
  instanceId: string;
  payload: DeploymentPayload;
}

/**
 * Log stream message for deployment/service logs
 * path formats:
 *   - "<deployment-id>" for deployment logs
 *   - "service:<service-name>" for service logs
 */

export interface LogStreamMessage extends BaseMessage {
  kind: typeof MessageKind.LOG_STREAM;
  token: string;
  path: string;
  streamId: string;
  startFrom: number;
  duration: string;
}

/**
 * File operation messages
 */
export interface FileReadMessage extends BaseMessage {
  kind: typeof MessageKind.FILE_READ;
  instanceId: string;
  path: string;
}

export interface FileWriteMessage extends BaseMessage {
  kind: typeof MessageKind.FILE_WRITE;
  instanceId: string;
  path: string;
  content: string;
  encoding?: "utf8" | "base64";
}

export interface FileCreateMessage extends BaseMessage {
  kind: typeof MessageKind.FILE_CREATE;
  instanceId: string;
  path: string;
  type: "file" | "directory";
}

export interface FileDeleteMessage extends BaseMessage {
  kind: typeof MessageKind.FILE_DELETE;
  instanceId: string;
  path: string;
}

export interface FileTreeMessage extends BaseMessage {
  kind: typeof MessageKind.FILE_TREE;
  instanceId: string;
  path?: string;
}

export type ClientMessage = ClientSubscribeMessage | LogSubscribeMessage | LogUnsubscribeMessage | DeployMessage | LogStreamMessage | FileReadMessage | FileWriteMessage | FileCreateMessage | FileDeleteMessage | FileTreeMessage;

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
 * Type guards for message types
 */
export function isAgentBroadcastMessage(msg: BaseMessage): msg is UpdateMessage {
  return msg.kind === MessageKind.UPDATE;
}

export function isLogChunkMessage(msg: BaseMessage): msg is LogChunkMessage {
  return msg.kind === MessageKind.LOG_CHUNK;
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

