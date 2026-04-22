// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings } from "@/types/index.js";
import type { BillingProvider, CheckoutParams, CustomerParams, RawWebhookEvent } from "./billing/provider.js";
import { PLANS } from "@/lib/constants/billing.js";

export class PolarService implements BillingProvider {
  private baseUrl: string;
  private accessToken: string;
  private webhookSecret: string;

  constructor(private env: Bindings) {
    const isSandbox =
      (env.POLAR_ENVIRONMENT || "sandbox") !== "production";
    this.baseUrl = isSandbox
      ? "https://sandbox-api.polar.sh/v1"
      : "https://api.polar.sh/v1";
    this.accessToken = env.POLAR_ACCESS_TOKEN || "";
    this.webhookSecret = env.POLAR_WEBHOOK_SECRET || "";
  }

  private get headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    };
  }

  async getOrCreateCustomer(params: CustomerParams): Promise<{ id: string; email: string }> {
    const existing = await fetch(
      `${this.baseUrl}/customers/external/${encodeURIComponent(params.userId)}`,
      { headers: this.headers }
    );

    if (existing.ok) {
      const data = await existing.json() as { id: string; email: string };
      return data;
    }

    const created = await fetch(`${this.baseUrl}/customers/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        email: params.email,
        name: params.name || params.email,
        external_id: params.userId,
      }),
    });

    if (!created.ok) {
      const err = await created.text();
      throw new Error(`[PolarService] Failed to create customer — ${err}`);
    }

    return created.json() as Promise<{ id: string; email: string }>;
  }

  async buildCheckoutUrl(params: CheckoutParams): Promise<string> {
    const { plan, clusterId, userId, email, name, successUrl } = params;
    
    const customer = await this.getOrCreateCustomer({ userId, email, name });
    
    const planDef = PLANS.find((p) => p.id === plan);
    if (!planDef) {
      throw new Error(`[PolarService] Unknown plan: ${plan}`);
    }
    
    const baseSuccessUrl = successUrl || `${this.env.APP_URL}/clusters`;
    const resolvedSuccessUrl = new URL(baseSuccessUrl);
    resolvedSuccessUrl.searchParams.set("clusterId", clusterId);

    const checkoutUrl = new URL(planDef.checkoutUrl as string);
    checkoutUrl.searchParams.set("customer_email", email);
    checkoutUrl.searchParams.set("success_url", resolvedSuccessUrl.toString());
    checkoutUrl.searchParams.set("metadata[cluster_id]", clusterId);
    checkoutUrl.searchParams.set("metadata[user_id]", userId);

    return checkoutUrl.toString();
  }

  async createCheckoutSession(params: {
    productPriceId: string;
    customerEmail: string;
    customerId?: string;
    successUrl: string;
    metadata?: Record<string, string>;
  }): Promise<{ id: string; url: string }> {
    const body: Record<string, unknown> = {
      product_price_id: params.productPriceId,
      success_url: params.successUrl,
      customer_email: params.customerEmail,
      metadata: params.metadata || {},
    };

    if (params.customerId) {
      body.customer_id = params.customerId;
    }

    const res = await fetch(`${this.baseUrl}/checkouts/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`[PolarService] Failed to create checkout session — ${err}`);
    }

    const data = await res.json() as { id: string; url: string };
    return data;
  }

  async verifyWebhookSignature(params: {
    rawBody: string;
    signatureHeader: string;
  }): Promise<boolean> {
    if (!this.webhookSecret) return false;

    try {
      const signatures = params.signatureHeader
        .split(" ")
        .map((s) => s.trim())
        .filter(Boolean);

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey(
        "raw",
        encoder.encode(this.webhookSecret),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign"]
      );

      const signatureBytes = await crypto.subtle.sign(
        "HMAC",
        key,
        encoder.encode(params.rawBody)
      );

      const computed = `v1=${Array.from(new Uint8Array(signatureBytes))
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("")}`;

      return signatures.includes(computed);
    } catch {
      return false;
    }
  }

  async parseWebhookEvent(rawBody: string): Promise<RawWebhookEvent> {
    try {
      const event = JSON.parse(rawBody);
      if (!event.type || !event.data) {
        throw new Error("[PolarService] Invalid webhook event format");
      }
      return event as RawWebhookEvent;
    } catch {
      throw new Error("[PolarService] Failed to parse webhook event");
    }
  }

  async getSubscription(subscriptionId: string): Promise<{
    id: string;
    status: string;
    product_id: string;
    customer_id: string;
    metadata: Record<string, string>;
  } | null> {
    const res = await fetch(
      `${this.baseUrl}/subscriptions/${subscriptionId}`,
      { headers: this.headers }
    );

    if (!res.ok) return null;

    return res.json() as Promise<{
      id: string;
      status: string;
      product_id: string;
      customer_id: string;
      metadata: Record<string, string>;
    }>;
  }
}