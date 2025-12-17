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
export type LogStreamMode = "tail" | "head";

export interface LogStreamMessage extends BaseMessage {
  kind: typeof MessageKind.LOG_STREAM;
  token: string;
  path: string;
  streamId: string;
  mode: LogStreamMode;
  startFrom: number;
}

export type ClientMessage = ClientSubscribeMessage | LogSubscribeMessage | LogUnsubscribeMessage | DeployMessage | LogStreamMessage;

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
