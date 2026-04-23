// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";

import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { authMiddleware } from "@/middleware/auth.js";
import { BillingService } from "@/services/billing.js";
import { ERROR } from "@/lib/constants/index.js";
import { getKVStore, getBillingProvider, type AppVariables, getDbStore } from "@/lib/context.js";
import { PLANS } from "@/lib/constants/billing.js";

const billing = new Hono<{ Bindings: Bindings; Variables: Variables & AppVariables }>();

const checkoutSchema = z.object({
  plan: z.enum(["indie", "pro"]),
  clusterId: z.string().min(1),
  successUrl: z.url().optional(),
});

billing.get("/plans", (c) => {
  return c.json(createSuccessResponse({ plans: PLANS }));
});

billing.get("/status", authMiddleware, async (c) => {
  const session = c.get("session")!;
  const clusterId = c.req.query("clusterId");

  if (!clusterId) {
    return c.json(
      createErrorResponse({
        message: "clusterId is required",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const db = getDbStore(c);

  const canRead = await db.clusters.canRead(session.userId, clusterId);
  if (!canRead) {
    return c.json(
      createErrorResponse({
        message: "Insufficient permissions",
        code: ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.code,
      }),
      ERROR.PERMISSION.VIEWER_ROLE_REQUIRED.status,
    );
  }

  const billingProvider = getBillingProvider(c);
  if (!billingProvider) {
    return c.json(
      createErrorResponse({
        message: "Billing is not configured",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }

  const billingService = new BillingService(billingProvider, c.env);
  const result = await billingService.getStatus(clusterId, session.userId, db);

  return c.json(createSuccessResponse(result));
});

billing.post("/checkout", authMiddleware, async (c) => {
  const session = c.get("session")!;

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json(
      createErrorResponse({
        message: "Invalid request body",
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const validation = checkoutSchema.safeParse(body);
  if (!validation.success) {
    const message = validation.error.issues.map((e) => `${e.path.join(".")}: ${e.message}`).join(", ");
    return c.json(
      createErrorResponse({
        message: `Validation failed — ${message}`,
        code: ERROR.REQUEST.BAD_REQUEST.code,
      }),
      ERROR.REQUEST.BAD_REQUEST.status,
    );
  }

  const { plan, clusterId, successUrl } = validation.data;

  const db = getDbStore(c);

  const isOwner = await db.clusters.isOwner(session.userId, clusterId);
  if (!isOwner) {
    return c.json(
      createErrorResponse({
        message: "Only the cluster owner can manage billing",
        code: ERROR.PERMISSION.OWNER_ROLE_REQUIRED.code,
      }),
      ERROR.PERMISSION.OWNER_ROLE_REQUIRED.status,
    );
  }

  const billingProvider = getBillingProvider(c);
  if (!billingProvider) {
    console.error("[Billing] Billing provider not configured");
    return c.json(
      createErrorResponse({
        message: "Billing is not configured",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }

  const user = await db.users.get(session.email);

  if (!user) {
    return c.json(
      createErrorResponse({
        message: "User not found",
        code: ERROR.RESOURCE.MISSING_RESOURCE.code,
      }),
      ERROR.RESOURCE.MISSING_RESOURCE.status,
    );
  }

  try {
    const billingService = new BillingService(billingProvider, c.env);
    const result = await billingService.createCheckout(
      {
        plan,
        clusterId,
        userId: user.id,
        email: user.email,
        name: user.name || user.email,
        successUrl,
      },
      db,
    );

    return c.json(createSuccessResponse(result));
  } catch (error) {
    console.error("Billing checkout error:", error);
    return c.json(
      createErrorResponse({
        message: "Failed to create checkout session",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }
});

billing.post("/webhook", async (c) => {
  const signatureHeader = c.req.header("webhook-signature") || "";
  const webhookId = c.req.header("webhook-id") || "";
  const webhookTimestamp = c.req.header("webhook-timestamp") || "";
  let rawBody = await c.req.text();
  rawBody = rawBody.trim(); 

  if (!c.env.POLAR_WEBHOOK_SECRET) {
    console.error("[Billing] POLAR_WEBHOOK_SECRET not configured");
    return c.json({ received: false }, 500);
  }

  const billingProvider = getBillingProvider(c);
  if (!billingProvider) {
    console.error("[Billing] Billing provider not configured");
    return c.json({ received: false }, 500);
  }

  const isValid = await billingProvider.verifyWebhookSignature({
    rawBody,
    signatureHeader,
    webhookId,
    webhookTimestamp,
  });

  if (!isValid) {
    console.warn("[Billing] Invalid webhook signature");
    return c.json({ received: false }, 400);
  }

  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(rawBody);
  } catch {
    return c.json({ received: false }, 400);
  }

  const db = getDbStore(c);
  const kv = getKVStore(c);

  try {
    const billingService = new BillingService(billingProvider, c.env);
    await billingService.handleWebhook(event, db, kv);
  } catch (error) {
    console.error("[Billing] Webhook handler error:", error);
    return c.json({ received: true, error: "handler_error" }, 200);
  }

  return c.json({ received: true }, 200);
});

export default billing;
