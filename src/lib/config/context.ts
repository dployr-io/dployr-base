// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { Bindings, Session, Variables } from "@/types/index.js";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { WebSocketHandler } from "@/services/websocket/instance-handler.js";
import type { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import type { BillingProvider } from "@/services/billing/provider.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { JWTService } from "@/services/auth/jwt.js";
import { AuthService } from "@/services/auth/index.js";
import { NotificationService } from "@/services/notifications/index.js";
import { EmailService } from "@/services/notifications/email/index.js";
import { OAuthService } from "@/services/auth/oauth.js";
import { GitHubService } from "@/services/integrations/github.js";
import { GitLabService } from "@/services/integrations/gitlab.js";
import { BitBucketService } from "@/services/integrations/bitbucket.js";
import { IntegrationsService } from "@/services/integrations/index.js";
import { InstanceService } from "@/services/instances.js";
import { DnsService } from "@/services/dns/index.js";
import { BillingService } from "@/services/billing/index.js";
import { TrafficRouter } from "@/services/proxy/traffic-router.js";
import { TraefikService } from "@/services/traefik-router.js";
import { VmProvider } from "@/services/vm/index.js";
import { InstancePool } from "@/services/pool.js";
import { EmailProvider } from "@/services/notifications/email/index.js";

// Storage adapter interface
export interface IStorageAdapter {
  put(key: string, value: ReadableStream | ArrayBuffer | string): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<Array<{ key: string }>>;
}

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/**
 * Type-safe context helpers
 */
export function getKV(c: AppContext): IKVAdapter {
  const kv = c.get("kvAdapter");
  if (!kv) {
    throw new Error("KV adapter not initialized");
  }
  return kv;
}

export function getDB(c: AppContext): PostgresAdapter {
  const db = c.get("dbAdapter");
  if (!db) {
    throw new Error("DB adapter not initialized");
  }
  return db;
}

export function getStorage(c: AppContext): IStorageAdapter {
  const storage = c.get("storageAdapter");
  if (!storage) {
    throw new Error("Storage adapter not initialized");
  }
  return storage;
}

export function getSession(c: AppContext) {
  return c.get("session");
}

export function getWS(c: AppContext): WebSocketHandler {
  const ws = c.get("wsHandler");
  if (!ws) {
    throw new Error("WebSocket handler not initialized");
  }
  return ws;
}

export function getDbStore(c: AppContext): DatabaseStore {
  const existing = c.get("_dbStore");
  if (existing) return existing;

  const store = new DatabaseStore(getDB(c));
  c.set("_dbStore", store);
  return store;
}

export function getKVStore(c: AppContext): KVStore {
  const existing = c.get("_kvStore");
  if (existing) return existing;

  const store = new KVStore(getKV(c));
  c.set("_kvStore", store);
  return store;
}

export function getAuthService(c: AppContext): AuthService {
  const existing = c.get("_authService");
  if (existing) return existing;

  const service = new AuthService(getDbStore(c), getKVStore(c), c.env);
  c.set("_authService", service);
  return service;
}

export function getJWTService(c: AppContext): JWTService {
  const existing = c.get("_jwtService");
  if (existing) return existing;

  const service = new JWTService(getKVStore(c));
  c.set("_jwtService", service);
  return service;
}

export function getNotificationService(c: AppContext): NotificationService {
  const existing = c.get("_notificationService");
  if (existing) return existing;

  const emailProvider = c.get("emailProvider") ?? null;
  const emailService = emailProvider ? new EmailService(emailProvider, c.env) : null;
  const service = new NotificationService(emailService);
  c.set("_notificationService", service);
  return service;
}

export function getOAuthService(c: AppContext): OAuthService {
  const existing = c.get("_oauthService");
  if (existing) return existing;

  const service = new OAuthService(c.env);
  c.set("_oauthService", service);
  return service;
}

export function getGitHubService(c: AppContext): GitHubService {
  const existing = c.get("_githubService");
  if (existing) return existing;

  const service = new GitHubService(c.env);
  c.set("_githubService", service);
  return service;
}

export function getBillingProvider(c: AppContext): BillingProvider | null {
  return c.get("billingProvider") ?? null;
}

export function getInstanceService(c: AppContext): InstanceService {
  const existing = c.get("_instanceService");
  if (existing) return existing;

  const service = new InstanceService(c.env);
  c.set("_instanceService", service);
  return service;
}

export function getInstancePoolService(c: AppContext): InstancePool {
  const existing = c.get("_instancePoolService");
  if (existing) return existing;

  const service = new InstancePool({
    db: getDbStore(c),
    kv: getKVStore(c),
    vm: c.get("vmProvider") ?? undefined,
    jwt: getJWTService(c),
    sshKey: c.env.SSH_KEY,
  });
  c.set("_instancePoolService", service);
  return service;
}

export function getDnsService(c: AppContext): DnsService {
  const existing = c.get("_dnsService");
  if (existing) return existing;

  const service = new DnsService(c.env);
  c.set("_dnsService", service);
  return service;
}

export function getBillingService(c: AppContext): BillingService | null {
  const provider = getBillingProvider(c);
  if (!provider) return null;

  const existing = c.get("_billingService");
  if (existing) return existing;

  const service = new BillingService(provider, c.env);
  c.set("_billingService", service);
  return service;
}

export function getIntegrationsService(c: AppContext): IntegrationsService {
  const existing = c.get("_integrationsService");
  if (existing) return existing;

  const service = new IntegrationsService(c.env, getDbStore(c), getKVStore(c));
  c.set("_integrationsService", service);
  return service;
}

export function getGitLabService(c: AppContext): GitLabService {
  const existing = c.get("_gitLabService");
  if (existing) return existing;

  const service = new GitLabService(c.env);
  c.set("_gitLabService", service);
  return service;
}

export function getBitBucketService(c: AppContext): BitBucketService {
  const existing = c.get("_bitBucketService");
  if (existing) return existing;

  const service = new BitBucketService(c.env);
  c.set("_bitBucketService", service);
  return service;
}

export function getTrafficRouter(c: AppContext): TrafficRouter {
  const existing = c.get("_trafficRouter");
  if (existing) return existing;

  const baseDomain = c.env?.TLD ?? "dployr.io";
  const service = new TrafficRouter(getDbStore(c), getKVStore(c), { baseDomain });
  c.set("_trafficRouter", service);
  return service;
}

export function getVMService(c: AppContext): VmProvider {
  const provider = c.get("vmProvider");
  if (!provider) {
    throw new Error("VM provider not configured");
  }
  return provider;
}

export function getEmailService(c: AppContext): EmailProvider {
  const provider = c.get("emailProvider");
  if (!provider) {
    throw new Error("Email provider not configured");
  }
  return provider;
}

export function getTraefikRouterService(c: AppContext): TraefikService | null {
  const existing = c.get("_traefikRouter");
  if (existing !== undefined) return existing;

  if (!c.env?.TRAEFIK_ENABLED) {
    c.set("_traefikRouter", null);
    return null;
  }

  const redisClient = c.get("traefikRedisClient");
  if (!redisClient) {
    console.warn("Traefik enabled but Redis client not configured");
    c.set("_traefikRouter", null);
    return null;
  }

  const baseDomain = c.env.TRAEFIK_TLD ?? "dployr.run";
  const service = new TraefikService(baseDomain, redisClient);
  c.set("_traefikRouter", service);
  return service;
}
