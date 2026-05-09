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
import { Logger } from "@/lib/logger.js";

const log = new Logger("BillingService");

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
    const sub = await db.billing.get(clusterId);
    const plan = await db.billing.getEffectivePlan(clusterId);
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

    await db.billing.upsert({
      clusterId: params.clusterId,
      plan: await db.billing.getEffectivePlan(params.clusterId),
      polarCustomerId: customer.id,
      status: "active",
    });

    return { checkoutUrl, customerId: customer.id };
  }

  async handleWebhook(event: PolarWebhookEvent, db: DatabaseStore, kv: KVStore): Promise<void> {
    const { type, data } = event;

    log.info(`Polar webhook: ${type}`);

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
        log.info(`Order created: ${data.id}`);
        break;
      default:
        log.info(`Unhandled Polar event: ${type}`);
    }
  }

  private async sendBillingNotification(event: string, clusterId: string, db: DatabaseStore, kv: KVStore, extraData?: Record<string, unknown>): Promise<void> {
    const recentReminder = await kv.getbillingNotification({ clusterId });
    if (recentReminder) {
      log.info(`Skipping notification for ${clusterId} (reminder sent within 24h)`);
      return;
    }

    const sub = await db.billing.get(clusterId);
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

    log.info(`Sent ${event} notification to ${user.email} for cluster ${clusterId}`);
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
      log.warn("subscription.created/updated: no cluster_id in metadata, skipping");
      return;
    }

    const previousPlan = await db.billing.getEffectivePlan(clusterId);

    const polarStatus = (data.status as string) || "active";
    const status: SubscriptionStatus = polarStatus === "past_due" ? "past_due" : "active";
    const plan = this.resolvePlan(data);
    const canceledAt = this.toEpochMs(data.canceled_at);
    const periodEnd = this.toEpochMs(data.current_period_end);

    await db.billing.upsert({ clusterId, plan, polarCustomerId, polarSubscriptionId, status, canceledAt, periodEnd });

    if (previousPlan !== plan) {
      await this.transitionPlan({ clusterId, from: previousPlan, to: plan, db });
    }

    await this.sendBillingNotification(polarStatus === "past_due" ? EVENTS.BILLING.PAYMENT_FAILED.code : EVENTS.BILLING.PAYMENT_SUCCESSFUL.code, clusterId, db, kv);

    log.info(`Cluster ${clusterId} updated to plan=${plan} status=${status}`);
  }

  private async onSubscriptionCanceled(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    const clusterId = this.getPolarReferencedClusterId(data);
    const periodEnd = this.toEpochMs(data.current_period_end);

    if (polarSubscriptionId) {
      const existing = await db.billing.getByPolarSubscriptionId(polarSubscriptionId);
      if (!existing) return;

      await db.billing.upsert({
        clusterId: existing.clusterId,
        plan: existing.plan,
        polarCustomerId: existing.polarCustomerId,
        polarSubscriptionId,
        status: "canceled",
        canceledAt: Date.now(),
        periodEnd,
      });

      log.info(`Cluster ${existing.clusterId} marked canceled`);
      await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code, existing.clusterId, db, kv, { periodEnd });
    } else if (clusterId) {
      const existing = await db.billing.get(clusterId);
      if (!existing) return;

      await db.billing.upsert({
        clusterId,
        plan: existing.plan,
        polarCustomerId: existing.polarCustomerId,
        polarSubscriptionId: existing.polarSubscriptionId,
        status: "canceled",
        canceledAt: Date.now(),
        periodEnd,
      });

      log.info(`Cluster ${clusterId} marked canceled`);
      await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code, clusterId, db, kv, { periodEnd });
    }
  }

  private async onSubscriptionRevoked(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    if (!polarSubscriptionId) return;

    const existing = await db.billing.getByPolarSubscriptionId(polarSubscriptionId);
    if (!existing) return;

    const previousPlan = await db.billing.getEffectivePlan(existing.clusterId);

    await db.billing.upsert({
      clusterId: existing.clusterId,
      plan: "hobby",
      polarCustomerId: existing.polarCustomerId,
      polarSubscriptionId,
      status: "active",
      canceledAt: null,
      periodEnd: null,
    });

    if (previousPlan !== "hobby") {
      await this.transitionPlan({ clusterId: existing.clusterId, from: previousPlan, to: "hobby", db });
    }

    await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_EXPIRED.code, existing.clusterId, db, kv);
    log.info(`Cluster ${existing.clusterId} downgraded to hobby (expired)`);
  }

  private async onSubscriptionUncanceled(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    if (!polarSubscriptionId) return;

    const existing = await db.billing.getByPolarSubscriptionId(polarSubscriptionId);
    if (!existing) return;

    const previousPlan = await db.billing.getEffectivePlan(existing.clusterId);

    await db.billing.upsert({
      clusterId: existing.clusterId,
      plan: existing.plan,
      polarCustomerId: existing.polarCustomerId,
      polarSubscriptionId,
      status: "active",
      canceledAt: null,
      periodEnd: null,
    });

    if (previousPlan !== existing.plan) {
      await this.transitionPlan({ clusterId: existing.clusterId, from: previousPlan, to: existing.plan, db });
    }

    await this.sendBillingNotification(EVENTS.BILLING.SUBSCRIPTION_RESUMED.code, existing.clusterId, db, kv);
    log.info(`Cluster ${existing.clusterId} uncanceled, restored to ${existing.plan}`);
  }

  /**
   * Handle all instance reassignment when a cluster moves between plans.
   *
   * hobby ↔ indie : pool swap (different tier, different capacity)
   * any   → pro   : release pool; node-doctor provisions dedicated on next sync
   * pro   → any   : assign target pool; dedicated instance stays running until decommissioned
   */
  private async transitionPlan({ clusterId, from, to, db }: { clusterId: string; from: SubscriptionPlan; to: SubscriptionPlan; db: DatabaseStore }): Promise<void> {
    const cluster = await db.clusters.get(clusterId);
    const name = cluster?.name;

    try {
      // Upgrading to pro:
      // remove the cluster from the shared pool system
      if (to === "pro") {
        await db.instances.releasePoolInstance(clusterId);
        log.info(`Released pool instance for "${name}" (upgrading to pro)`);
        return;
      }

      // Downgrading from pro:
      // assign the cluster to the target shared pool
      if (from === "pro") {
        await db.instances.assignPool(clusterId, to);
        log.info(`Assigned "${name}" to ${to} pool (downgrading from pro)`);
        return;
      }

      // Moving between shared tiers (hobby ↔ indie):
      // move the cluster from one pool to another
      await db.instances.releasePoolInstance(clusterId);
      await db.instances.assignPool(clusterId, to);

      log.info(`Moved "${name}" from ${from} pool to ${to} pool`);
    } catch (error) {
      log.error(`Failed to transition "${name}" from ${from} to ${to}`, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async onSubscriptionPastDue(data: Record<string, unknown>, db: DatabaseStore, kv: KVStore): Promise<void> {
    const clusterId = this.getPolarReferencedClusterId(data);
    if (!clusterId) return;

    const existing = await db.billing.get(clusterId);
    if (!existing) return;

    await db.billing.upsert({
      clusterId,
      plan: existing.plan,
      polarCustomerId: existing.polarCustomerId,
      polarSubscriptionId: existing.polarSubscriptionId,
      status: "past_due",
    });

    log.info(`Cluster ${clusterId} payment past due`);
    await this.sendBillingNotification(EVENTS.BILLING.PAYMENT_FAILED.code, clusterId, db, kv);
  }
}
