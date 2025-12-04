// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Context } from 'hono';
import type { IKVAdapter } from '@/lib/storage/kv.interface';

/**
 * Adapter interfaces for runtime-agnostic access to platform services
 */

// Database adapter interface
export interface IDBAdapter {
  prepare(query: string): {
    bind(...params: any[]): {
      all(): Promise<{ results: any[] }>;
      first(): Promise<any>;
      run(): Promise<{ success: boolean; meta?: any }>;
    };
    all(): Promise<{ results: any[] }>;
    first(): Promise<any>;
    run(): Promise<{ success: boolean; meta?: any }>;
  };
  batch?(statements: any[]): Promise<any[]>;
  exec?(query: string): Promise<any>;
}

// Storage adapter interface
export interface IStorageAdapter {
  put(key: string, value: ReadableStream | ArrayBuffer | string): Promise<void>;
  get(key: string): Promise<ReadableStream | null>;
  delete(key: string): Promise<void>;
  list(options?: { prefix?: string }): Promise<Array<{ key: string }>>;
}

// Durable Object stub interface
export interface IDurableObjectStub {
  fetch(request: Request): Promise<Response>;
  acceptWebSocket?(ws: any): void; // self-hosted 
}

// Durable Object adapter interface
export interface IDurableObjectAdapter {
  idFromName(name: string): string;
  get(id: string): IDurableObjectStub;
}

/**
 * Extended Hono context variables
 */
export type AppVariables = {
  kvAdapter: IKVAdapter;
  dbAdapter: IDBAdapter;
  storageAdapter: IStorageAdapter;
  doAdapter: IDurableObjectAdapter;
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

export function getDB(c: Context): IDBAdapter {
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

export function getDO(c: Context): IDurableObjectAdapter {
  const doAdapter = c.get('doAdapter');
  if (!doAdapter) {
    throw new Error('Durable Object adapter not initialized');
  }
  return doAdapter;
}

/**
 * Execute a background task with platform-specific handling
 * - Cloudflare: uses executionCtx.waitUntil
 * - Self-hosted: runs async without blocking
 */
export function runBackground(c: Context, task: Promise<any>): void {
  try {
    // Try to use Cloudflare's executionCtx if available
    if (c.executionCtx && typeof c.executionCtx.waitUntil === 'function') {
      c.executionCtx.waitUntil(task);
    } else {
      // Self-hosted: just run async and catch errors
      task.catch(err => console.error('Background task error:', err));
    }
  } catch (err) {
    // Fallback: run async
    task.catch(err => console.error('Background task error:', err));
  }
}
