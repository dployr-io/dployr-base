// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context } from "hono";
import type { IKVAdapter } from "@/lib/storage/kv.interface.js";
import type { WebSocketHandler } from "@/lib/websocket/instance-handler.js";
import type { PostgresAdapter } from "@/lib/db/pg-adapter.js";
import type { BillingProvider } from "@/services/billing/provider.js";
import { DatabaseStore } from "@/lib/db/store/db/index.js";
import { KVStore } from "@/lib/db/store/kv/index.js";
import { JWTService } from "@/services/jwt.js";
import { NotificationService } from "@/services/notifications.js";
import { OAuthService } from "@/services/oauth.js";
import { GitHubService } from "@/services/github.js";

// Storage adapter interface
export interface IStorageAdapter {
  put(key: string, value: ReadableStream | ArrayBuffer | string): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<Array<{ key: string }>>;
}

/**
 * Extended Hono context variables
 */
export type AppVariables = {
  kvAdapter: IKVAdapter;
  dbAdapter: PostgresAdapter;
  storageAdapter: IStorageAdapter;
  wsHandler: WebSocketHandler;
  _dbStore?: DatabaseStore;
  _kvStore?: KVStore;
  _jwtService?: JWTService;
  _notificationService?: NotificationService;
  _oauthService?: OAuthService;
  _githubService?: GitHubService;
  billingProvider?: BillingProvider | null;
  session?: {
    id: string;
    userId: string;
    email: string;
    name: string;
    picture?: string;
  };
};

/**
 * Type-safe context helpers
 */
export function getKV(c: Context): IKVAdapter {
  const kv = c.get("kvAdapter");
  if (!kv) {
    throw new Error("KV adapter not initialized");
  }
  return kv;
}

export function getDB(c: Context): PostgresAdapter {
  const db = c.get("dbAdapter");
  if (!db) {
    throw new Error("DB adapter not initialized");
  }
  return db;
}

export function getStorage(c: Context): IStorageAdapter {
  const storage = c.get("storageAdapter");
  if (!storage) {
    throw new Error("Storage adapter not initialized");
  }
  return storage;
}

export function getSession(c: Context) {
  return c.get("session");
}

export function getWS(c: Context): WebSocketHandler {
  const ws = c.get("wsHandler");
  if (!ws) {
    throw new Error("WebSocket handler not initialized");
  }
  return ws;
}

export function getDbStore(c: Context): DatabaseStore {
  const existing = c.get("_dbStore");
  if (existing) return existing;

  const store = new DatabaseStore(getDB(c));
  c.set("_dbStore", store);
  return store;
}

export function getKVStore(c: Context): KVStore {
  const existing = c.get("_kvStore");
  if (existing) return existing;

  const store = new KVStore(getKV(c));
  c.set("_kvStore", store);
  return store;
}

export function getJWTService(c: Context): JWTService {
  const existing = c.get("_jwtService");
  if (existing) return existing;

  const service = new JWTService(getKVStore(c));
  c.set("_jwtService", service);
  return service;
}

export function getNotificationService(c: Context): NotificationService {
  const existing = c.get("_notificationService");
  if (existing) return existing;

  const service = new NotificationService(c.env);
  c.set("_notificationService", service);
  return service;
}

export function getOAuthService(c: Context): OAuthService {
  const existing = c.get("_oauthService");
  if (existing) return existing;

  const service = new OAuthService(c.env);
  c.set("_oauthService", service);
  return service;
}

export function getGitHubService(c: Context): GitHubService {
  const existing = c.get("_githubService");
  if (existing) return existing;

  const service = new GitHubService(c.env);
  c.set("_githubService", service);
  return service;
}

export function getBillingProvider(c: Context): BillingProvider | null {
  return c.get("billingProvider") ?? null;
}

/**
 * Execute a background task without blocking the response
 */
export function runBackground(task: Promise<any>): void {
  task.catch((err) => console.error("Background task error:", err));
}
