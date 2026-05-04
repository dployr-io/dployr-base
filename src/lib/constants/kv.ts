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
  PROCESS_SNAPSHOT: (instanceId: string, timestamp?: number) =>
    timestamp !== undefined ? `process:${instanceId}:snapshot:${timestamp}` : `process:${instanceId}:snapshot:`,
  ADMIN_JWT: (sessionId: string) => `admin_jwt:${sessionId}`,
  BILLING_NOTIFICATION: (clusterId: string) => `billing_notification:${clusterId}`,
  FREE_INSTANCE_POOL: "free_instance:pool",
  FREE_INSTANCE_CLUSTER: (clusterId: string) => `free_instance:cluster:${clusterId}`,
  FREE_INSTANCE_COUNTER: (instanceId: string) => `free_instance:counter:${instanceId}`,
  POOL_PROVISION_LOCK: "pool:provision:lock",
  NODE_CONNECTED: (tag: string) => `node:connected:${tag}`,
  INSTANCE_DECOMMISSION_RECOVERY_WINDOW: (instanceId: string) => `recovery_window:${instanceId}`,
  CLUSTER_NODE: (clusterId: string, instanceId: string) => `cluster:${clusterId}:nodes:${instanceId}`,
  CLUSTER_NODES_PREFIX: (clusterId: string) => `cluster:${clusterId}:nodes:`,
  TRAEFIK_ROUTER_RULE: (routeKey: string) => `traefik/http/routers/${routeKey}/rule`,
  TRAEFIK_ROUTER_ENTRYPOINTS: (routeKey: string) => `traefik/http/routers/${routeKey}/entrypoints`,
  TRAEFIK_ROUTER_SERVICE: (routeKey: string) => `traefik/http/routers/${routeKey}/service`,
  TRAEFIK_SERVICE_URL: (routeKey: string) => `traefik/http/services/${routeKey}/loadbalancer/servers/0/url`,
} as const;
