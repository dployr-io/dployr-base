// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings, SubscriptionPlan, SubscriptionStatus } from "@/types/index.js";
import type { DatabaseStore } from "@/lib/db/store/db/index.js";
import type { KVStore } from "@/lib/db/store/kv/index.js";
import type { BillingProvider } from "./provider.js";
import { ZeptoProvider } from "@/services/notifications/email/zepto.js";
import { notificationTemplate } from "@/lib/templates/emails/notification.js";
import { EVENTS } from "@/lib/constants/index.js";
import { PLANS } from "@/lib/constants/billing.js";

export type PolarWebhookEvent = { type: string; data: Record<string, unknown> };

export interface CheckoutParams {
  plan: SubscriptionPlan;
  clusterId: string;
  userId: string;
  email: string;
  name: string;
  successUrl?: string;
}

export class BillingService {
  constructor(
    private provider: BillingProvider,
    private env: Bindings,
  ) {}

  private toEpochMs(value: unknown): number | null {
    if (!value) return null;
    if (typeof value === "number") return value;
    if (typeof value === "string") {
      const ms = new Date(value).getTime();
      return isNaN(ms) ? null : ms;
    }
    return null;
  }

  async getStatus({ clusterId, db }: { clusterId: string; db: DatabaseStore }): Promise<{
    plan: SubscriptionPlan | null;
    planDetails: (typeof PLANS)[number] | null;
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
    const customer = await this.provider.getOrCreateCustomer({
      userId: params.userId,
      email: params.email,
      name: params.name,
      clusterId: params.clusterId,
    });

    const checkoutUrl = await this.provider.buildCheckoutUrl(params);

    await db.subscriptions.upsert({
      clusterId: params.clusterId,
      plan: await db.subscriptions.getEffectivePlan(params.clusterId),
      polarCustomerId: customer.id,
      status: "active",
    });

    return { checkoutUrl, customerId: customer.id };
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

  private async sendBillingNotification(event: string, clusterId: string, db: DatabaseStore, kv: KVStore, extraData?: Record<string, unknown>): Promise<void> {
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

    const user = await db.users.find({ email: ownerEmail });
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

    const emailProvider = new ZeptoProvider(this.env);
    const html = notificationTemplate(event, emailData);
    const subject = event.includes("failed") ? "Payment Failed - Action Required" : event.includes("canceled") ? "Subscription Canceled" : "Subscription Update";

    await emailProvider.sendEmail({ to: user.email, subject, body: html });
    await kv.setReminderNotification({ clusterId });

    console.log(`[Billing] Sent ${event} notification to ${user.email} for cluster ${clusterId}`);
  }

  private getPolarReferencedClusterId(data: Record<string, unknown>): string | null {
    const customer = data.customer as Record<string, unknown> | undefined;
    return (customer?.["external_id"] as string | undefined) || null;
  }

  private getPolarCustomerId(data: Record<string, unknown>): string | null {
    const customer = data.customer as Record<string, unknown> | undefined;
    return (customer?.["id"] as string | undefined) || (data?.["customer_id"] as string | undefined) || null;
  }

  private getPolarSubscriptionId(data: Record<string, unknown>): string | null {
    return (data?.["id"] as string | undefined) || null;
  }

  private resolvePlan(data: Record<string, unknown>): SubscriptionPlan {
    const product = data.product as Record<string, unknown> | undefined;
    const productName = (product?.["name"] || "").toString().toLowerCase();
    if (productName.includes("pro")) return "pro";
    if (productName.includes("indie")) return "indie";
    return "indie";
  }

  private async onSubscriptionCreatedOrUpdated(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const clusterId = this.getPolarReferencedClusterId(data);
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    const polarCustomerId = this.getPolarCustomerId(data);

    if (!clusterId) {
      console.warn(`[Billing] subscription.created/updated: no cluster_id in metadata, skipping`);
      return;
    }

    const previousPlan = await db.subscriptions.getEffectivePlan(clusterId);

    const polarStatus = (data.status as string) || "active";
    const status: SubscriptionStatus = polarStatus === "past_due" ? "past_due" : "active";
    const plan = this.resolvePlan(data);
    const canceledAt = this.toEpochMs(data.canceled_at);
    const periodEnd = this.toEpochMs(data.current_period_end);

    await db.subscriptions.upsert({ clusterId, plan, polarCustomerId, polarSubscriptionId, status, canceledAt, periodEnd });

    if (previousPlan === "hobby" && plan !== "hobby") {
      try {
        await db.instances.releasePoolInstance(clusterId);
        console.log(`[Billing] Released free instance for cluster ${clusterId} (upgraded from hobby to ${plan})`);
      } catch (error) {
        console.error(`[Billing] Failed to release free instance for cluster ${clusterId}:`, error);
      }
    } else if (previousPlan !== "hobby" && plan === "hobby") {
      try {
        await db.instances.assignPool(clusterId);
        console.log(`[Billing] Assigned free instance for cluster ${clusterId} (downgraded back to hobby)`);
      } catch (error) {
        console.error(`[Billing] Failed to assign free instance for cluster ${clusterId}:`, error);
      }
    }

    await this.sendBillingNotification(polarStatus === "past_due" ? EVENTS.BILLING.PAYMENT_FAILED.code : EVENTS.BILLING.PAYMENT_SUCCESSFUL.code, clusterId, db, kv);

    console.log(`[Billing] Cluster ${clusterId} updated to plan=${plan} status=${status}`);
  }

  private async onSubscriptionCanceled(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    const clusterId = this.getPolarReferencedClusterId(data);
    const periodEnd = this.toEpochMs(data.current_period_end);

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

      console.log(`[Billing] Cluster ${existing.clusterId} marked canceled`);
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

      console.log(`[Billing] Cluster ${clusterId} marked canceled`);
      await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code, clusterId, db, kv, { periodEnd });
    }
  }

  private async onSubscriptionRevoked(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    if (!polarSubscriptionId) return;

    const existing = await db.subscriptions.getByPolarSubscriptionId(polarSubscriptionId);
    if (!existing) return;

    const previousPlan = await db.subscriptions.getEffectivePlan(existing.clusterId);

    await db.subscriptions.upsert({
      clusterId: existing.clusterId,
      plan: "hobby",
      polarCustomerId: existing.polarCustomerId,
      polarSubscriptionId,
      status: "active",
      canceledAt: null,
      periodEnd: null,
    });

    if (previousPlan !== "hobby") {
      try {
        await db.instances.assignPool(existing.clusterId);
        console.log(`[Billing] Assigned free instance for cluster ${existing.clusterId} (subscription revoked, downgraded to hobby)`);
      } catch (error) {
        console.error(`[Billing] Failed to assign free instance for cluster ${existing.clusterId}:`, error);
      }
    }

    await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_EXPIRED.code, existing.clusterId, db, kv);
    console.log(`[Billing] Cluster ${existing.clusterId} downgraded to hobby (expired)`);
  }

  private async onSubscriptionUncanceled(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    if (!polarSubscriptionId) return;

    const existing = await db.subscriptions.getByPolarSubscriptionId(polarSubscriptionId);
    if (!existing) return;

    const previousPlan = await db.subscriptions.getEffectivePlan(existing.clusterId);

    await db.subscriptions.upsert({
      clusterId: existing.clusterId,
      plan: existing.plan,
      polarCustomerId: existing.polarCustomerId,
      polarSubscriptionId,
      status: "active",
      canceledAt: null,
      periodEnd: null,
    });

    if (previousPlan === "hobby" && existing.plan !== "hobby") {
      try {
        await db.instances.releasePoolInstance(existing.clusterId);
        console.log(`[Billing] Released free instance for cluster ${existing.clusterId} (subscription uncanceled, upgraded back to ${existing.plan})`);
      } catch (error) {
        console.error(`[Billing] Failed to release free instance for cluster ${existing.clusterId}:`, error);
      }
    }

    await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_RESUMED.code, existing.clusterId, db, kv);
    console.log(`[Billing] Cluster ${existing.clusterId} uncanceled, restored to ${existing.plan}`);
  }

  private async onSubscriptionPastDue(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const clusterId = this.getPolarReferencedClusterId(data);
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
