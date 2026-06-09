// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { jwtVerify, importJWK, type JWTPayload } from "jose";
import z from "zod";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { ERROR } from "@/lib/constants/index.js";
import { TTL_1_HOUR } from "@/lib/constants/duration.js";
import { getDbStore, getKVStore } from "@/lib/config/context.js";
import { authMiddleware } from "@/middleware/auth.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("OIDC");

const oidc = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// GitHub-specific event_name values that must be rejected to prevent
// untrusted fork PRs from triggering deployments via pull_request_target.
const GITHUB_FORBIDDEN_EVENTS = new Set(["pull_request", "pull_request_target"]);

async function fetchJwks(issuer: string): Promise<{ keys: any[] }> {
  try {
    const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(5000) });
    const config = discovery.ok ? ((await discovery.json()) as { jwks_uri?: string }) : null;
    if (config?.jwks_uri) {
      const res = await fetch(config.jwks_uri, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      return (await res.json()) as { keys: any[] };
    }
  } catch (err) {
    log.error(`discovery failed for ${issuer}:`, err);
  }

  const fallback = await fetch(`${issuer}/.well-known/jwks`, { signal: AbortSignal.timeout(5000) });
  if (!fallback.ok) throw new Error(`JWKS fallback fetch failed: ${fallback.status}`);
  return (await fallback.json()) as { keys: any[] };
}

async function getVerifiedPayload(token: string, kv: ReturnType<typeof getKVStore>): Promise<JWTPayload & Record<string, unknown>> {
  // Decode header and payload without verification to get issuer and kid
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Malformed JWT");

  const headerJson = JSON.parse(Buffer.from(parts[0], "base64url").toString());
  const payloadJson = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as JWTPayload & Record<string, unknown>;

  const issuer = payloadJson.iss;
  if (typeof issuer !== "string" || !issuer.startsWith("https://")) {
    throw new Error("Invalid or missing issuer");
  }

  // Fetch JWKS — cache hit first
  let jwks = await kv.getJwks(issuer);
  if (!jwks) {
    jwks = await fetchJwks(issuer);
    await kv.setJwks(issuer, jwks);
  }

  // Build key map by kid
  const kid = headerJson.kid as string | undefined;
  const matchingKeys = kid ? jwks.keys.filter((k: any) => k.kid === kid) : jwks.keys;

  if (matchingKeys.length === 0) {
    // Stale cache — refresh once
    const freshJwks = await fetchJwks(issuer);
    await kv.setJwks(issuer, freshJwks);
    const retryKeys = kid ? freshJwks.keys.filter((k: any) => k.kid === kid) : freshJwks.keys;
    if (retryKeys.length === 0) throw new Error("No matching key found in JWKS");
    matchingKeys.push(...retryKeys);
  }

  let lastError: unknown;
  for (const jwk of matchingKeys) {
    try {
      const key = await importJWK(jwk) as any;
      const { payload } = await jwtVerify(token, key, { issuer });
      return payload as JWTPayload & Record<string, unknown>;
    } catch (err) {
      lastError = err;
    }
  }

  throw lastError ?? new Error("JWT verification failed");
}

// exchange a CI OIDC token for a 1-hour dployr session
const exchangeSchema = z.object({
  token: z.string().min(1),
});

oidc.post("/exchange", async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = exchangeSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(createErrorResponse({ message: "Token is required", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const { token } = parsed.data;
  const db = getDbStore(c);
  const kv = getKVStore(c);

  let payload: JWTPayload & Record<string, unknown>;
  try {
    payload = await getVerifiedPayload(token, kv);
  } catch (err) {
    log.error("OIDC token verification failed:", err);
    return c.json(createErrorResponse({ message: "Token invalid or expired", code: ERROR.AUTH.OIDC_INVALID_TOKEN.code }), ERROR.AUTH.OIDC_INVALID_TOKEN.status);
  }

  const issuer = payload.iss as string;
  const subject = payload.sub as string;

  if (!issuer || !subject) {
    return c.json(createErrorResponse({ message: "token invalid or expired", code: ERROR.AUTH.OIDC_INVALID_TOKEN.code }), ERROR.AUTH.OIDC_INVALID_TOKEN.status);
  }

  const binding = await db.oidcBindings.find({ issuer, subject });
  if (!binding) {
    return c.json(createErrorResponse({ message: "No binding found for this token", code: ERROR.AUTH.OIDC_BINDING_NOT_FOUND.code }), ERROR.AUTH.OIDC_BINDING_NOT_FOUND.status);
  }

  // Provider-specific security checks
  if (binding.provider === "github") {
    const eventName = payload.event_name as string | undefined;
    if (eventName && GITHUB_FORBIDDEN_EVENTS.has(eventName)) {
      return c.json(createErrorResponse({ message: "Token event type is not permitted", code: ERROR.AUTH.OIDC_FORBIDDEN_EVENT.code }), ERROR.AUTH.OIDC_FORBIDDEN_EVENT.status);
    }
  }

  if (binding.provider === "gitlab") {
    // Require protected ref to block unprotected branches from deploying
    const refProtected = payload.ref_protected;
    if (refProtected !== true && refProtected !== "true") {
      return c.json(createErrorResponse({ message: "Token event type is not permitted", code: ERROR.AUTH.OIDC_FORBIDDEN_EVENT.code }), ERROR.AUTH.OIDC_FORBIDDEN_EVENT.status);
    }
  }

  const user = await db.users.find({ id: binding.userId });
  if (!user) {
    return c.json(createErrorResponse({ message: "No binding found for this token", code: ERROR.AUTH.OIDC_BINDING_NOT_FOUND.code }), ERROR.AUTH.OIDC_BINDING_NOT_FOUND.status);
  }

  const cluster = await db.clusters.find({ id: binding.clusterId });
  if (!cluster) {
    return c.json(createErrorResponse({ message: "No binding found for this token", code: ERROR.AUTH.OIDC_BINDING_NOT_FOUND.code }), ERROR.AUTH.OIDC_BINDING_NOT_FOUND.status);
  }

  const sessionId = crypto.randomUUID();
  await kv.createSession(
    sessionId,
    { id: user.id, email: user.email, provider: user.provider as any },
    [{ id: cluster.id, name: cluster.name, owner: cluster.roles.owner[0] ?? binding.userId, role: "developer" }],
    TTL_1_HOUR,
  );

  return c.json(createSuccessResponse({ sessionId, expiresIn: TTL_1_HOUR }, "OIDC authentication successful"));
});

// create a new OIDC binding
const createBindingSchema = z.object({
  clusterId: z.string().min(1),
  provider: z.enum(["github", "gitlab", "bitbucket"]),
  issuer: z.string().startsWith("https://"),
  subject: z.string().min(1).max(512),
  name: z.string().max(128).optional(),
});

oidc.post("/bindings", authMiddleware, async (c) => {
  const session = c.get("session")!;

  // Scoped dpat_ tokens must have the oidc:bind scope.
  if (session.scopes && session.scopes.length > 0 && !session.scopes.includes("oidc:bind")) {
    return c.json(createErrorResponse({ message: "Token does not have the oidc:bind scope", code: ERROR.PERMISSION.FORBIDDEN.code }), ERROR.PERMISSION.FORBIDDEN.status);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = createBindingSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(createErrorResponse({ message: "Invalid binding parameters", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const { clusterId, provider, issuer, subject, name } = parsed.data;
  const db = getDbStore(c);

  const canWrite = await db.clusters.canWrite(session.userId, clusterId);
  if (!canWrite) {
    return c.json(createErrorResponse({ message: "Insufficient permissions", code: ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.code }), ERROR.PERMISSION.DEVELOPER_ROLE_REQUIRED.status);
  }

  try {
    const binding = await db.oidcBindings.create({
      userId: session.userId,
      clusterId,
      provider,
      issuer,
      subject,
      name,
    });
    return c.json(createSuccessResponse(binding, "Binding created"), 201);
  } catch (err: any) {
    if (err?.code === "23505") {
      return c.json(createErrorResponse({ message: "A binding with this issuer and subject already exists", code: ERROR.RESOURCE.CONFLICT.code }), ERROR.RESOURCE.CONFLICT.status);
    }
    throw err;
  }
});

// list bindings for the authenticated user
oidc.get("/bindings", authMiddleware, async (c) => {
  const session = c.get("session")!;
  const db = getDbStore(c);

  const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));
  const { bindings, total } = await db.oidcBindings.list({ userId: session.userId, limit: pageSize, offset });
  return c.json(createSuccessResponse(createPaginatedResponse(bindings, page, pageSize, total)));
});

// remove a binding
oidc.delete("/bindings/:id", authMiddleware, async (c) => {
  const id = c.req.param("id");
  const session = c.get("session")!;
  const db = getDbStore(c);

  const deleted = await db.oidcBindings.delete(id, session.userId);
  if (!deleted) {
    return c.json(createErrorResponse({ message: "Binding not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  return c.json(createSuccessResponse({}, "Binding deleted"));
});

export default oidc;
