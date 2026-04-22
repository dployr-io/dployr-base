// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings, SubscriptionPlan, SubscriptionStatus } from "@/types/index.js";
import type { DatabaseStore } from "@/lib/db/store/index.js";
import type { KVStore } from "@/lib/db/store/kv.js";
import type { BillingProvider } from "./billing/provider.js";
import { EmailService } from "@/services/email.js";
import { notificationTemplate } from "@/lib/templates/emails/notification.js";
import { EVENTS } from "@/lib/constants/index.js";
import { PLANS } from "@/lib/constants/billing.js";

export type PolarWebhookEvent = { type: string; data: Record<string, unknown> }

export interface CheckoutParams {
  plan: SubscriptionPlan
  clusterId: string
  userId: string
  email: string
  name: string
  successUrl?: string
}

export class BillingService {
  constructor(
    private provider: BillingProvider,
    private env: Bindings
  ) {}

  async getStatus(clusterId: string, userId: string, db: DatabaseStore): Promise<{
    plan: SubscriptionPlan | null;
    planDetails: typeof PLANS[number] | null;
    subscription: {
      status: SubscriptionStatus;
      polarSubscriptionId: string | null;
      createdAt: number;
      updatedAt: number;
    } | null;
  }> {
    const sub = await db.subscriptions.get(clusterId);
    const plan = await db.subscriptions.getEffectivePlan(clusterId);
    const planDetails = PLANS.find((p) => p.id === plan) || null;

    return {
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
    };
  }

  async createCheckout(params: CheckoutParams, db: DatabaseStore): Promise<{ checkoutUrl: string; customerId: string }> {
    const checkoutUrl = await this.provider.buildCheckoutUrl(params);
    
    const customer = await this.provider.getOrCreateCustomer({
      userId: params.userId,
      email: params.email,
      name: params.name,
    });

    await db.subscriptions.upsert({
      clusterId: params.clusterId,
      plan: await db.subscriptions.getEffectivePlan(params.clusterId),
      polarCustomerId: customer.id,
      status: "active",
    });

    return {
      checkoutUrl,
      customerId: customer.id,
    };
  }

  async handleWebhook(event: PolarWebhookEvent, db: DatabaseStore, kv: KVStore): Promise<void> {
    const { type, data } = event;

    console.log(`[Billing] Polar webhook: ${type}`);

    switch (type) {
      case "subscription.created":
      case "subscription.updated":
        await this.onSubscriptionCreatedOrUpdated(data, db, kv);
        break;

      case "subscription.canceled":
        await this.onSubscriptionCanceled(data, db, kv);
        break;

      case "subscription.revoked":
        await this.onSubscriptionRevoked(data, db, kv);
        break;

      case "subscription.uncanceled":
        await this.onSubscriptionUncanceled(data, db, kv);
        break;

      case "subscription.past_due":
        await this.onSubscriptionPastDue(data, db, kv);
        break;

      case "order.created":
        console.log(`[Billing] Order created: ${data.id}`);
        break;

      default:
        console.log(`[Billing] Unhandled Polar event: ${type}`);
    }
  }

  private async sendBillingNotification(
    event: string,
    clusterId: string,
    db: DatabaseStore,
    kv: KVStore,
    extraData?: Record<string, unknown>
  ): Promise<void> {
    const recentReminder = await kv.getbillingNotification({ clusterId });
    if (recentReminder) {
      console.log(`[Billing] Skipping notification for ${clusterId} (reminder sent within 24h)`);
      return;
    }

    const sub = await db.subscriptions.get(clusterId);
    if (!sub) return;

    const cluster = await db.clusters.get(clusterId);
    if (!cluster) return;

    const ownerEmail = cluster.users.find((id) => cluster.roles.owner.includes(id));
    if (!ownerEmail) return;

    const user = await db.users.get(ownerEmail);
    if (!user) return;

    const emailData = {
      clusterId,
      clusterName: cluster.name,
      userEmail: user.email,
      plan: sub.plan,
      periodEnd: sub.periodEnd,
      actionUrl: `https://app.dployr.io/clusters/${clusterId}/settings/billing`,
      ...extraData,
    };

    const emailService = new EmailService({ env: this.env, to: user.email });
    const html = notificationTemplate(event, emailData);
    const subject = event.includes("failed") ? "Payment Failed - Action Required" : event.includes("canceled") ? "Subscription Canceled" : "Subscription Update";

    await emailService.sendEmail(subject, html);

    await kv.setReminderNotification({ clusterId });

    console.log(`[Billing] Sent ${event} notification to ${user.email} for cluster ${clusterId}`);
  }

  private getClusterId(data: Record<string, unknown>): string | null {
    const metadata = data.metadata as Record<string, unknown> | undefined;
    const sub = data.subscription as Record<string, unknown> | undefined;
    const subMetadata = sub?.["metadata"] as Record<string, unknown> | undefined;
    return (metadata?.["cluster_id"] as string | undefined) || (subMetadata?.["cluster_id"] as string | undefined) || null;
  }

  private getPolarCustomerId(data: Record<string, unknown>): string | null {
    const sub = data.subscription as Record<string, unknown> | undefined;
    return (data.customer_id as string) || (sub?.["customer_id"] as string) || null;
  }

  private getPolarSubscriptionId(data: Record<string, unknown>): string | null {
    const sub = data.subscription as Record<string, unknown> | undefined;
    return (data.id as string) || (sub?.["id"] as string) || null;
  }

  private resolvePlan(data: Record<string, unknown>): SubscriptionPlan {
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
  }

  private async onSubscriptionCreatedOrUpdated(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const clusterId = this.getClusterId(data);
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    const polarCustomerId = this.getPolarCustomerId(data);

    if (!clusterId) {
      console.warn(`[Billing] subscription.created/updated: no cluster_id in metadata, skipping`);
      return;
    }

    const polarStatus = (data.status as string) || "active";
    let status: SubscriptionStatus = "active";
    if (polarStatus === "past_due") {
      status = "past_due";
    }

    const plan = this.resolvePlan(data);
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

    await this.sendBillingNotification(polarStatus === "past_due" ? EVENTS.BILLING.PAYMENT_FAILED.code : EVENTS.BILLING.PAYMENT_SUCCESSFUL.code, clusterId, db, kv);

    console.log(`[Billing] Cluster ${clusterId} updated to plan=${plan} status=${status}`);
  }

  private async onSubscriptionCanceled(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    const clusterId = this.getClusterId(data);
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

      await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code, existing.clusterId, db, kv, { periodEnd });
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
      await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code, clusterId, db, kv, { periodEnd });
    }
  }

  private async onSubscriptionRevoked(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
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

    await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_EXPIRED.code, existing.clusterId, db, kv);
    console.log(`[Billing] Cluster ${existing.clusterId} downgraded to hobby (expired)`);
  }

  private async onSubscriptionUncanceled(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
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

    await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_RESUMED.code, existing.clusterId, db, kv);

    console.log(`[Billing] Cluster ${existing.clusterId} uncanceled, restored to ${existing.plan}`);
  }

  private async onSubscriptionPastDue(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const clusterId = this.getClusterId(data);
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

    await this.sendBillingNotification(EVENTS.BILLING.PAYMENT_FAILED.code, clusterId, db, kv);
  }
}