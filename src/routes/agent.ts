// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createErrorResponse, createSuccessResponse } from "@/types/index.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { ERROR } from "@/lib/constants/index.js";
import { JWTService } from "@/services/jwt.js";
import { getDB, getKV, getWS, type AppVariables } from "@/lib/context.js";

const agent = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

// Instance exchanges a valid agent token for a fresh short-lived token
agent.post("/token", async (c) => {
  const kv = new KVStore(getKV(c));
  const jwtService = new JWTService(kv);

  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const rawToken = auth.slice("Bearer ".length).trim();

  let payload: any;
  try {
    payload = await jwtService.verifyTokenIgnoringExpiry(rawToken);
  } catch (error) {
    console.error("Invalid agent token on /v1/agent/token", error);
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const instanceName = payload.instance_id as string | undefined;
  const tokenType = payload.token_type as string | undefined;
  const exp = typeof payload.exp === "number" ? payload.exp : undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!instanceName) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  if (tokenType === "agent" && exp !== undefined && exp < nowSeconds) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const db = new DatabaseStore(getDB(c));
  const instance = await db.instances.getByName(instanceName);
  if (!instance) {
    return c.json(
      createErrorResponse({
        message: "Instance not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  const token = await jwtService.createAgentAccessToken(instance.tag, {
    issuer: c.env.BASE_URL,
    audience: "dployr-instance",
  });

  return c.json(createSuccessResponse({ token }), 200);
});

agent.post("/cert", async (c) => {
  const instanceId = c.req.query("instanceId");
  const instanceName = c.req.query("instanceName");
  const db = new DatabaseStore(getDB(c));

  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const rawToken = auth.slice("Bearer ".length).trim();
  const kv = new KVStore(getKV(c));
  const jwtService = new JWTService(kv);

  let token: any;
  try {
    token = await jwtService.verifyToken(rawToken);
  } catch (err) {
    console.error("Invalid agent token", err);
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  if (!instanceId && !instanceName) {
    return c.json(
      createErrorResponse({
        message: "Either instanceId or instanceName is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const instance = instanceId
    ? await db.instances.get(instanceId)
    : await db.instances.getByName(instanceName!);
  if (!instance) {
    return c.json(
      createErrorResponse({
        message: ERROR.RESOURCE.MISSING_RESOURCE.message,
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  if (token?.instance_id !== instance.tag) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      createErrorResponse({
        message: ERROR.REQUEST.BAD_REQUEST.message,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const pem = typeof body?.pem === "string" ? body.pem : undefined;
  const spkiSha256 = typeof body?.spki_sha256 === "string" ? body.spki_sha256 : undefined;
  const subject = typeof body?.subject === "string" ? body.subject : undefined;
  const notAfter = typeof body?.not_after === "string" ? body.not_after : undefined;

  if (!pem || !spkiSha256 || !subject || !notAfter) {
    return c.json(
      createErrorResponse({
        message: ERROR.REQUEST.BAD_REQUEST.message,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const metadata = instance.metadata || {};
  if (metadata.clientCert) {
    return c.json(
      createErrorResponse({
        message: ERROR.REQUEST.BAD_REQUEST.message,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      409,
    );
  }

  metadata.clientCert = {
    pem,
    spki_sha256: spkiSha256,
    subject,
    not_after: notAfter,
  };

  await db.instances.updateMetadata(instance.id, metadata);

  return new Response(null, { status: 204 });
});

agent.put("/cert", async (c) => {
  const instanceId = c.req.query("instanceId");
  const instanceName = c.req.query("instanceName");
  const db = new DatabaseStore(getDB(c));

  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const rawToken = auth.slice("Bearer ".length).trim();
  const kv = new KVStore(getKV(c));
  const jwtService = new JWTService(kv);

  let token: any;
  try {
    token = await jwtService.verifyToken(rawToken);
  } catch (err) {
    console.error("Invalid agent token", err);
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  if (!instanceId && !instanceName) {
    return c.json(
      createErrorResponse({
        message: "Either instanceId or instanceName is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const instance = instanceId
    ? await db.instances.get(instanceId)
    : await db.instances.getByName(instanceName!);
  if (!instance) {
    return c.json(
      createErrorResponse({
        message: ERROR.RESOURCE.MISSING_RESOURCE.message,
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  if (token?.instance_id !== instance.tag) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  let body: any;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      createErrorResponse({
        message: ERROR.REQUEST.BAD_REQUEST.message,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const pem = typeof body?.pem === "string" ? body.pem : undefined;
  const spkiSha256 = typeof body?.spki_sha256 === "string" ? body.spki_sha256 : undefined;
  const subject = typeof body?.subject === "string" ? body.subject : undefined;
  const notAfter = typeof body?.not_after === "string" ? body.not_after : undefined;

  if (!pem || !spkiSha256 || !subject || !notAfter) {
    return c.json(
      createErrorResponse({
        message: ERROR.REQUEST.BAD_REQUEST.message,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const metadata = instance.metadata || {};

  metadata.clientCert = {
    pem,
    spki_sha256: spkiSha256,
    subject,
    not_after: notAfter,
  };

  await db.instances.updateMetadata(instance.id, metadata);

  return new Response(null, { status: 204 });
});

// Instance WebSocket endpoint for tasks
agent.get("/ws", async (c) => {
  const instanceId = c.req.query("instanceId");
  const instanceName = c.req.query("instanceName");
  const db = new DatabaseStore(getDB(c));

  const auth = c.req.header("authorization") || c.req.header("Authorization");
  if (!auth || !auth.startsWith("Bearer ")) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const rawToken = auth.slice("Bearer ".length).trim();
  const kv = new KVStore(getKV(c));
  const jwtService = new JWTService(kv);

  let token: any;
  try {
    token = await jwtService.verifyToken(rawToken);
  } catch (err) {
    console.error("Invalid agent token", err);
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  if (!instanceId && !instanceName) {
    return c.json(
      createErrorResponse({
        message: "Either instanceId or instanceName is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const instance = instanceId
    ? await db.instances.get(instanceId)
    : await db.instances.getByName(instanceName!);
  if (!instance) {
    return c.json(
      createErrorResponse({
        message: ERROR.RESOURCE.MISSING_RESOURCE.message,
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  if (token?.instance_id !== instance.tag) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }
  
  // WebSocket upgrade is handled by the server-level upgrade handler
  return c.text("WebSocket upgrade required", 426);
});

export default agent;
