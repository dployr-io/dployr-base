// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Log entry structure - parsed from JSON log lines
 */
export interface LogEntry {
  time: string;
  level: "DEBUG" | "INFO" | "WARN" | "ERROR";
  msg: string;
  [key: string]: any; // Dynamic slog attributes
}

/**
 * Stream mode
 */
export type StreamMode = "tail" | "historical";

/**
 * Zod schema for log entry validation
 */
export const LogEntrySchema = z.object({
  time: z.string(),
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
  msg: z.string(),
}).catchall(z.any()); // Allow additional dynamic slog attributes

/**
 * Zod schema for log chunk validation
 */
export const LogChunkSchema = z.object({
  streamId: z.string(),
  path: z.string(),
  entries: z.array(LogEntrySchema),
  eof: z.boolean(),
  hasMore: z.boolean(),
  offset: z.number(),
});

/**
 * Zod schema for stream options validation
 */
export const StreamOptionsSchema = z.object({
  streamId: z.string(),
  path: z.string(),
  mode: z.enum(["tail", "historical"]),
  startFrom: z.number(),
  limit: z.number().min(1).max(1000),
});
