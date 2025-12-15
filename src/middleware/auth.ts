// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// middleware/auth.ts
import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { Bindings, Variables, Session } from "@/types/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { ERROR } from "@/lib/constants/index.js";
import { getKV, getDB } from "@/lib/context.js";

/**
 * Authenticates the user and returns the session, or null if not authenticated.
 */
async function authenticate(
  c: Context<{ Bindings: Bindings; Variables: Variables }>
): Promise<Session | null> {
  // Check if session is already set (from previous middleware)
  const existingSession = c.get("session");
  if (existingSession) {
    return existingSession;
  }

  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return null;
  }

  const kv = new KVStore(getKV(c));
  const session = await kv.getSession(sessionId);

  if (session) {
    c.set("session", session);
  }

  return session;
}

/**
 * Extracts clusterId from request body, path param, or query param.
 */
function getClusterId(c: Context, data: Record<string, any>): string | undefined {
  const param = c.req.param("id");
  const query = c.req.query("clusterId");
  return data.clusterId || param || query;
}

/**
 * Basic authentication middleware 
 */
export async function authMiddleware(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = await authenticate(c);

  if (!session) {
    return c.json({ 
      error: "Not authenticated", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }, ERROR.AUTH.BAD_SESSION.status);
  }

  await next();
}

/**
 * Requires viewer role 
 */
export async function requireClusterViewer(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = await authenticate(c);

  if (!session) {
    return c.json({ 
      error: "Not authenticated", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }, ERROR.AUTH.BAD_SESSION.status);
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const clusterId = getClusterId(c, data);

  if (!clusterId) {
    return c.json({ 
      error: "clusterId is required", 
      code: ERROR.REQUEST.BAD_REQUEST.code 
    }, ERROR.REQUEST.BAD_REQUEST.status);
  }

  const db = new DatabaseStore(getDB(c) as any);
  const canRead = await db.clusters.canRead(session.userId, clusterId);

  if (!canRead) {
    return c.json({ 
      error: "Insufficient permissions. Viewer role is required", 
      code: ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.code 
    }, ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.status);
  }

  await next();
}

/**
 * Requires developer role 
 */
export async function requireClusterDeveloper(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = await authenticate(c);

  if (!session) {
    return c.json({ 
      error: "Not authenticated", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }, ERROR.AUTH.BAD_SESSION.status);
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const clusterId = getClusterId(c, data);

  if (!clusterId) {
    return c.json({ 
      error: "clusterId is required", 
      code: ERROR.REQUEST.BAD_REQUEST.code 
    }, ERROR.REQUEST.BAD_REQUEST.status);
  }

  const db = new DatabaseStore(getDB(c) as any);
  const canWrite = await db.clusters.canWrite(session.userId, clusterId);

  if (!canWrite) {
    return c.json({ 
      error: "Insufficient permissions. Developer role is required", 
      code: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.code 
    }, ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.status);
  }

  await next();
}

/**
 * Requires admin role
 */
export async function requireClusterAdmin(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = await authenticate(c);

  if (!session) {
    return c.json({ 
      error: "Not authenticated", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }, ERROR.AUTH.BAD_SESSION.status);
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const clusterId = getClusterId(c, data);

  if (!clusterId) {
    return c.json({ 
      error: "clusterId is required", 
      code: ERROR.REQUEST.BAD_REQUEST.code 
    }, ERROR.REQUEST.BAD_REQUEST.status);
  }

  const db = new DatabaseStore(getDB(c) as any);
  const isAdmin = await db.clusters.isAdmin(session.userId, clusterId);

  if (!isAdmin) {
    return c.json({ 
      error: "Insufficient permissions. Admin role is required", 
      code: ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.code 
    }, ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.status);
  }

  await next();
}

/**
 * Requires owner role 
 */
export async function requireClusterOwner(
  c: Context<{ Bindings: Bindings; Variables: Variables }>,
  next: Next
) {
  const session = await authenticate(c);

  if (!session) {
    return c.json({ 
      error: "Not authenticated", 
      code: ERROR.AUTH.BAD_SESSION.code 
    }, ERROR.AUTH.BAD_SESSION.status);
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const clusterId = getClusterId(c, data);

  if (!clusterId) {
    return c.json({ 
      error: "clusterId is required", 
      code: ERROR.REQUEST.BAD_REQUEST.code 
    }, ERROR.REQUEST.BAD_REQUEST.status);
  }

  const db = new DatabaseStore(getDB(c) as any);
  const isOwner = await db.clusters.isOwner(session.userId, clusterId);

  if (!isOwner) {
    return c.json({ 
      error: "Insufficient permissions. Owner role is required", 
      code: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.code 
    }, ERROR.PERMISSION.OWNER_ROLE_REQUIRED.status);
  }

  await next();
}
