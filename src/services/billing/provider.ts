// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { SubscriptionPlan } from "@/types/index.js";

export interface CustomerParams {
  clusterId: string;
  userId: string;
  email: string;
  name?: string | null;
}

export type BillingInterval = "monthly" | "annual";

export interface CheckoutParams extends CustomerParams {
  plan: SubscriptionPlan;
  interval: BillingInterval;
  successUrl?: string;
}

export interface RawWebhookEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface BillingProvider {
  updateCustomerEmail(params: { externalId: string; email: string; name?: string }): Promise<{ id: string; email: string } | null>;
  createCheckoutSession(params: CheckoutParams): Promise<string>;
  createCustomerPortalSession(clusterId: string): Promise<string>;
  verifyWebhookSignature(params: { rawBody: string; signatureHeader: string; webhookId: string; webhookTimestamp: string }): Promise<boolean>;
  parseWebhookEvent(rawBody: string): Promise<RawWebhookEvent>;
}
