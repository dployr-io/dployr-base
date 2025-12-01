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

/**
 * Extended Hono context variables
 */
export type AppVariables = {
  kvAdapter: IKVAdapter;
  dbAdapter: IDBAdapter;
  storageAdapter: IStorageAdapter;
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
