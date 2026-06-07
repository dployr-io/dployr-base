// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { SubscriptionPlan, SubscriptionStatus } from "@/types/index.js";
import type { DatabaseStore } from "@/lib/db/store/db/index.js";
import type { KVStore } from "@/lib/db/store/kv/index.js";
import type { BillingProvider } from "./provider.js";
import type { EmailService } from "@/services/notifications/email/index.js";
import { EVENTS } from "@/lib/constants/index.js";
import { PLANS } from "@/lib/constants/billing.js";
import { Logger } from "@/lib/logger.js";
import {
  paymentSuccessEmail,
  paymentFailedEmail,
  subscriptionCancelledEmail,
  subscriptionExpiredEmail,
  subscriptionResumedEmail,
} from "@/lib/templates/emails/index.js";

const log = new Logger("BillingService");

export type PolarWebhookEvent = { type: string; data: Record<string, unknown> };

export interface CheckoutParams {
  plan: SubscriptionPlan;
  interval: "monthly" | "annual";
  clusterId: string;
  userId: string;
  email: string;
  name: string;
  successUrl?: string;
}

export class BillingService {
  constructor(
    private provider: BillingProvider,
    private emailService: EmailService | null,
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

  async createCheckout(params: CheckoutParams, _db: DatabaseStore): Promise<{ checkoutUrl: string }> {
    const checkoutUrl = await this.provider.createCheckoutSession(params);
    return { checkoutUrl };
  }

  async handleWebhook(event: PolarWebhookEvent, db: DatabaseStore, kv: KVStore): Promise<void> {
    const { type, data } = event;

    log.debug(`Polar webhook: ${type}`);

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

  private async sendBillingNotification(
    event:
      | typeof EVENTS.BILLING.PAYMENT_SUCCESSFUL.code
      | typeof EVENTS.BILLING.PAYMENT_FAILED.code
      | typeof EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code
      | typeof EVENTS.BILLING.SUBSCRIPTION_EXPIRED.code
      | typeof EVENTS.BILLING.SUBSCRIPTION_RESUMED.code,
    clusterId: string,
    db: DatabaseStore,
    kv: KVStore,
    extraData?: { periodEnd?: number | null },
  ): Promise<void> {
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
    if (!user || !this.emailService) return;

    const base = { plan: sub.plan, clusterName: cluster.name, clusterId };

    switch (event) {
      case EVENTS.BILLING.PAYMENT_SUCCESSFUL.code:
        await this.emailService.send(user.email, paymentSuccessEmail, base);
        break;
      case EVENTS.BILLING.PAYMENT_FAILED.code:
        await this.emailService.send(user.email, paymentFailedEmail, base);
        break;
      case EVENTS.BILLING.SUBSCRIPTION_CANCELLED.code:
        await this.emailService.send(user.email, subscriptionCancelledEmail, { ...base, periodEnd: extraData?.periodEnd ?? null });
        break;
      case EVENTS.BILLING.SUBSCRIPTION_EXPIRED.code:
        await this.emailService.send(user.email, subscriptionExpiredEmail, { clusterName: cluster.name, clusterId });
        break;
      case EVENTS.BILLING.SUBSCRIPTION_RESUMED.code:
        await this.emailService.send(user.email, subscriptionResumedEmail, base);
        break;
    }

    await kv.setReminderNotification({ clusterId });
    log.debug(`Sent ${event} notification to ${user.email} for cluster ${clusterId}`);
  }

  private getPolarReferencedClusterId(data: Record<string, unknown>): string | null {
    const customer = data.customer as Record<string, unknown> | undefined;
    const fromCustomer = (customer?.["external_id"] as string | undefined) || null;
    if (fromCustomer) return fromCustomer;

    const metadata = data.metadata as Record<string, unknown> | undefined;
    const fromMeta = (metadata?.["cluster_id"] as string | undefined) || null;
    return fromMeta;
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
    let clusterId = this.getPolarReferencedClusterId(data);
    const polarSubscriptionId = this.getPolarSubscriptionId(data);
    const polarCustomerId = this.getPolarCustomerId(data);

    if (!clusterId) {
      if (polarSubscriptionId) {
        const existing = await db.billing.getByPolarSubscriptionId(polarSubscriptionId);
        if (existing) clusterId = existing.clusterId;
      }

      if (!clusterId && polarCustomerId) {
        const existing = await db.billing.getByPolarCustomerId(polarCustomerId);
        if (existing) clusterId = existing.clusterId;
      }
    }

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
      // release pool slot and clear any stale dedicated instance record so
      // NodeDoctor picks this cluster up and provisions a fresh dedicated instance on its next sync.
      if (to === "pro") {
        await db.instances.releasePoolInstance(clusterId);
        await db.instances.releaseDedicatedInstance(clusterId);
        log.info(`Released instance assignments for "${name}" (upgrading to pro)`);
        return;
      }

      // Downgrading from pro:
      // atomic transaction: releases dedicated record and assigns to shared pool
      // in one shot so NodeDoctor never observes the cluster as unassigned.
      if (from === "pro") {
        await db.instances.transitionToSharedPool(clusterId, to);
        log.info(`Transitioned "${name}" from dedicated to ${to} pool (downgrading from pro)`);
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
    let clusterId = this.getPolarReferencedClusterId(data);

    if (!clusterId) {
      const polarSubscriptionId = this.getPolarSubscriptionId(data);
      if (polarSubscriptionId) {
        const existing = await db.billing.getByPolarSubscriptionId(polarSubscriptionId);
        if (existing) clusterId = existing.clusterId;
      }
    }

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
