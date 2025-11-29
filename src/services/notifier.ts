// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// Import and re-export event codes from constants for notification system
import { EVENTS } from "@/lib/constants";
export { EVENTS };

// Derive notification event codes from EVENTS groups we care about
type AuthEvent = (typeof EVENTS)["AUTH"][keyof (typeof EVENTS)["AUTH"]]["code"];
type ClusterEvent = (typeof EVENTS)["CLUSTER"][keyof (typeof EVENTS)["CLUSTER"]]["code"];
type InstanceEvent = (typeof EVENTS)["INSTANCE"][keyof (typeof EVENTS)["INSTANCE"]]["code"];

export type NotificationEvent = AuthEvent | ClusterEvent | InstanceEvent;

export type EventSubscriptions = Record<NotificationEvent, boolean>;

export interface EventMetadata {
  title: string;
  description: (data: Record<string, any>) => string;
  color?: number;
  category: "instance" | "cluster" | "user" | "auth";
}

export type EventMetadataMap = Record<NotificationEvent, EventMetadata>;

export interface NotificationPayload {
  webhookUrl?: string;
  event: NotificationEvent;
  data: Record<string, any>;
  headers?: Record<string, string>;
  method?: string;
  timeoutMs?: number;
  to?: string;
}

export interface Notifier {
  sendNotification(payload: NotificationPayload): Promise<void>;
}
