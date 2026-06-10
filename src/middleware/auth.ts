// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Context, Next } from "hono";
import { getCookie } from "hono/cookie";
import { Bindings, Variables, Session } from "@/types/index.js";
import { ERROR } from "@/lib/constants/index.js";
import { TWO_FA_WINDOW_MS } from "@/lib/constants/duration.js";
import { getDbStore, getKVStore } from "@/lib/config/context.js";
import type { DatabaseStore } from "@/lib/db/store/db/index.js";
import { jwtVerify } from "jose";

type AppContext = Context<{ Bindings: Bindings; Variables: Variables }>;

/** SHA-256 hex digest of a string. */
async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Authenticates a `dpat_` personal access token against the api_tokens table. */
async function authenticateApiToken(c: AppContext, token: string): Promise<Session | null> {
  const tokenHash = await sha256Hex(token);
  const db = getDbStore(c);
  const record = await db.apiTokens.findByHash(tokenHash);
  if (!record) return null;

  const now = Date.now();
  if (record.expiresAt && record.expiresAt <= now) return null;

  const user = await db.users.find({ id: record.userId });
  if (!user) return null;

  const { clusters: userClusters } = await db.clusters.list({ userId: user.id });
  const session: Session = {
    id: crypto.randomUUID(),
    userId: user.id,
    email: user.email,
    provider: user.provider as Session["provider"],
    clusters: userClusters.map((uc): { id: string; name: string; owner: string; role: string } => ({
      id: uc.id,
      name: uc.name,
      owner: uc.owner ?? "",
      role: uc.role ?? "",
    })),
    createdAt: now,
    expiresAt: record.expiresAt ?? now + 365 * 24 * 60 * 60 * 1000,
    scopes: record.scopes,
  };
  // Fire-and-forget — don't let a metrics write block auth.
  db.apiTokens.updateLastUsed(record.id).catch(() => {});
  return session;
}

/** Authenticates a short-lived reprovision JWT issued by the control plane. */
async function authenticateReprovisionToken(c: AppContext, token: string): Promise<Session | null> {
  const kv = getKVStore(c);
  const publicKey = await kv.getPublicKey();
  const { payload } = await jwtVerify(token, publicKey);

  if (payload.token_type !== "reprovision" || !payload.sub || !payload.cluster_id) return null;

  const db = getDbStore(c);
  const [user, cluster] = await Promise.all([db.users.find({ id: payload.sub as string }), db.clusters.find({ id: payload.cluster_id as string })]);
  if (!user || !cluster) return null;

  return {
    id: crypto.randomUUID(),
    userId: user.id,
    email: user.email,
    provider: user.provider as Session["provider"],
    clusters: [{ id: cluster.id, name: cluster.name, owner: user.id, role: "owner" }],
    createdAt: Date.now(),
    expiresAt: Date.now() + 5 * 60 * 1000,
  };
}

/**
 * Resolves the session from Bearer token or session cookie.
 * Result is cached in context to avoid repeated KV lookups within the same request.
 */
async function authenticate(c: AppContext): Promise<Session | null> {
  const existingSession = c.get("session");
  if (existingSession) return existingSession;

  const authHeader = c.req.header("Authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (bearerToken) {
    try {
      const session = await (bearerToken.startsWith("dpat_") ? authenticateApiToken(c, bearerToken) : authenticateReprovisionToken(c, bearerToken));
      if (session) {
        c.set("session", session);
        return session;
      }
    } catch {
      // fall through to session cookie
    }
    // dpat_ tokens that fail auth must not fall through to cookie auth.
    if (bearerToken.startsWith("dpat_")) return null;
  }

  const sessionId = getCookie(c, "session");
  if (!sessionId) return null;

  const kv = getKVStore(c);
  const session = await kv.getSession(sessionId);
  if (session) c.set("session", session);
  return session;
}

/**
 * Extracts clusterId from context (pre-resolved by resolveCluster), request body,
 * path param `:id`, or query string — in that priority order.
 */
function getClusterId(c: AppContext, data: Record<string, any>): string | undefined {
  const resolved = c.get("resolvedClusterId");
  if (resolved) return resolved;
  const param = c.req.param("id");
  const query = c.req.query("clusterId");
  return data.clusterId || param || query;
}

/**
 * Middleware factory that resolves a cluster ID from an entity in the request and
 * injects it as `resolvedClusterId`, allowing downstream permission middleware to
 * work on routes where the cluster is not directly in the request.
 *
 * @param entity - Entity type to resolve the cluster from
 * @param options.path / body / query - Where to read the entity identifier from
 * @param options.lookupBy - For "service": whether to look up by "id" (default) or "name"
 */
export function resolveCluster(entity: "instance" | "domain" | "service" | "proxy", options: { path?: string; body?: string; query?: string; lookupBy?: "id" | "tag" | "name" }) {
  return async (c: AppContext, next: Next) => {
    const db = getDbStore(c);

    if (entity === "instance") {
      let value: string | undefined;
      if (options.path) {
        value = c.req.param(options.path);
      } else if (options.body) {
        try {
          value = (await c.req.json())[options.body];
        } catch {}
      } else if (options.query) {
        value = c.req.query(options.query);
      }

      if (!value) return c.json({ error: "Instance identifier is required", code: ERROR.REQUEST.BAD_REQUEST.code }, ERROR.REQUEST.BAD_REQUEST.status);

      const instance = options.lookupBy === "tag" ? await db.instances.find({ tag: value }) : await db.instances.find({ id: value });
      if (!instance) return c.json({ error: "Instance not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }, ERROR.RESOURCE.MISSING_RESOURCE.status);

      c.set("resolvedClusterId", instance.clusterId ?? undefined);
    } else if (entity === "service") {
      const value = options.path ? c.req.param(options.path) : options.query ? c.req.query(options.query) : undefined;
      if (!value) return c.json({ error: "Service identifier is required", code: ERROR.REQUEST.BAD_REQUEST.code }, ERROR.REQUEST.BAD_REQUEST.status);

      const service = options.lookupBy === "name" ? await db.services.find({ name: value }) : await db.services.find({ id: value });
      if (!service) return c.json({ error: "Service not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }, ERROR.RESOURCE.MISSING_RESOURCE.status);

      c.set("resolvedServiceId", service.id);
      c.set("resolvedClusterId", service.clusterId);
    } else if (entity === "proxy") {
      const value = options.path ? c.req.param(options.path) : options.query ? c.req.query(options.query) : undefined;
      if (!value) return c.json({ error: "Domain identifier is required", code: ERROR.REQUEST.BAD_REQUEST.code }, ERROR.REQUEST.BAD_REQUEST.status);

      const domain = await db.domains.find(value);
      if (!domain) return c.json({ error: "Domain not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }, ERROR.RESOURCE.MISSING_RESOURCE.status);

      c.set("resolvedClusterId", domain.clusterId);
    } else {
      const domainName = options.path ? c.req.param(options.path) : options.query ? c.req.query(options.query) : undefined;
      if (!domainName) return c.json({ error: "Domain is required", code: ERROR.REQUEST.BAD_REQUEST.code }, ERROR.REQUEST.BAD_REQUEST.status);

      const record = await db.domains.find(domainName);
      if (!record) return c.json({ error: "Domain not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }, ERROR.RESOURCE.MISSING_RESOURCE.status);

      c.set("resolvedClusterId", record.clusterId ?? undefined);
    }

    await next();
  };
}

/**
 * Best-effort session loader — populates `session` in context when a valid cookie or
 * token is present. Does NOT reject unauthenticated requests; use `authMiddleware` for that.
 * Apply before rate-limit middleware so authenticated users get per-user buckets.
 */
export async function loadSession(c: AppContext, next: Next) {
  await authenticate(c);
  await next();
}

/** Requires a valid session. Returns 401 if the request is unauthenticated. */
export async function authMiddleware(c: AppContext, next: Next) {
  const session = await authenticate(c);
  if (!session) return c.json({ error: "Not authenticated", code: ERROR.AUTH.BAD_SESSION.code }, ERROR.AUTH.BAD_SESSION.status);
  await next();
}

/**
 * Factory for cluster-scoped permission middleware.
 * Authenticates the request, resolves `clusterId`, runs `check`, and rejects with
 * `forbidden` if the check fails. Returns 401 / 400 / 403 as appropriate.
 */
function requireClusterPermission(check: (db: DatabaseStore, userId: string, clusterId: string) => Promise<boolean>, forbidden: { error: string; code: string; status: number }) {
  return async (c: AppContext, next: Next) => {
    const session = await authenticate(c);
    if (!session) return c.json({ error: "Not authenticated", code: ERROR.AUTH.BAD_SESSION.code }, ERROR.AUTH.BAD_SESSION.status);

    const data = await c.req.json().catch(() => ({}));
    const clusterId = getClusterId(c, data);
    if (!clusterId) return c.json({ error: "clusterId is required", code: ERROR.REQUEST.BAD_REQUEST.code }, ERROR.REQUEST.BAD_REQUEST.status);

    const db = getDbStore(c);
    if (!(await check(db, session.userId, clusterId))) {
      return c.json({ error: forbidden.error, code: forbidden.code }, forbidden.status as any);
    }

    await next();
  };
}

/** Requires viewer (read) access to the cluster. */
export const requireClusterViewer = requireClusterPermission((db, userId, clusterId) => db.clusters.canRead(userId, clusterId), {
  error: "Insufficient permissions. Viewer role is required",
  code: ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.code,
  status: ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.status,
});

/** Requires developer (write) access to the cluster. */
export const requireClusterDeveloper = requireClusterPermission((db, userId, clusterId) => db.clusters.canWrite(userId, clusterId), {
  error: "Insufficient permissions. Developer role is required",
  code: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.code,
  status: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.status,
});

/** Requires admin access to the cluster. */
export const requireClusterAdmin = requireClusterPermission((db, userId, clusterId) => db.clusters.isAdmin(userId, clusterId), {
  error: "Insufficient permissions. Admin role is required",
  code: ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.code,
  status: ERROR.PERMISSION.ADMIN_ROLE_REQUIRED.status,
});

/** Requires owner access to the cluster. */
export const requireClusterOwner = requireClusterPermission((db, userId, clusterId) => db.clusters.isOwner(userId, clusterId), {
  error: "Insufficient permissions. Owner role is required",
  code: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.code,
  status: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.status,
});


/**
 * Requires that the current session has completed 2FA verification within the last 5 minutes.
 * Apply after `authMiddleware` on any route that guards sensitive operations.
 *
 * Skips the check for:
 *   - API token sessions (scopes present) — tokens are already scoped credentials
 *   - Users who have not configured TOTP — 2FA is opt-in
 */
export async function require2FA(c: AppContext, next: Next) {
  const session = await authenticate(c);
  if (!session) return c.json({ error: "Not authenticated", code: ERROR.AUTH.BAD_SESSION.code }, ERROR.AUTH.BAD_SESSION.status);

  if (session.scopes !== undefined) {
    await next();
    return;
  }

  const db = getDbStore(c);
  const twoFaRecord = await db.twoFa?.find(session.userId);
  if (!twoFaRecord?.totpEnabled) {
    await next();
    return;
  }

  const age = session.twoFaVerifiedAt ? Date.now() - session.twoFaVerifiedAt : Infinity;
  if (age > TWO_FA_WINDOW_MS) {
    return c.json({ error: "2FA verification required", code: ERROR.AUTH.TWO_FA_REQUIRED.code }, ERROR.AUTH.TWO_FA_REQUIRED.status as any);
  }

  await next();
}

/**
 * Requires a valid dployr administrator JWT (`type: "admin"` claim).
 * Returns 401 if no token is present, 403 if the token is invalid.
 */
export async function requireDployrAdministrator(c: AppContext, next: Next) {
  const authHeader = c.req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;

  if (!token) return c.json({ message: "Invalid or expired token", code: ERROR.AUTH.BAD_TOKEN.code }, ERROR.AUTH.BAD_TOKEN.status);

  try {
    const kv = getKVStore(c);
    const publicKey = await kv.getPublicKey();
    const { payload } = await jwtVerify(token, publicKey);

    if (payload.type !== "admin") return c.json({ message: "Payload type mismatch", code: ERROR.AUTH.BAD_TOKEN.code }, ERROR.AUTH.BAD_TOKEN.status);
  } catch {
    return c.json({ message: "Forbidden", code: ERROR.PERMISSION.FORBIDDEN.code }, ERROR.PERMISSION.FORBIDDEN.status);
  }

  await next();
}

/**
 * Restricts access by IP address using the `cf-connecting-ip` header.
 * Allowed IPs are read from `ALLOWED_DPLOYR_ADMINISTRATORS` env var (comma-separated).
 * Returns 403 if the IP is absent, unset, or not in the allowlist.
 */
export async function requireDployrAdministratorIPAddress(c: AppContext, next: Next) {
  const allowed = (c.env.ALLOWED_DPLOYR_ADMINISTRATORS || "")
    .split(",")
    .map((ip) => ip.trim())
    .filter(Boolean);

  if (allowed.length === 0) return c.json({ message: "Access denied", code: ERROR.PERMISSION.FORBIDDEN.code }, ERROR.PERMISSION.FORBIDDEN.status);

  const ip = c.req.header("cf-connecting-ip");
  if (!ip) return c.json({ message: "Missing client IP", code: ERROR.PERMISSION.FORBIDDEN.code }, ERROR.PERMISSION.FORBIDDEN.status);
  if (!allowed.includes(ip)) return c.json({ message: "Access denied", code: ERROR.PERMISSION.FORBIDDEN.code }, ERROR.PERMISSION.FORBIDDEN.status);

  return next();
}
