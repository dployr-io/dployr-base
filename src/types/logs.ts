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
 * Log chunk sent from daemon to base via WebSocket
 */
export interface LogChunk {
  streamId: string;
  logType: "app" | "install";
  entries: LogEntry[];
  eof: boolean;
  hasMore: boolean;
  offset: number;
}

/**
 * Stream mode
 */
export type StreamMode = "tail" | "historical";

/**
 * Log stream options
 */
export interface StreamOptions {
  streamId: string;
  logType: "app" | "install";
  mode: StreamMode;
  startFrom: number; // Byte offset: 0=start, -1=end
  limit: number; // Max entries (historical mode)
}

/**
 * Client subscription message
 */
export interface LogSubscribeMessage {
  kind: "log_subscribe";
  streamId: string;
  logType: "app" | "install";
}

/**
 * Client subscription acknowledgment
 */
export interface LogSubscribedMessage {
  kind: "log_subscribed";
  streamId: string;
  logType: "app" | "install";
}

/**
 * Log chunk message (WebSocket)
 */
export interface LogChunkMessage {
  kind: "log_chunk";
  streamId: string;
  logType: "app" | "install";
  entries: LogEntry[];
  eof: boolean;
  hasMore: boolean;
  offset: number;
  timestamp: number;
}

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
  logType: z.enum(["app", "install"]),
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
  logType: z.enum(["app", "install"]),
  mode: z.enum(["tail", "historical"]),
  startFrom: z.number(),
  limit: z.number().min(1).max(1000),
});
