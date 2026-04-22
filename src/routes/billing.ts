// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { Hono } from "hono";
import { z } from "zod";

import { Bindings, Variables, createSuccessResponse, createErrorResponse, SubscriptionPlan, SubscriptionStatus } from "@/types/index.js";
import { authMiddleware } from "@/middleware/auth.js";
import { DatabaseStore } from "@/lib/db/store/index.js";
import { KVStore } from "@/lib/db/store/kv.js";
import { PolarService } from "@/services/polar.js";
import { EmailService } from "@/services/email.js";
import { notificationTemplate } from "@/lib/templates/emails/notification.js";
import { ERROR, EVENTS } from "@/lib/constants/index.js";
import { getDB, getKV, type AppVariables } from "@/lib/context.js";
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

  const db = new DatabaseStore(getDB(c));

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

  const sub = await db.subscriptions.get(clusterId);
  const plan = await db.subscriptions.getEffectivePlan(clusterId);
  const planDetails = PLANS.find((p) => p.id === plan)!;

  return c.json(
    createSuccessResponse({
      plan,
      planDetails,
      subscription: sub
        ? {
            status: sub.status,
            polarSubscriptionId: sub.polarSubscriptionId,
            createdAt: sub.createdAt,
            updatedAt: sub.updatedAt,
          }
        : null,
    }),
  );
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

  const db = new DatabaseStore(getDB(c));

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

  if (!c.env.POLAR_ACCESS_TOKEN) {
    console.error("[Billing] POLAR_WEBHOOK_SECRET not configured");
    return c.json(
      createErrorResponse({
        message: "Billing is not configured",
        code: ERROR.REQUEST.INTERNAL_SERVER_ERROR.code,
      }),
      ERROR.REQUEST.INTERNAL_SERVER_ERROR.status,
    );
  }

  const polar = new PolarService(c.env);
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
    const customer = await polar.getOrCreateCustomer({
      userId: user.id,
      email: user.email,
      name: user.name || user.email,
    });

    const planDef = PLANS.find((p) => p.id === plan)!;
    const baseSuccessUrl = successUrl || `${c.env.APP_URL}/clusters/${clusterId}/settings/billing?success=1`;

    const resolvedSuccessUrl = new URL(baseSuccessUrl);
    resolvedSuccessUrl.searchParams.set("clusterId", clusterId);

    const checkoutUrl = new URL(planDef.checkoutUrl as string);
    checkoutUrl.searchParams.set("customer_email", user.email);
    checkoutUrl.searchParams.set("success_url", resolvedSuccessUrl.toString());
    checkoutUrl.searchParams.set("metadata[cluster_id]", clusterId);
    checkoutUrl.searchParams.set("metadata[user_id]", user.id);

    await db.subscriptions.upsert({
      clusterId,
      plan: await db.subscriptions.getEffectivePlan(clusterId),
      polarCustomerId: customer.id,
      status: "active",
    });

    return c.json(
      createSuccessResponse({
        checkoutUrl: checkoutUrl.toString(),
        customerId: customer.id,
      }),
    );
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
  const rawBody = await c.req.text();

  if (!c.env.POLAR_WEBHOOK_SECRET) {
    console.error("[Billing] POLAR_WEBHOOK_SECRET not configured");
    return c.json({ received: false }, 500);
  }

  const polar = new PolarService(c.env);
  const isValid = await polar.verifyWebhookSignature({
    rawBody,
    signatureHeader,
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

  const db = new DatabaseStore(getDB(c));
  const kv = new KVStore(getKV(c));

  try {
    await handlePolarWebhook(event, db, kv, c.env);
  } catch (error) {
    console.error("[Billing] Webhook handler error:", error);
    return c.json({ received: true, error: "handler_error" }, 200);
  }

  return c.json({ received: true }, 200);
});

async function handlePolarWebhook(event: { type: string; data: Record<string, unknown> }, db: DatabaseStore, kv: KVStore, env: Bindings): Promise<void> {
  const { type, data } = event;

  console.log(`[Billing] Polar webhook: ${type}`);

  const getClusterId = (): string | null => {
    const metadata = data.metadata as Record<string, unknown> | undefined;
    const sub = data.subscription as Record<string, unknown> | undefined;
    const subMetadata = sub?.["metadata"] as Record<string, unknown> | undefined;
    return (metadata?.["cluster_id"] as string | undefined) || (subMetadata?.["cluster_id"] as string | undefined) || null;
  };

  const sendBillingNotification = async (event: string, clusterId: string, extraData: Record<string, unknown> = {}) => {
    // Check for recent reminder (24h dedup)
    const recentReminder = await kv.getbillingNotification({ clusterId });
    if (recentReminder) {
      console.log(`[Billing] Skipping notification for ${clusterId} (reminder sent within 24h)`);
      return;
    }

    const sub = await db.subscriptions.get(clusterId);
    if (!sub) return;

    // Get cluster to find owner
    const cluster = await db.clusters.get(clusterId);
    if (!cluster) return;

    // Get owner's email
    const ownerEmail = cluster.users.find((id) => cluster.roles.owner.includes(id));
    if (!ownerEmail) return;

    const user = await db.users.get(ownerEmail);
    if (!user) return;

    // Build email data
    const emailData = {
      clusterId,
      clusterName: cluster.name,
      userEmail: user.email,
      plan: sub.plan,
      periodEnd: sub.periodEnd,
      actionUrl: `https://app.dployr.io/clusters/${clusterId}/settings/billing`,
      ...extraData,
    };

    // Send email
    const emailService = new EmailService({ env, to: user.email });
    const html = notificationTemplate(event, emailData);
    const subject = event.includes("failed") ? "Payment Failed - Action Required" : event.includes("canceled") ? "Subscription Canceled" : "Subscription Update";

    await emailService.sendEmail(subject, html);

    // Set reminder key (24h TTL)
    await kv.setReminderNotification({ clusterId });

    console.log(`[Billing] Sent ${event} notification to ${user.email} for cluster ${clusterId}`);
  };

  const getPolarCustomerId = (): string | null => {
    const sub = data.subscription as Record<string, unknown> | undefined;
    return (data.customer_id as string) || (sub?.["customer_id"] as string) || null;
  };

  const getPolarSubscriptionId = (): string | null => {
    const sub = data.subscription as Record<string, unknown> | undefined;
    return (data.id as string) || (sub?.["id"] as string) || null;
  };

  const resolvePlan = (): SubscriptionPlan => {
    const product = data.product as Record<string, unknown> | undefined;
    const sub = data.subscription as Record<string, unknown> | undefined;
    const subProduct = sub?.["product"] as Record<string, unknown> | undefined;
    const metadata = data.metadata as Record<string, unknown> | undefined;
    const productName = (product?.["name"] || subProduct?.["name"] || "").toString().toLowerCase();

    if (productName.includes("pro")) return "pro";
    if (productName.includes("indie")) return "indie";

    const metaPlan = (metadata?.["plan"] as string)?.toLowerCase() || "";
    if (metaPlan === "pro") return "pro";
    if (metaPlan === "indie") return "indie";

    return "indie";
  };

  switch (type) {
    case "subscription.created":
    case "subscription.updated": {
      const clusterId = getClusterId();
      const polarSubscriptionId = getPolarSubscriptionId();
      const polarCustomerId = getPolarCustomerId();

      if (!clusterId) {
        console.warn(`[Billing] ${type}: no cluster_id in metadata, skipping`);
        return;
      }

      const polarStatus = (data.status as string) || "active";
      let status: SubscriptionStatus = "active";
      if (polarStatus === "past_due") {
        status = "past_due";
      }

      const plan = resolvePlan();
      const canceledAt = (data.canceled_at as number) || null;
      const periodEnd = (data.current_period_end as number) || null;

      await db.subscriptions.upsert({
        clusterId,
        plan,
        polarCustomerId,
        polarSubscriptionId,
        status,
        canceledAt,
        periodEnd,
      });

      // send email notification
      await sendBillingNotification(polarStatus === "past_due" ? EVENTS.BILLING.PAYMENT_FAILED.code : EVENTS.BILLING.PAYMENT_SUCCESSFUL.code, clusterId);

      console.log(`[Billing] Cluster ${clusterId} updated to plan=${plan} status=${status}`);
      break;
    }

    case "subscription.canceled": {
      const polarSubscriptionId = getPolarSubscriptionId();
      const clusterId = getClusterId();
      const periodEnd = (data.current_period_end as number) || null;

      if (polarSubscriptionId) {
        const existing = await db.subscriptions.getByPolarSubscriptionId(polarSubscriptionId);
        if (!existing) return;

        await db.subscriptions.upsert({
          clusterId: existing.clusterId,
          plan: existing.plan,
          polarCustomerId: existing.polarCustomerId,
          polarSubscriptionId,
          status: "canceled",
          canceledAt: Date.now(),
          periodEnd,
        });
        console.log(`[Billing] Cluster ${existing.clusterId} marked canceled, period ends at ${periodEnd ? new Date(periodEnd).toISOString() : "unknown"}`);

        // Send notification
        await sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code, existing.clusterId, { periodEnd });
      } else if (clusterId) {
        const existing = await db.subscriptions.get(clusterId);
        if (!existing) return;

        await db.subscriptions.upsert({
          clusterId,
          plan: existing.plan,
          polarCustomerId: existing.polarCustomerId,
          polarSubscriptionId: existing.polarSubscriptionId,
          status: "canceled",
          canceledAt: Date.now(),
          periodEnd,
        });

        console.log(`[Billing] Cluster ${clusterId} marked canceled, period ends at ${periodEnd ? new Date(periodEnd).toISOString() : "unknown"}`);
        await sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code, clusterId, { periodEnd });
      }
      break;
    }

    case "subscription.revoked": {
      // Period ended - now downgrade to hobby
      const polarSubscriptionId = getPolarSubscriptionId();
      if (!polarSubscriptionId) return;

      const existing = await db.subscriptions.getByPolarSubscriptionId(polarSubscriptionId);
      if (!existing) return;

      await db.subscriptions.upsert({
        clusterId: existing.clusterId,
        plan: "hobby",
        polarCustomerId: existing.polarCustomerId,
        polarSubscriptionId,
        status: "active",
        canceledAt: null,
        periodEnd: null,
      });

      // send email notification
await sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_EXPIRED.code, existing.clusterId);
      console.log(`[Billing] Cluster ${existing.clusterId} downgraded to hobby (expired)`);
      break;
    }

    case "subscription.uncanceled": {
      // User re-activated before period ended - restore plan
      const polarSubscriptionId = getPolarSubscriptionId();
      if (!polarSubscriptionId) return;

      const existing = await db.subscriptions.getByPolarSubscriptionId(polarSubscriptionId);
      if (!existing) return;

      await db.subscriptions.upsert({
        clusterId: existing.clusterId,
        plan: existing.plan,
        polarCustomerId: existing.polarCustomerId,
        polarSubscriptionId,
        status: "active",
        canceledAt: null,
        periodEnd: null,
      });

      // send email notification
      await sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_RESUMED.code, existing.clusterId);

      console.log(`[Billing] Cluster ${existing.clusterId} uncanceled, restored to ${existing.plan}`);
      break;
    }

    case "subscription.past_due": {
      const clusterId = getClusterId();
      if (!clusterId) return;

      const existing = await db.subscriptions.get(clusterId);
      if (!existing) return;

      await db.subscriptions.upsert({
        clusterId,
        plan: existing.plan,
        polarCustomerId: existing.polarCustomerId,
        polarSubscriptionId: existing.polarSubscriptionId,
        status: "past_due",
      });

      console.log(`[Billing] Cluster ${clusterId} payment past due`);

      // Send payment failed notification
      await sendBillingNotification(EVENTS.BILLING.PAYMENT_FAILED.code, clusterId);
      break;
    }

    case "order.created": {
      console.log(`[Billing] Order created: ${data.id}`);
      break;
    }

    default:
      console.log(`[Billing] Unhandled Polar event: ${type}`);
  }
}

export default billing;
