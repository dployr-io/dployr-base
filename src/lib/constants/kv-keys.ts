// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// Key values for KVStore
export const KV_KEYS = {
  VERSION_LATEST: "version:latest",
  JWT_KEYS: "jwt_keys",
  SESSION: (id: string) => `session:${id}`,
  SESSION_BY_USER: (userId: string) => `session:user:${userId}`,
  EVENT_IDEM: (type: string, actorId: string, ray: string, targetScope: string) => `event:idem:${type}:${actorId}:${ray}:${targetScope}`,
  ACTOR_EVENT: (actorId: string, eventId: string) => `actor:${actorId}:event:${eventId}`,
  TARGET_EVENT: (targetId: string, eventId: string) => `target:${targetId}:event:${eventId}`,
  WORKFLOW: (id: string) => `workflow:${id}`,
  STATE: (state: string) => `state:${state}`,
  OTP: (email: string) => `otp:${email}`,
  DOMAIN: (domain: string) => `domain:${domain}`,
  NODE_UPDATE: (instanceId: string) => `node:${instanceId}:update`,
  PENDING_GITHUB_INSTALL: (userId: string) => `pending_github_install:${userId}`,
  INSTANCE_BY_ID: (id: string) => `instance:id:${id}`,
  INSTANCE_BY_NAME: (clusterId: string, tag: string) => `instance:name:${clusterId}:${tag}`,
  INSTANCE_BY_TAG: (tag: string) => `instance:tag:${tag}`,
  SERVICES: (instanceId: string) => `services:${instanceId}`,
  PROCESS_SNAPSHOT: (instanceId: string, timestamp: number) => `process:${instanceId}:snapshot:${timestamp}`,
  ADMIN_JWT: (sessionId: string) => `admin_jwt:${sessionId}`,
  BILLING_NOTIFICATION: (clusterId: string) => `billing_notification:${clusterId}`,
} as const;
