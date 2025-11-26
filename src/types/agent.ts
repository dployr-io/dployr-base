import { z } from "zod";
import { LATEST_COMPATIBILITY_DATE as _LATEST_COMPATIBILITY_DATE } from "@/lib/constants";

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
  version: z.string(),
  compatibility_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  platform: z.object({
    os: z.string(),
    arch: z.string(),
    hostname: z.string().optional(),
  }),
  runtime: z.object({
    uptime: z.number(),
    services: z.record(z.string(), z.unknown()).optional(),
  }).optional(),
});

export type AgentUpdateV1 = z.infer<typeof AgentUpdateV1Schema>;

export type WSHandshakeResponse = 
  | { kind: "hello"; status: "accepted"; upgrade_available?: { level: "major" | "minor"; latest: string } }
  | { kind: "hello"; status: "rejected"; reason: "incompatible"; required: string; received: string };
