// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { WSErrorCode } from "./message-types.js";

/**
 * Runtime validation schemas for WebSocket messages
 */

// Base message schema
const BaseMessageSchema = z.object({
  kind: z.string(),
  requestId: z.string().optional(),
});

// File operation schemas
export const FileReadMessageSchema = z.object({
  kind: z.literal("file_read"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  path: z.string().min(1),
});

export const FileWriteMessageSchema = z.object({
  kind: z.literal("file_write"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  path: z.string().min(1),
  content: z.string(),
  encoding: z.enum(["utf8", "base64"]).optional(),
});

export const FileCreateMessageSchema = z.object({
  kind: z.literal("file_create"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  path: z.string().min(1),
  type: z.enum(["file", "directory"]),
});

export const FileDeleteMessageSchema = z.object({
  kind: z.literal("file_delete"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  path: z.string().min(1),
});

export const FileTreeMessageSchema = z.object({
  kind: z.literal("file_tree"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  path: z.string().optional(),
});

// Agent response schemas
export const TaskResponseSchema = z.object({
  kind: z.literal("task_response"),
  taskId: z.string().min(1),
  requestId: z.string().min(1),
  success: z.boolean(),
  data: z.unknown().optional(),
  error: z.object({
    code: z.enum(WSErrorCode),
    message: z.string(),
  }).optional(),
});

export const FileNodeSchema: z.ZodType<any> = z.lazy(() =>
  z.object({
    path: z.string(),
    name: z.string(),
    type: z.enum(["file", "directory"]),
    readable: z.boolean(),
    writable: z.boolean(),
    size: z.number().optional(),
    modified: z.number().optional(),
    children: z.array(FileNodeSchema).optional(),
  })
);

export const FileReadResponseSchema = z.object({
  kind: z.literal("file_read_response"),
  requestId: z.string(),
  taskId: z.string(),
  success: z.boolean(),
  content: z.string().optional(),
  encoding: z.enum(["utf8", "base64"]).optional(),
  error: z.object({
    code: z.enum(WSErrorCode),
    message: z.string(),
  }).optional(),
});

export const FileTreeResponseSchema = z.object({
  kind: z.literal("file_tree_response"),
  requestId: z.string(),
  taskId: z.string(),
  success: z.boolean(),
  root: FileNodeSchema.optional(),
  error: z.object({
    code: z.enum(WSErrorCode),
    message: z.string(),
  }).optional(),
});

// Instance operation schemas
export const InstanceListMessageSchema = z.object({
  kind: z.literal("instance_list"),
  requestId: z.string().min(1),
  clusterId: z.string().min(1),
  page: z.number().int().positive().optional(),
  pageSize: z.number().int().positive().optional(),
});

export const InstanceCreateMessageSchema = z.object({
  kind: z.literal("instance_create"),
  requestId: z.string().min(1),
  clusterId: z.string().min(1),
  address: z.string().regex(
    /^(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d{2}|[1-9]?\d)){3}$/,
    "Address must be a valid IPv4 address"
  ),
  tag: z.string().min(3).max(15),
});

export const InstanceDeleteMessageSchema = z.object({
  kind: z.literal("instance_delete"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  clusterId: z.string().min(1),
});

export const InstanceTokenRotateMessageSchema = z.object({
  kind: z.literal("instance_token_rotate"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  token: z.string().min(1),
});

export const InstanceSystemInstallMessageSchema = z.object({
  kind: z.literal("instance_system_install"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  clusterId: z.string().min(1),
  version: z.string().optional(),
});

export const InstanceSystemRebootMessageSchema = z.object({
  kind: z.literal("instance_system_reboot"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  clusterId: z.string().min(1),
  force: z.boolean().optional(),
});

export const InstanceSystemRestartMessageSchema = z.object({
  kind: z.literal("instance_system_restart"),
  requestId: z.string().min(1),
  instanceId: z.string().min(1),
  clusterId: z.string().min(1),
  force: z.boolean().optional(),
});

/**
 * Validate and parse a message with proper error handling
 */
export function validateMessage<T>(
  schema: z.ZodType<T>,
  data: unknown
): { success: true; data: T } | { success: false; error: string } {
  const result = schema.safeParse(data);
  if (result.success) {
    return { success: true, data: result.data };
  }
  const errorMessage = result.error.issues
    .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
    .join(", ");
  return { success: false, error: errorMessage };
}

/**
 * Get the appropriate schema for a message kind
 */
export function getSchemaForKind(kind: string): z.ZodType<any> | null {
  switch (kind) {
    case "file_read":
      return FileReadMessageSchema;
    case "file_write":
      return FileWriteMessageSchema;
    case "file_create":
      return FileCreateMessageSchema;
    case "file_delete":
      return FileDeleteMessageSchema;
    case "file_tree":
      return FileTreeMessageSchema;
    case "task_response":
      return TaskResponseSchema;
    case "instance_list":
      return InstanceListMessageSchema;
    case "instance_create":
      return InstanceCreateMessageSchema;
    case "instance_delete":
      return InstanceDeleteMessageSchema;
    case "instance_token_rotate":
      return InstanceTokenRotateMessageSchema;
    case "instance_system_install":
      return InstanceSystemInstallMessageSchema;
    case "instance_system_reboot":
      return InstanceSystemRebootMessageSchema;
    case "instance_system_restart":
      return InstanceSystemRestartMessageSchema;
    default:
      return null;
  }
}
