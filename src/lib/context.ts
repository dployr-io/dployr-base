// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context } from 'hono';
import type { IKVAdapter } from '@/lib/storage/kv.interface.js';
import type { WebSocketHandler } from '@/lib/websocket/instance-handler.js';
import type { PostgresAdapter } from '@/lib/db/pg-adapter.js';

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
  const kv = c.get('kvAdapter');
  if (!kv) {
    throw new Error('KV adapter not initialized');
  }
  return kv;
}

export function getDB(c: Context): PostgresAdapter {
  const db = c.get('dbAdapter');
  if (!db) {
    throw new Error('DB adapter not initialized');
  }
  return db;
}

export function getStorage(c: Context): IStorageAdapter {
  const storage = c.get('storageAdapter');
  if (!storage) {
    throw new Error('Storage adapter not initialized');
  }
  return storage;
}

export function getSession(c: Context) {
  return c.get('session');
}

export function getWS(c: Context): WebSocketHandler {
  const ws = c.get('wsHandler');
  if (!ws) {
    throw new Error('WebSocket handler not initialized');
  }
  return ws;
}

/**
 * Execute a background task without blocking the response
 */
export function runBackground(task: Promise<any>): void {
  task.catch(err => console.error('Background task error:', err));
}
