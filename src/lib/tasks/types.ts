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
export interface AgentTask {
  ID: string;
  Type: TaskAddress;
  Payload: any;
  Status: TaskStatus;
}

// Log streaming task payload
export const LogStreamSchema = z.object({
  path: z.string().min(1),
  startOffset: z.number().int().optional(),
  limit: z.number().int().optional(),
  streamId: z.string().min(1),
});

// Deployment task payload
export const DeploymentSchema = z.object({
  name: z.string().min(1, "Name is required"),
  description: z.string().optional(),
  userId: z.string().min(1, "User ID is required"),
  source: z.enum(["remote", "image"], { message: "Source must be either 'remote' or 'image'" }),
  runtime: z.string().min(1, "Runtime is required"),
  version: z.string().optional(),
  runCmd: z.string().optional(),
  buildCmd: z.string().optional(),
  port: z.number().int().positive().optional(),
  workingDir: z.string().optional(),
  staticDir: z.string().optional(),
  image: z.string().optional(),
  envVars: z.record(z.string(), z.string()).optional(),
  secrets: z.record(z.string(), z.string()).optional(),
  remote: z.record(z.string(), z.any()).optional(),
  domain: z.string().optional(),
});

// WebSocket message types for agent communication
export const AgentTaskSchema = z.object({
  kind: z.literal("task"),
  items: z.array(z.object({
    ID: z.string(),
    Type: z.string(),
    Payload: z.any(),
    Status: z.string(),
  })),
});

export const AgentPullSchema = z.object({
  kind: z.literal("pull"),
});

export const AgentAckSchema = z.object({
  kind: z.literal("ack"),
  ids: z.array(z.string()),
});

export type LogStreamPayload = z.infer<typeof LogStreamSchema>;
export type DeploymentPayload = z.infer<typeof DeploymentSchema>;
export type AgentTaskMessage = z.infer<typeof AgentTaskSchema>;
export type AgentPullMessage = z.infer<typeof AgentPullSchema>;
export type AgentAckMessage = z.infer<typeof AgentAckSchema>;

// System install task payload
export const SystemInstallSchema = z.object({
  version: z.string().optional(),
});

export type SystemInstallPayload = z.infer<typeof SystemInstallSchema>;

// System restart task payload
export const SystemRestartSchema = z.object({
  force: z.boolean().optional().default(false),
});

export type SystemRestartPayload = z.infer<typeof SystemRestartSchema>;
