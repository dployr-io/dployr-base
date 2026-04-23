// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import type { SubscriptionPlan } from "@/types/index.js";

export interface CustomerParams {
  clusterId: string
  userId: string
  email: string
  name?: string
}

export interface CheckoutParams extends CustomerParams {
  plan: SubscriptionPlan
  successUrl?: string
}

export interface RawWebhookEvent {
  type: string
  data: Record<string, unknown>
}

export interface BillingProvider {
  getOrCreateCustomer(params: CustomerParams): Promise<{ id: string; email: string }>
  buildCheckoutUrl(params: CheckoutParams): Promise<string>
  verifyWebhookSignature(params: { rawBody: string; signatureHeader: string; webhookId: string; webhookTimestamp: string }): Promise<boolean>
  parseWebhookEvent(rawBody: string): Promise<RawWebhookEvent>
}