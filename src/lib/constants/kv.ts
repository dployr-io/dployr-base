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
  },
  SERVICES: {
    BY_INSTANCE: (instanceId: string) => `services:${instanceId}`,
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
  TRAEFIK: {
    ROUTER_RULE: (routeKey: string) => `traefik/http/routers/${routeKey}/rule`,
    ROUTER_ENTRYPOINTS: (routeKey: string) => `traefik/http/routers/${routeKey}/entrypoints/0`,
    ROUTER_SERVICE: (routeKey: string) => `traefik/http/routers/${routeKey}/service`,
    SERVICE_URL: (routeKey: string) => `traefik/http/services/${routeKey}/loadbalancer/servers/0/url`,
  },
} as const;
