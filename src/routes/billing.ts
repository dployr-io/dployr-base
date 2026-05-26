// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";

import { Bindings, Variables, createSuccessResponse, createErrorResponse } from "@/types/index.js";
import { requireClusterViewer, requireClusterOwner } from "@/middleware/auth.js";
import { PolarRequestValidationError } from "@/lib/errors/errors.js";
import { ERROR } from "@/lib/constants/index.js";
import { getKVStore, getBillingProvider, getBillingService, getDbStore } from "@/lib/config/context.js";
import { PLANS } from "@/lib/constants/billing.js";
import { Logger } from "@/lib/logger.js";

const log = new Logger("billing");

const billing = new Hono<{ Bindings: Bindings; Variables: Variables }>();

const checkoutSchema = z.object({
  plan: z.enum(["indie", "pro"]),
  interval: z.enum(["monthly", "annual"]).default("monthly"),
  clusterId: z.string().min(1),
  successUrl: z.url().optional(),
});

billing.get("/plans", (c) => {
  return c.json(createSuccessResponse({ plans: PLANS }));
});

billing.get("/status", requireClusterViewer, async (c) => {
  const clusterId = c.req.query("clusterId")!;
  const db = getDbStore(c);
  const billingService = getBillingService(c);
  if (!billingService) {
    return c.json(
      createErrorResponse({
        message: "Billing is not configured",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }

  const result = await billingService.getStatus({ clusterId, db });

  return c.json(createSuccessResponse(result));
});

billing.post("/checkout", requireClusterOwner, async (c) => {
  const session = c.get("session")!;
  const  body = await c.req.json();
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

  const { plan, interval, clusterId, successUrl } = validation.data;
  const db = getDbStore(c);
  const billingService = getBillingService(c);
  if (!billingService) {
    log.error("Billing provider not configured");
    return c.json(
      createErrorResponse({
        message: "Billing is not configured",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }

  const user = await db.users.find({ email: session.email });
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
    const result = await billingService.createCheckout(
      {
        plan,
        interval,
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
    if (error instanceof PolarRequestValidationError) {
      return c.json(
        createErrorResponse({
          message: error.message,
          code: ERROR.REQUEST.BAD_REQUEST.code,
        }),
        ERROR.REQUEST.BAD_REQUEST.status,
      );
    }
    log.error("Billing checkout error:", error);
    return c.json(
      createErrorResponse({
        message: "Failed to create checkout session",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }
});

billing.get("/portal", requireClusterOwner, async (c) => {
  const clusterId = c.req.query("clusterId")!;
  const billingProvider = getBillingProvider(c);
  if (!billingProvider) {
    return c.json(
      createErrorResponse({ message: "Billing is not configured", code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }

  try {
    const portalUrl = await billingProvider.createCustomerPortalSession(clusterId);
    return c.redirect(portalUrl, 302);
  } catch (error) {
    log.error("Failed to create customer portal session:", error);
    return c.json(
      createErrorResponse({ message: "Failed to open subscription portal", code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }
});

billing.post("/webhook", async (c) => {
  const signatureHeader = c.req.header("webhook-signature") || "";
  const webhookId = c.req.header("webhook-id") || "";
  const webhookTimestamp = c.req.header("webhook-timestamp") || "";
  const rawBody = (await c.req.text()).trim();

  if (!c.env.POLAR_WEBHOOK_SECRET) {
    log.error("POLAR_WEBHOOK_SECRET not configured");
    return c.json({ received: false }, 500);
  }

  const billingProvider = getBillingProvider(c);
  if (!billingProvider) {
    log.error("Billing provider not configured");
    return c.json({ received: false }, 500);
  }

  const isValid = await billingProvider.verifyWebhookSignature({
    rawBody,
    signatureHeader,
    webhookId,
    webhookTimestamp,
  });

  if (!isValid) {
    log.warn("Invalid webhook signature");
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
    await getBillingService(c)!.handleWebhook(event, db, kv);
  } catch (error) {
    log.error("Webhook handler error:", error);
    return c.json({ received: true, error: "handler_error" }, 200);
  }

  return c.json({ received: true }, 200);
});

export default billing;
