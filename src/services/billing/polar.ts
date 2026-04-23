// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { Bindings } from "@/types/index.js";
import { PolarRequestValidationError } from "@/lib/errors/errors.js";
import { BillingProvider, CustomerParams, CheckoutParams, RawWebhookEvent } from "./provider.js";

export class PolarService implements BillingProvider {
  private baseUrl: string;
  private accessToken: string;
  private webhookSecret: string;

  constructor(private env: Bindings) {
    const isSandbox = (env.POLAR_ENVIRONMENT || "sandbox") !== "production";
    this.baseUrl = isSandbox ? "https://sandbox-api.polar.sh/v1" : "https://api.polar.sh/v1";
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
    const existing = await fetch(`${this.baseUrl}/customers/external/${encodeURIComponent(params.clusterId)}`, { headers: this.headers });

    if (existing.ok) {
      return existing.json() as Promise<{ id: string; email: string }>;
    }

    const created = await fetch(`${this.baseUrl}/customers/`, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify({
        email: params.email,
        name: params.name || params.email,
        external_id: params.clusterId,
      }),
    });

    if (!created.ok) {
      const err = await created.text();
      try {
        const parsed = JSON.parse(err);
        if (typeof parsed === "object" && parsed !== null && "detail" in parsed) {
          const detail = Array.isArray(parsed.detail) ? parsed.detail : [];
          throw new PolarRequestValidationError(parsed.error?.field, detail);
        }
      } catch (e) {
        if (e instanceof PolarRequestValidationError) throw e;
      }
      throw new Error(`[PolarService] Failed to create customer — ${err}`);
    }

    return created.json() as Promise<{ id: string; email: string }>;
  }

  async buildCheckoutUrl(params: CheckoutParams): Promise<string> {
    const { plan, clusterId, userId, email, successUrl } = params;

    const checkoutBaseUrl = this.env.BILLING_CHECKOUT_URLS?.[plan];
    if (!checkoutBaseUrl) {
      throw new Error(`[PolarService] No checkout URL configured for plan: ${plan}`);
    }

    const baseSuccessUrl = successUrl || `${this.env.APP_URL}/clusters`;
    const resolvedSuccessUrl = new URL(baseSuccessUrl);
    resolvedSuccessUrl.searchParams.set("clusterId", clusterId);

    const checkoutUrl = new URL(checkoutBaseUrl);
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

    return res.json() as Promise<{ id: string; url: string }>;
  }

  async verifyWebhookSignature(params: { rawBody: string; signatureHeader: string; webhookId: string; webhookTimestamp: string }): Promise<boolean> {
    if (!this.webhookSecret) return false;

    try {
      const signedPayload = `${params.webhookId}.${params.webhookTimestamp}.${params.rawBody}`;

      const encoder = new TextEncoder();
      const key = await crypto.subtle.importKey("raw", encoder.encode(this.webhookSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);

      const signatureBytes = await crypto.subtle.sign("HMAC", key, encoder.encode(signedPayload));

      const receivedSig = params.signatureHeader.split(",")[1]?.trim();
      if (!receivedSig) return false;

      const computed = btoa(String.fromCharCode(...new Uint8Array(signatureBytes)));

      return computed === receivedSig;
    } catch (error) {
      console.error("[PolarService] signature verification error:", error);
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
    const res = await fetch(`${this.baseUrl}/subscriptions/${subscriptionId}`, { headers: this.headers });
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
