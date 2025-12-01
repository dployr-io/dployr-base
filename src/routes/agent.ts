// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { Bindings, Variables, createErrorResponse, createSuccessResponse } from "@/types";
import { D1Store } from "@/lib/db/store";
import { KVStore } from "@/lib/db/store/kv";
import { ERROR } from "@/lib/constants";
import { JWTService } from "@/services/jwt";
import { AgentStatusReportSchema, LATEST_COMPATIBILITY_DATE } from "@/types/agent";
import { isCompatible } from "@/lib/version";

const agent = new Hono<{ Bindings: Bindings; Variables: Variables }>();

// Instance exchanges a valid agent token for a fresh short-lived token
agent.post("/token", async (c) => {
  const kv = KVStore.fromCloudflare(c.env.BASE_KV);
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
  } catch (err) {
    console.error("Invalid agent token on /v1/agent/token", err);
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const instanceId = payload.instance_id as string | undefined;
  const tokenType = payload.token_type as string | undefined;
  const exp = typeof payload.exp === "number" ? payload.exp : undefined;
  const nowSeconds = Math.floor(Date.now() / 1000);

  if (!instanceId) {
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

  const token = await jwtService.createAgentAccessToken(instanceId, {
    issuer: c.env.BASE_URL,
    audience: "dployr-instance",
  });

  return c.json(createSuccessResponse({ token }), 200);
});

agent.post("/instances/:instanceId/cert", async (c) => {
  const instanceId = c.req.param("instanceId");
  const d1 = new D1Store(c.env.BASE_DB);

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
  const kv = KVStore.fromCloudflare(c.env.BASE_KV);
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

  if (token?.instance_id !== instanceId) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const instance = await d1.instances.get(instanceId);
  if (!instance) {
    return c.json(
      createErrorResponse({
        message: ERROR.RESOURCE.MISSING_RESOURCE.message,
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
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

  await d1.instances.updateMetadata(instanceId, metadata);

  return new Response(null, { status: 204 });
});

agent.put("/instances/:instanceId/cert", async (c) => {
  const instanceId = c.req.param("instanceId");
  const d1 = new D1Store(c.env.BASE_DB);

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
  const kv = KVStore.fromCloudflare(c.env.BASE_KV);
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

  if (token?.instance_id !== instanceId) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const instance = await d1.instances.get(instanceId);
  if (!instance) {
    return c.json(
      createErrorResponse({
        message: ERROR.RESOURCE.MISSING_RESOURCE.message,
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
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

  await d1.instances.updateMetadata(instanceId, metadata);

  return new Response(null, { status: 204 });
});

// Instance WebSocket endpoint for tasks
agent.get("/instances/:instanceId/ws", async (c) => {
  const instanceId = c.req.param("instanceId");
  const d1 = new D1Store(c.env.BASE_DB);

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
  const kv = KVStore.fromCloudflare(c.env.BASE_KV);
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

  if (token?.instance_id !== instanceId) {
    return c.json(
      createErrorResponse({
        message: ERROR.AUTH.BAD_TOKEN.message,
        code: ERROR.AUTH.BAD_TOKEN.code,
      }),
      ERROR.AUTH.BAD_TOKEN.status,
    );
  }

  const instance = await d1.instances.get(instanceId);
  if (!instance) {
    return c.json(
      createErrorResponse({
        message: ERROR.RESOURCE.MISSING_RESOURCE.message,
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  const id = c.env.INSTANCE_OBJECT.idFromName(instanceId);
  const stub = c.env.INSTANCE_OBJECT.get(id);

  const upgradeReq = new Request(c.req.raw);

  return stub.fetch(upgradeReq);
});

export default agent;
