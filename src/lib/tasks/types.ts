// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export type HttpMethod =
  | "get"
  | "post"
  | "put"
  | "patch"
  | "delete";

// Canonical task address: path + ":" + lowercase HTTP method
// Examples:
// - "system/status:put"
// - "deployments?showCompleted=false:get"
export type TaskAddress = `${string}:${HttpMethod}`;

// Task status
export type TaskStatus = "pending" | "in_progress" | "done" | "failed";

// Base Task structure that daemon expects
export interface DaemonTask {
  ID: string;
  Type: TaskAddress;
  Payload: any;
  Status: TaskStatus;
}

// Log streaming task payload
export const LogStreamPayloadSchema = z.object({
  path: z.string().min(1),
  startOffset: z.number().int().optional(),
  limit: z.number().int().optional(),
  streamId: z.string().min(1),
});

export type LogStreamPayload = z.infer<typeof LogStreamPayloadSchema>;

// WebSocket message types for agent communication
export const AgentTaskMessageSchema = z.object({
  kind: z.literal("task"),
  items: z.array(z.object({
    ID: z.string(),
    Type: z.string(),
    Payload: z.any(),
    Status: z.string(),
  })),
});

export const AgentPullMessageSchema = z.object({
  kind: z.literal("pull"),
});

export const AgentAckMessageSchema = z.object({
  kind: z.literal("ack"),
  ids: z.array(z.string()),
});

export type AgentTaskMessage = z.infer<typeof AgentTaskMessageSchema>;
export type AgentPullMessage = z.infer<typeof AgentPullMessageSchema>;
export type AgentAckMessage = z.infer<typeof AgentAckMessageSchema>;

// Helper to create a log streaming task
export function createLogStreamTask(
  streamId: string,
  path: string,
  startOffset?: number,
  limit?: number
): DaemonTask {
  return {
    ID: streamId,
    Type: "logs/stream:post",
    Payload: {
      path,
      startOffset,
      limit,
      streamId,
    },
    Status: "pending",
  };
}
