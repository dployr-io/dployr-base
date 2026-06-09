// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import z from "zod";
import { Bindings, Variables, createSuccessResponse, createErrorResponse, parsePaginationParams, createPaginatedResponse } from "@/types/index.js";
import { ERROR } from "@/lib/constants/index.js";
import { getDbStore } from "@/lib/config/context.js";
import { authMiddleware } from "@/middleware/auth.js";

const VALID_SCOPES = ["oidc:bind"] as const;

const createTokenSchema = z.object({
  name: z.string().min(1).max(128),
  scopes: z.array(z.enum(VALID_SCOPES)).min(1),
  expiresIn: z.number().int().positive().optional(), // seconds from now
});

const authTokens = new Hono<{ Bindings: Bindings; Variables: Variables }>();

async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function generateToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const hex = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `dpat_${hex}`;
}

/**
 * create a new personal access token.
 * Returns the plaintext token only once; only the hash is stored.
 */
authTokens.post("/", authMiddleware, async (c) => {
  const session = c.get("session")!;

  // Scoped tokens cannot create other tokens.
  if (session.scopes && session.scopes.length > 0) {
    return c.json(createErrorResponse({ message: "Scoped tokens cannot create other tokens", code: ERROR.PERMISSION.FORBIDDEN.code }), ERROR.PERMISSION.FORBIDDEN.status);
  }

  const body = await c.req.json().catch(() => null);
  const parsed = createTokenSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(createErrorResponse({ message: "Invalid token parameters", code: ERROR.REQUEST.BAD_REQUEST.code }), ERROR.REQUEST.BAD_REQUEST.status);
  }

  const { name, scopes, expiresIn } = parsed.data;
  const plaintext = generateToken();
  const tokenHash = await sha256Hex(plaintext);
  const expiresAt = expiresIn ? Date.now() + expiresIn * 1000 : undefined;

  const db = getDbStore(c);
  const token = await db.apiTokens.create({
    userId: session.userId,
    name,
    tokenHash,
    scopes,
    expiresAt,
  });

  return c.json(
    createSuccessResponse(
      {
        ...token,
        // Plaintext is returned only here — never stored, never shown again.
        token: plaintext,
      },
      "Token created — save it now, it will not be shown again",
    ),
    201,
  );
});

/**
 * list all tokens for the authenticated user (no plaintext).
 */
authTokens.get("/", authMiddleware, async (c) => {
  const session = c.get("session")!;

  if (session.scopes && session.scopes.length > 0) {
    return c.json(createErrorResponse({ message: "Scoped tokens cannot list tokens", code: ERROR.PERMISSION.FORBIDDEN.code }), ERROR.PERMISSION.FORBIDDEN.status);
  }

  const db = getDbStore(c);
  const { page, pageSize, offset } = parsePaginationParams(c.req.query("page"), c.req.query("pageSize"));
  const { tokens, total } = await db.apiTokens.list({ userId: session.userId, limit: pageSize, offset });
  return c.json(createSuccessResponse(createPaginatedResponse(tokens, page, pageSize, total)));
});

/**
 * revoke a token by ID.
 */
authTokens.delete("/:id", authMiddleware, async (c) => {
  const session = c.get("session")!;

  if (session.scopes && session.scopes.length > 0) {
    return c.json(createErrorResponse({ message: "Scoped tokens cannot revoke tokens", code: ERROR.PERMISSION.FORBIDDEN.code }), ERROR.PERMISSION.FORBIDDEN.status);
  }

  const id = c.req.param("id");
  const db = getDbStore(c);
  const deleted = await db.apiTokens.revoke(id, session.userId);

  if (!deleted) {
    return c.json(createErrorResponse({ message: "Token not found", code: ERROR.RESOURCE.MISSING_RESOURCE.code }), ERROR.RESOURCE.MISSING_RESOURCE.status);
  }

  return c.json(createSuccessResponse(null, "Token revoked"));
});

export default authTokens;
