// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { NodeStateEntity } from "./node-state.js";

export const KV_KEYS = {
  VERSION: {
    LATEST: "version:latest",
  },
  AUTH: {
    JWT_KEYS: "jwt_keys",
    ADMIN_JWT: (sessionId: string) => `admin_jwt:${sessionId}`,
  },
  SESSION: {
    BY_ID: (id: string) => `session:${id}`,
    BY_USER: (userId: string) => `session:user:${userId}`,
  },
  EVENT: {
    IDEM: (type: string, actorId: string, ray: string, targetScope: string) =>
      `event:idem:${type}:${actorId}:${ray}:${targetScope}`,
    ACTOR: (actorId: string, eventId: string) => `actor:${actorId}:event:${eventId}`,
    TARGET: (targetId: string, eventId: string) => `target:${targetId}:event:${eventId}`,
  },
  WORKFLOW: {
    BY_ID: (id: string) => `workflow:${id}`,
    STATE: (state: string) => `state:${state}`,
  },
  PAYLOAD: {
    DEPLOYMENT: (clusterId: string, name: string) => `payload:deployment:${clusterId}:${name}`,
    DEPLOYMENTS_PREFIX: (clusterId: string) => `payload:deployment:${clusterId}:`,
  },
  OTP: {
    BY_EMAIL: (email: string) => `otp:${email}`,
  },
  DOMAIN: {
    BY_NAME: (domain: string) => `domain:${domain}`,
  },
  INSTANCE: {
    BY_ID: (id: string) => `instance:id:${id}`,
    BY_NAME: (clusterId: string, tag: string) => `instance:name:${clusterId}:${tag}`,
    BY_TAG: (tag: string) => `instance:tag:${tag}`,
    DECOMMISSION_RECOVERY_WINDOW: (instanceId: string) => `recovery_window:${instanceId}`,
    ENTITY: (instanceId: string, entity: NodeStateEntity) => `instance:${instanceId}:${entity}`,
    DISK_WARN_SENT: (tag: string) => `instance:disk_warn:${tag}`,
    VOLUME_PROVISIONING: (tag: string) => `instance:volume_provisioning:${tag}`,
  },
  SERVICES: {
    BY_INSTANCE: (instanceId: string) => `services:${instanceId}`,
  },
  SERVICE: {
    SLEEPING: (name: string) => `svc:sleeping:${name}`,
    WAKING: (name: string) => `svc:waking:${name}`,
    LAST_ACTIVE: (name: string) => `svc:last_active:${name}`,
    HEALTH: (name: string) => `svc:health:${name}`,
    ICE_WARNING_SENT: (name: string) => `svc:ice_warning:${name}`,
    DELETED: (name: string) => `svc:deleted:${name}`,
    CONSECUTIVE_FAILURES: (name: string) => `svc:fail_count:${name}`,
    WATCHDOG_COOLDOWN: (name: string) => `svc:watchdog_cooldown:${name}`,
  },
  METRICS: {
    TRAEFIK_COUNTERS: "metrics:traefik:counters",
  },
  PROCESS: {
    SNAPSHOT: (instanceId: string, timestamp?: number) =>
      timestamp !== undefined ? `process:${instanceId}:snapshot:${timestamp}` : `process:${instanceId}:snapshot:`,
  },
  NODE: {
    UPDATE: (instanceId: string) => `node:${instanceId}:update`,
    CONNECTED: (tag: string) => `node:connected:${tag}`,
  },
  CLUSTER: {
    NODE: (clusterId: string, instanceId: string) => `cluster:${clusterId}:nodes:${instanceId}`,
    NODES_PREFIX: (clusterId: string) => `cluster:${clusterId}:nodes:`,
    STATUS: (clusterId: string) => `cluster:${clusterId}:status`,
    RENAME_HISTORY: (clusterId: string) => `cluster:${clusterId}:renames`,
    WORKLOADS: (clusterId: string, nodeId: string) => `cluster:${clusterId}:node:${nodeId}:workloads`,
    SLEEPING_SERVICES: (clusterId: string) => `cluster:${clusterId}:sleeping`,
  },
  GITHUB: {
    PENDING_INSTALL: (userId: string) => `pending_github_install:${userId}`,
  },
  BILLING: {
    NOTIFICATION: (clusterId: string) => `billing_notification:${clusterId}`,
  },
  FREE_INSTANCE: {
    POOL: "free_instance:pool",
    CLUSTER: (clusterId: string) => `free_instance:cluster:${clusterId}`,
    COUNTER: (instanceId: string) => `free_instance:counter:${instanceId}`,
  },
  POOL: {
    PROVISION_LOCK: "pool:provision:lock",
  },
  BUILD: {
    CALLBACK: (taskId: string) => `build:callback:${taskId}`,
    SLOTS: (nodeTag: string) => `build:slots:${nodeTag}`,
    QUEUE: "build:queue",
    QUEUE_ITEM: (taskId: string) => `build:queue:${taskId}`,
    IN_FLIGHT: (nodeTag: string) => `build:inflight:${nodeTag}`,
  },
  JOB: {
    RUN: (id: string) => `job:run:${id}`,
    INDEX: "job:runs:index",
    LATEST: (job: string) => `job:latest:${job}`,
    NAMES: "job:names",
  },
  TRAEFIK: {
    ROUTER_RULE: (routeKey: string) => `traefik/http/routers/${routeKey}/rule`,
    ROUTER_ENTRYPOINTS: (routeKey: string) => `traefik/http/routers/${routeKey}/entrypoints/0`,
    ROUTER_SERVICE: (routeKey: string) => `traefik/http/routers/${routeKey}/service`,
    ROUTER_TLS: (routeKey: string) => `traefik/http/routers/${routeKey}/tls`,
    ROUTER_TLS_CERTRESOLVER: (routeKey: string) => `traefik/http/routers/${routeKey}/tls/certresolver`,
    SERVICE_URL: (routeKey: string) => `traefik/http/services/${routeKey}/loadbalancer/servers/0/url`,
  },
} as const;
