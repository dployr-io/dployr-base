// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";
import { LATEST_COMPATIBILITY_DATE as _LATEST_COMPATIBILITY_DATE } from "@/lib/constants/index.js";

export const LATEST_COMPATIBILITY_DATE = _LATEST_COMPATIBILITY_DATE;

export const CompletedTaskSchema = z.object({
  id: z.string(),
  status: z.enum(["done", "failed"]),
  result: z.record(z.string(), z.unknown()).optional(),
  error: z.string().optional(),
});

export const AgentStatusReportSchema = z.object({
  version: z.string(),
  compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  system: z.record(z.string(), z.unknown()),
  completed_tasks: z.array(CompletedTaskSchema).default([]),
});

export type AgentStatusReport = z.infer<typeof AgentStatusReportSchema>;
export type CompletedTask = z.infer<typeof CompletedTaskSchema>;

// WebSocket message schemas
export const AgentUpdateV1Schema = z.object({
  schema: z.literal("v1"),
  seq: z.number(),
  epoch: z.string(),
  full: z.boolean(),
  instance_id: z.string(),
  build_info: z.object({
    version: z.string(),
    commit: z.string(),
    date: z.string(),
    go_version: z.string(),
  }).optional(),
  platform: z.object({
    os: z.string(),
    arch: z.string(),
    hostname: z.string().optional(),
  }),
  status: z.string(),
  mode: z.string(),
  uptime: z.string(),
  deployments: z.array(z.record(z.string(), z.unknown())).optional(),
  services: z.array(z.record(z.string(), z.unknown())).optional(),
  proxies: z.array(z.unknown()).optional(),
  proxy: z.record(z.string(), z.unknown()).optional(),
  health: z.record(z.string(), z.unknown()).optional(),
  debug: z.record(z.string(), z.unknown()).optional(),
  fs: z.record(z.string(), z.unknown()).optional(),
  top: z.record(z.string(), z.unknown()).optional(),
});

export type AgentUpdateV1 = z.infer<typeof AgentUpdateV1Schema>;

// v1.1 Schema - Restructured and comprehensive
export const AgentUpdateV1_1Schema = z.object({
  schema: z.literal("v1.1"),
  sequence: z.number(),
  epoch: z.string(),
  instance_id: z.string(),
  timestamp: z.string(),
  is_full_sync: z.boolean(),

  agent: z.object({
    version: z.string(),
    commit: z.string(),
    build_date: z.string(),
    go_version: z.string(),
    os: z.string(),
    arch: z.string(),
  }).optional(),

  status: z.object({
    state: z.string(),
    mode: z.string(),
    uptime_seconds: z.number(),
  }).optional(),

  health: z.object({
    overall: z.string(),
    websocket: z.string().optional(),
    tasks: z.string().optional(),
    proxy: z.string().optional(),
    auth: z.string().optional(),
  }).optional(),

  resources: z.object({
    cpu: z.object({
      count: z.number(),
      user_percent: z.number(),
      system_percent: z.number(),
      idle_percent: z.number(),
      iowait_percent: z.number(),
      load_average: z.object({
        one_minute: z.number(),
        five_minute: z.number(),
        fifteen_minute: z.number(),
      }),
    }).optional(),
    memory: z.object({
      total_bytes: z.number(),
      used_bytes: z.number(),
      free_bytes: z.number(),
      available_bytes: z.number(),
      buffer_cache_bytes: z.number(),
    }).optional(),
    swap: z.object({
      total_bytes: z.number(),
      used_bytes: z.number(),
      free_bytes: z.number(),
      available_bytes: z.number(),
    }).optional(),
    disks: z.array(z.object({
      filesystem: z.string(),
      mount_point: z.string(),
      total_bytes: z.number(),
      used_bytes: z.number(),
      available_bytes: z.number(),
    })).optional(),
  }).optional(),

  workloads: z.object({
    deployments: z.array(z.record(z.string(), z.unknown())).optional(),
    services: z.array(z.record(z.string(), z.unknown())).optional(),
  }).optional(),

  proxy: z.object({
    type: z.string(),
    status: z.string(),
    version: z.string().optional(),
    route_count: z.number().optional(),
    routes: z.array(z.object({
      domain: z.string(),
      upstream: z.string(),
      template: z.string(),
      root: z.string().nullable().optional(),
      status: z.string(),
    })).optional(),
  }).optional(),

  processes: z.object({
    summary: z.object({
      total: z.number(),
      running: z.number(),
      sleeping: z.number(),
      stopped: z.number(),
      zombie: z.number(),
    }).optional(),
    list: z.array(z.object({
      pid: z.number(),
      user: z.string(),
      priority: z.number(),
      nice: z.number(),
      virtual_memory_bytes: z.number(),
      resident_memory_bytes: z.number(),
      shared_memory_bytes: z.number(),
      state: z.string(),
      cpu_percent: z.number(),
      memory_percent: z.number(),
      cpu_time: z.string(),
      command: z.string(),
    })).optional(),
  }).optional(),

  filesystem: z.object({
    generated_at: z.string(),
    is_stale: z.boolean(),
    roots: z.array(z.object({
      path: z.string(),
      name: z.string(),
      type: z.string(),
      size_bytes: z.number(),
      modified_at: z.string(),
      permissions: z.object({
        mode: z.string(),
        owner: z.string(),
        group: z.string(),
        uid: z.number(),
        gid: z.number(),
        readable: z.boolean(),
        writable: z.boolean(),
        executable: z.boolean(),
      }),
      children: z.array(z.any()).nullable().optional(),
      is_truncated: z.boolean(),
      total_children: z.number(),
    })),
  }).optional(),

  diagnostics: z.object({
    websocket: z.object({
      is_connected: z.boolean(),
      last_connected_at: z.string(),
      reconnect_count: z.number(),
      last_error: z.string().nullable(),
    }).optional(),
    tasks: z.object({
      inflight_count: z.number(),
      unsent_count: z.number(),
      last_task_id: z.string().optional(),
      last_task_status: z.string().optional(),
      last_task_duration_ms: z.number().optional(),
      last_task_at: z.string().optional(),
    }).optional(),
    auth: z.object({
      token_age_seconds: z.number(),
      token_expires_in_seconds: z.number(),
      bootstrap_token_preview: z.string().optional(),
    }).optional(),
    worker: z.object({
      max_concurrent: z.number(),
      active_jobs: z.number(),
    }).optional(),
    cert: z.object({
      not_after: z.string(),
      days_remaining: z.number(),
    }).optional(),
  }).optional(),
});

export type AgentUpdateV1_1 = z.infer<typeof AgentUpdateV1_1Schema>;

// Union type for all agent update versions
export const AgentUpdateSchema = z.discriminatedUnion("schema", [
  AgentUpdateV1Schema,
  AgentUpdateV1_1Schema,
]);

export type AgentUpdate = z.infer<typeof AgentUpdateSchema>;

export type WSHandshakeResponse = 
  | { kind: "hello"; status: "accepted"; upgrade_available?: { level: "major" | "minor"; latest: string } }
  | { kind: "hello"; status: "rejected"; reason: "incompatible"; required: string; received: string };
