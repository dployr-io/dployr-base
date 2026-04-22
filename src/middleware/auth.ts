// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

// middleware/auth.ts
import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { Bindings, Variables, Session } from "@/types/index.js";
import { ERROR } from "@/lib/constants/index.js";
import { getDbStore, getKVStore } from "@/lib/context.js";
import { jwtVerify } from "jose";

/**
 * Authenticates the user from session cookie and returns the session object.
 * The session is cached in the context to avoid repeated KV lookups.
 *
 * @param c - Hono context with Bindings and Variables
 * @returns The authenticated session, or null if not authenticated
 */
async function authenticate(c: Context<{ Bindings: Bindings; Variables: Variables }>): Promise<Session | null> {
  // Check if session is already set (from previous middleware)
  const existingSession = c.get("session");
  if (existingSession) {
    return existingSession;
  }

  const sessionId = getCookie(c, "session");
  if (!sessionId) {
    return null;
  }

  const kv = getKVStore(c);
  const session = await kv.getSession(sessionId);

  if (session) {
    c.set("session", session);
  }

  return session;
}

/**
 * Extracts clusterId from request body, path parameter, or query string.
 *
 * @param c - Hono context
 * @param data - Parsed request body data
 * @returns The clusterId if found, otherwise undefined
 */
function getClusterId(c: Context, data: Record<string, any>): string | undefined {
  const param = c.req.param("id");
  const query = c.req.query("clusterId");
  return data.clusterId || param || query;
}

/**
 * Basic authentication middleware.
 * Requires a valid session cookie. Sets 401 if authentication fails.
 *
 * @param c - Hono context
 * @param next - Next middleware in the chain
 */
export async function authMiddleware(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const session = await authenticate(c);

  if (!session) {
    return c.json(
      {
        error: "Not authenticated",
        code: ERROR.AUTH.BAD_SESSION.code,
      },
      ERROR.AUTH.BAD_SESSION.status,
    );
  }

  await next();
}

/**
 * Requires the authenticated user to have viewer access to the specified cluster.
 * Extracts clusterId from request body, path param, or query param.
 * Sets 401 if not authenticated, 400 if clusterId missing, 403 if no read access.
 *
 * @param c - Hono context
 * @param next - Next middleware in the chain
 */
export async function requireClusterViewer(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const session = await authenticate(c);

  if (!session) {
    return c.json(
      {
        error: "Not authenticated",
        code: ERROR.AUTH.BAD_SESSION.code,
      },
      ERROR.AUTH.BAD_SESSION.status,
    );
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const clusterId = getClusterId(c, data);

  if (!clusterId) {
    return c.json(
      {
        error: "clusterId is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      },
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const db = getDbStore(c);
  const canRead = await db.clusters.canRead(session.userId, clusterId);

  if (!canRead) {
    return c.json(
      {
        error: "Insufficient permissions. Viewer role is required",
        code: ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.code,
      },
      ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.status,
    );
  }

  await next();
}

/**
 * Requires the authenticated user to have developer access to the specified cluster.
 * Extracts clusterId from request body, path param, or query param.
 * Sets 401 if not authenticated, 400 if clusterId missing, 403 if no write access.
 *
 * @param c - Hono context
 * @param next - Next middleware in the chain
 */
export async function requireClusterDeveloper(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const session = await authenticate(c);

  if (!session) {
    return c.json(
      {
        error: "Not authenticated",
        code: ERROR.AUTH.BAD_SESSION.code,
      },
      ERROR.AUTH.BAD_SESSION.status,
    );
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const clusterId = getClusterId(c, data);

  if (!clusterId) {
    return c.json(
      {
        error: "clusterId is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      },
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const db = getDbStore(c);
  const canWrite = await db.clusters.canWrite(session.userId, clusterId);

  if (!canWrite) {
    return c.json(
      {
        error: "Insufficient permissions. Developer role is required",
        code: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.code,
      },
      ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.status,
    );
  }

  await next();
}

/**
 * Requires the authenticated user to have admin access to the specified cluster.
 * Extracts clusterId from request body, path param, or query param.
 * Sets 401 if not authenticated, 400 if clusterId missing, 403 if not an admin.
 *
 * @param c - Hono context
 * @param next - Next middleware in the chain
 */
export async function requireClusterAdmin(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const session = await authenticate(c);

  if (!session) {
    return c.json(
      {
        error: "Not authenticated",
        code: ERROR.AUTH.BAD_SESSION.code,
      },
      ERROR.AUTH.BAD_SESSION.status,
    );
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const clusterId = getClusterId(c, data);

  if (!clusterId) {
    return c.json(
      {
        error: "clusterId is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      },
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const db = getDbStore(c);
  const isAdmin = await db.clusters.isAdmin(session.userId, clusterId);

  if (!isAdmin) {
    return c.json(
      {
        error: "Insufficient permissions. Admin role is required",
        code: ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.code,
      },
      ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.status,
    );
  }

  await next();
}

/**
 * Requires the authenticated user to be the owner of the specified cluster.
 * Extracts clusterId from request body, path param, or query param.
 * Sets 401 if not authenticated, 400 if clusterId missing, 403 if not the owner.
 *
 * @param c - Hono context
 * @param next - Next middleware in the chain
 */
export async function requireClusterOwner(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const session = await authenticate(c);

  if (!session) {
    return c.json(
      {
        error: "Not authenticated",
        code: ERROR.AUTH.BAD_SESSION.code,
      },
      ERROR.AUTH.BAD_SESSION.status,
    );
  }

  let data;
  try {
    data = await c.req.json();
  } catch {
    data = {};
  }
  const clusterId = getClusterId(c, data);

  if (!clusterId) {
    return c.json(
      {
        error: "clusterId is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      },
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const db = getDbStore(c);
  const isOwner = await db.clusters.isOwner(session.userId, clusterId);

  if (!isOwner) {
    return c.json(
      {
        error: "Insufficient permissions. Owner role is required",
        code: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.code,
      },
      ERROR.PERMISSION.OWNER_ROLE_REQUIRED.status,
    );
  }

  await next();
}

/**
 * Requires a valid dployr administrator JWT token.
 * Token must have type "admin" in the payload. Sets 403 if validation fails.
 *
 * @param c - Hono context
 * @param next - Next middleware in the chain
 */
export async function requireDployrAdministrator(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) {
    return c.json(
      {
        message: "Invalid or expired token",
        code: ERROR.AUTH.BAD_TOKEN.code,
      },
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  try {
    const kv = getKVStore(c);
    const publicKey = await kv.getPublicKey();

    const { payload } = await jwtVerify(token, publicKey);

    if (payload.type !== "admin") {
      return c.json(
        {
          message: "Payload type mismatch",
          code: ERROR.AUTH.BAD_TOKEN.code,
        },
        ERROR.AUTH.BAD_TOKEN.status,
      );
    }
  } catch {
    return c.json(
      {
        message: "Forbidden",
        code: ERROR.PERMISSION.RESTRICTED_ENDPOINT.code,
      },
      ERROR.PERMISSION.RESTRICTED_ENDPOINT.status,
    );
  }

  await next();
}

/**
 * Restricts access to dployr administrator endpoints by IP address.
 * Checks X-Forwarded-For, X-Real-IP, and socket remoteAddress.
 * In development mode, localhost (127.0.0.1) is automatically allowed.
 * Returns Forbidden if IP is not in the allowed list.
 *
 * @param c - Hono context
 * @param next - Next middleware in the chain
 */
export async function requireDployrAdministratorIPAddress(c: Context<{ Bindings: Bindings; Variables: Variables }>, next: Next) {
  const allowed = (c.env.ALLOWED_DPLOYR_ADMINISTRATORS || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  if (allowed.length === 0) {
    return c.json(
      {
        message: "Access configuration error",
        code: ERROR.ADMIN.DPLOYR_ADMINSTRATOR_IP_ADDRESS_REQUIRED.code,
      },
      ERROR.ADMIN.DPLOYR_ADMINSTRATOR_IP_ADDRESS_REQUIRED.status,
    );
  }

  const ip = c.req.header("cf-connecting-ip");

  if (!ip) {
    return c.json(
      {
        message: "Missing client IP",
        code: ERROR.PERMISSION.RESTRICTED_ENDPOINT.code,
      },
      ERROR.PERMISSION.RESTRICTED_ENDPOINT.status,
    );
  }

  if (!allowed.includes(ip)) {
    return c.json(
      {
        message: "Access denied",
        code: ERROR.PERMISSION.RESTRICTED_ENDPOINT.code,
      },
      ERROR.PERMISSION.RESTRICTED_ENDPOINT.status,
    );
  }

  return next();
}
