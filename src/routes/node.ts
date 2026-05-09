// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createErrorResponse, createSuccessResponse } from "@/types/index.js";
import { ERROR } from "@/lib/constants/index.js";
import { getJWTService, getDbStore } from "@/lib/config/context.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("Node");

const node = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Instance (dedicated or pool) exchanges a valid node token for a fresh short-lived token.
node.post("/token", async (c) => {
  const jwtService = getJWTService(c);

  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const rawToken = auth.slice("Bearer ".length).trim();

  let payload: any;
  try {
    payload = await jwtService.verifyTokenIgnoringExpiry(rawToken);
  } catch (error) {
    log.warn("Invalid node token on /v1/node/token", error);
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const instanceTag = payload.instance_id as string | undefined;
  if (!instanceTag) {
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  // Reject explicitly expired "node" type tokens (bootstrap tokens are exempt)
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (payload.token_type === "node" && typeof payload.exp === "number" && payload.exp < nowSeconds) {
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const db = getDbStore(c);
  const instance = await db.instances.find({ tag: instanceTag });
  if (!instance) {
    return c.json(
      createErrorResponse({ message: ERROR.RESOURCE.MISSING_RESOURCE.message, code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  const token = await jwtService.createNodeAccessToken(instance.tag, {
    issuer: c.env.BASE_URL,
    audience: "dployr-instance",
  });

  return c.json(createSuccessResponse({ token }), 200);
});

// POST creates cert (409 if already exists), PUT upserts cert.
// Both work for dedicated and pool instances.
async function handleCert(c: any, upsert: boolean) {
  const db = getDbStore(c);
  const jwtService = getJWTService(c);

  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const rawToken = auth.slice("Bearer ".length).trim();

  let token: any;
  try {
    token = await jwtService.verifyToken(rawToken);
  } catch (err) {
    log.warn("Invalid node token on /cert", err);
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const instanceId = c.req.query("instanceId");
  const instanceName = c.req.query("instanceName");

  if (!instanceId && !instanceName) {
    return c.json(
      createErrorResponse({ message: "Either instanceId or instanceName is required", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const instance = await db.instances.find(instanceId ? { id: instanceId } : { tag: instanceName });
  if (!instance) {
    return c.json(
      createErrorResponse({ message: ERROR.RESOURCE.MISSING_RESOURCE.message, code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  if (token?.instance_id !== instance.tag) {
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      createErrorResponse({ message: ERROR.REQUEST.BAD_REQUEST.message, code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const pem = typeof body?.pem === "string" ? body.pem : undefined;
  const spkiSha256 = typeof body?.spki_sha256 === "string" ? body.spki_sha256 : undefined;
  const subject = typeof body?.subject === "string" ? body.subject : undefined;
  const notAfter = typeof body?.not_after === "string" ? body.not_after : undefined;

  if (!pem || !spkiSha256 || !subject || !notAfter) {
    return c.json(
      createErrorResponse({ message: ERROR.REQUEST.BAD_REQUEST.message, code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const metadata = instance.metadata ?? {};

  if (!upsert && metadata.clientCert) {
    return c.json(
      createErrorResponse({ message: ERROR.REQUEST.BAD_REQUEST.message, code: ERROR.REQUEST.BAD_REQUEST.code }),
      409,
    );
  }

  metadata.clientCert = { pem, spki_sha256: spkiSha256, subject, not_after: notAfter };
  await db.instances.update({ id: instance.id }, { metadata });

  return new Response(null, { status: 204 });
}

node.post("/cert", (c) => handleCert(c, false));
node.put("/cert", (c) => handleCert(c, true));

// WebSocket upgrade endpoint — actual upgrade is handled at the server level.
// This route validates the token and resolves the instance (dedicated or pool).
node.get("/ws", async (c) => {
  const db = getDbStore(c);
  const jwtService = getJWTService(c);

  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const rawToken = auth.slice("Bearer ".length).trim();

  let token: any;
  try {
    token = await jwtService.verifyToken(rawToken);
  } catch (err) {
    log.warn("Invalid node token on /ws", err);
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const instanceId = c.req.query("instanceId");
  const instanceName = c.req.query("instanceName");

  if (!instanceId && !instanceName) {
    return c.json(
      createErrorResponse({ message: "Either instanceId or instanceName is required", code: ERROR.REQUEST.BAD_REQUEST.code }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const instance = await db.instances.find(instanceId ? { id: instanceId } : { tag: instanceName });
  if (!instance) {
    return c.json(
      createErrorResponse({ message: ERROR.RESOURCE.MISSING_RESOURCE.message, code: ERROR.RESOURCE.MISSING_RESOURCE.code }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  if (token?.instance_id !== instance.tag) {
    return c.json(
      createErrorResponse({ message: ERROR.AUTH.BAD_TOKEN.message, code: ERROR.AUTH.BAD_TOKEN.code }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  return c.text("WebSocket upgrade required", 426);
});

export default node;
