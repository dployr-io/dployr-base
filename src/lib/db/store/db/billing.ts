// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { ClusterSubscription, SubscriptionPlan, SubscriptionStatus } from "@/types/index.js";
import { type AllowedTable } from "@/lib/constants/index.js";
import { BaseStore } from "./base.js";

export class BillingStore extends BaseStore {
  protected readonly storeTable: AllowedTable = "billing";
  async get(clusterId: string): Promise<ClusterSubscription | null> {
    const row = await this.db
      .prepare(
        `SELECT cluster_id, plan, polar_customer_id, polar_subscription_id, status, canceled_at, period_end, created_at, updated_at
         FROM billing WHERE cluster_id = $1`,
      )
      .bind(clusterId)
      .first();

    if (!row) return null;

    return {
      clusterId: row.cluster_id as string,
      plan: row.plan as SubscriptionPlan,
      polarCustomerId: row.polar_customer_id as string | null,
      polarSubscriptionId: row.polar_subscription_id as string | null,
      status: row.status as SubscriptionStatus,
      canceledAt: row.canceled_at as number | null,
      periodEnd: row.period_end as number | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  async getByPolarSubscriptionId(polarSubscriptionId: string): Promise<ClusterSubscription | null> {
    const row = await this.db
      .prepare(
        `SELECT cluster_id, plan, polar_customer_id, polar_subscription_id, status, canceled_at, period_end, created_at, updated_at
         FROM billing WHERE polar_subscription_id = $1`,
      )
      .bind(polarSubscriptionId)
      .first();

    if (!row) return null;

    return {
      clusterId: row.cluster_id as string,
      plan: row.plan as SubscriptionPlan,
      polarCustomerId: row.polar_customer_id as string | null,
      polarSubscriptionId: row.polar_subscription_id as string | null,
      status: row.status as SubscriptionStatus,
      canceledAt: row.canceled_at as number | null,
      periodEnd: row.period_end as number | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  async getByPolarCustomerId(polarCustomerId: string): Promise<ClusterSubscription | null> {
    const row = await this.db
      .prepare(
        `SELECT cluster_id, plan, polar_customer_id, polar_subscription_id, status, canceled_at, period_end, created_at, updated_at
         FROM billing WHERE polar_customer_id = $1`,
      )
      .bind(polarCustomerId)
      .first();

    if (!row) return null;

    return {
      clusterId: row.cluster_id as string,
      plan: row.plan as SubscriptionPlan,
      polarCustomerId: row.polar_customer_id as string | null,
      polarSubscriptionId: row.polar_subscription_id as string | null,
      status: row.status as SubscriptionStatus,
      canceledAt: row.canceled_at as number | null,
      periodEnd: row.period_end as number | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  async upsert(params: {
    clusterId: string;
    plan: SubscriptionPlan;
    polarCustomerId?: string | null;
    polarSubscriptionId?: string | null;
    status: SubscriptionStatus;
    canceledAt?: number | null;
    periodEnd?: number | null;
  }): Promise<void> {
    const now = this.now();

    try {
      await this.db
        .prepare(
          `INSERT INTO billing (cluster_id, plan, polar_customer_id, polar_subscription_id, status, canceled_at, period_end, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (cluster_id) DO UPDATE SET
           plan = EXCLUDED.plan,
           polar_customer_id = COALESCE(EXCLUDED.polar_customer_id, billing.polar_customer_id),
           polar_subscription_id = COALESCE(EXCLUDED.polar_subscription_id, billing.polar_subscription_id),
           status = EXCLUDED.status,
           canceled_at = COALESCE(EXCLUDED.canceled_at, billing.canceled_at),
           period_end = COALESCE(EXCLUDED.period_end, billing.period_end),
           updated_at = EXCLUDED.updated_at`,
        )
        .bind(params.clusterId, params.plan, params.polarCustomerId ?? null, params.polarSubscriptionId ?? null, params.status, params.canceledAt ?? null, params.periodEnd ?? null, now, now)
        .run();
    } catch (error) {
      this.parsePostgresError(error);
    }
  }

  async count(filter?: { status?: string; plan?: string }): Promise<number> {
    const { clause, bindings } = this.buildWhere({
      status: filter?.status,
      plan: filter?.plan,
    });
    const row = await (bindings.length
      ? this.db.prepare(`SELECT COUNT(*) AS count FROM billing ${clause}`).bind(...bindings).first<{ count: string }>()
      : this.db.prepare(`SELECT COUNT(*) AS count FROM billing`).first<{ count: string }>());
    return Number(row?.count ?? 0);
  }


  async getEffectivePlan(clusterId: string): Promise<SubscriptionPlan> {
    const sub = await this.get(clusterId);
    if (!sub) return "hobby";

    // If canceled, check grace period
    if (sub.status === "canceled") {
      if (sub.periodEnd && Date.now() < sub.periodEnd) {
        return sub.plan; // Still in grace period, keep paid plan
      }
      return "hobby"; // Grace period over
    }

    // Active or past_due - user has access to their plan
    return sub.plan;
  }
}
