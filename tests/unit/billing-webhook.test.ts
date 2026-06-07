// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { BillingService } from "@/services/billing/index.js";
import type { ClusterSubscription } from "@/types/index.js";


function makeSubscription(overrides: Partial<ClusterSubscription> = {}): ClusterSubscription {
  return {
    clusterId: "cluster-abc",
    plan: "hobby",
    polarCustomerId: "polar-cust-1",
    polarSubscriptionId: null,
    status: "active",
    canceledAt: null,
    periodEnd: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

function makeBillingStore(initial?: ClusterSubscription) {
  const rows: Map<string, ClusterSubscription> = new Map();
  if (initial) rows.set(initial.clusterId, initial);

  return {
    upserted: [] as ClusterSubscription[],

    async get(clusterId: string) {
      return rows.get(clusterId) ?? null;
    },
    async getByPolarSubscriptionId(id: string) {
      for (const row of rows.values()) {
        if (row.polarSubscriptionId === id) return row;
      }
      return null;
    },
    async getByPolarCustomerId(id: string) {
      for (const row of rows.values()) {
        if (row.polarCustomerId === id) return row;
      }
      return null;
    },
    async getEffectivePlan(clusterId: string) {
      return rows.get(clusterId)?.plan ?? "hobby";
    },
    async upsert(params: ClusterSubscription) {
      this.upserted.push({ ...params });
      rows.set(params.clusterId, { ...makeSubscription(), ...params, updatedAt: Date.now() });
    },
  };
}

function makeDb(billing: ReturnType<typeof makeBillingStore>) {
  return {
    billing,
    clusters: {
      async get() { return null; },
    },
    instances: {
      async releasePoolInstance() {},
      async releaseDedicatedInstance() {},
      async assignPool() {},
      async transitionToSharedPool() {},
    },
  } as any;
}

function makeTrackedDb(billing: ReturnType<typeof makeBillingStore>) {
  const calls: { method: string; args: unknown[] }[] = [];
  return {
    db: {
      billing,
      clusters: { async get() { return null; } },
      instances: {
        async releasePoolInstance(clusterId: string) { calls.push({ method: "releasePoolInstance", args: [clusterId] }); },
        async releaseDedicatedInstance(clusterId: string) { calls.push({ method: "releaseDedicatedInstance", args: [clusterId] }); },
        async assignPool(clusterId: string, tier: string) { calls.push({ method: "assignPool", args: [clusterId, tier] }); },
        async transitionToSharedPool(clusterId: string, tier: string) { calls.push({ method: "transitionToSharedPool", args: [clusterId, tier] }); },
      },
    } as any,
    calls,
    calledMethods() { return calls.map((c) => c.method); },
    transitionTiers() { return calls.filter((c) => c.method === "transitionToSharedPool").map((c) => c.args[1]); },
  };
}

function makeKv() {
  return {
    async getbillingNotification() { return null; },
    async setReminderNotification() {},
  } as any;
}

function makeProvider() {
  return {} as any;
}

function makeService() {
  return new BillingService(makeProvider(), null);
}


function subPayload({
  subscriptionId = "sub-xyz",
  customerId = "polar-cust-1",
  externalId = null as string | null,
  productName = "Indie",
  status = "active",
  periodEnd = null as string | null,
} = {}) {
  return {
    id: subscriptionId,
    status,
    current_period_end: periodEnd,
    canceled_at: null,
    customer: {
      id: customerId,
      external_id: externalId,
    },
    product: { name: productName },
  } as Record<string, unknown>;
}


describe("BillingService.handleWebhook — subscription.created/updated", () => {
  it("updates the DB when customer.external_id carries the cluster_id", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc" }));
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.updated", data: subPayload({ externalId: "cluster-abc", productName: "Indie" }) },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted.length, 1);
    assert.equal(billing.upserted[0].clusterId, "cluster-abc");
    assert.equal(billing.upserted[0].plan, "indie");
    assert.equal(billing.upserted[0].status, "active");
    assert.equal(billing.upserted[0].polarSubscriptionId, "sub-xyz");
  });

  it("falls back to polar_customer_id lookup when external_id is missing (the regression)", async () => {
    // This is the exact scenario that was broken:
    // - createCheckout() stored polar_customer_id but no polar_subscription_id
    // - Polar fires subscription.updated without external_id
    // - Previously: hard bail-out → DB never updated
    // - Now: should resolve cluster via polar_customer_id fallback
    const existing = makeSubscription({
      clusterId: "cluster-abc",
      polarCustomerId: "polar-cust-1",
      polarSubscriptionId: null,
      plan: "hobby",
    });
    const billing = makeBillingStore(existing);
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      {
        type: "subscription.updated",
        data: subPayload({
          externalId: null,           // ← external_id absent from Polar payload
          customerId: "polar-cust-1", // ← but customer_id is present
          subscriptionId: "sub-xyz",
          productName: "Indie",
        }),
      },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted.length, 1, "DB must be updated via customer ID fallback");
    assert.equal(billing.upserted[0].clusterId, "cluster-abc");
    assert.equal(billing.upserted[0].plan, "indie");
    assert.equal(billing.upserted[0].polarSubscriptionId, "sub-xyz");
  });

  it("falls back to polar_subscription_id lookup when external_id is missing on subsequent updates", async () => {
    const existing = makeSubscription({
      clusterId: "cluster-abc",
      polarCustomerId: "polar-cust-1",
      polarSubscriptionId: "sub-xyz", // already stored from a prior sync
      plan: "indie",
    });
    const billing = makeBillingStore(existing);
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      {
        type: "subscription.updated",
        data: subPayload({
          externalId: null,
          subscriptionId: "sub-xyz",
          productName: "Pro",
        }),
      },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted.length, 1, "DB must be updated via subscription ID fallback");
    assert.equal(billing.upserted[0].clusterId, "cluster-abc");
    assert.equal(billing.upserted[0].plan, "pro");
  });

  it("resolves cluster_id from subscription metadata when customer.external_id is absent", async () => {
    // buildCheckoutUrl sets metadata[cluster_id] on the Polar checkout link.
    // Polar attaches this metadata to the subscription and includes it in webhooks.
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc" }));
    const db = makeDb(billing);
    const service = makeService();

    const payload: Record<string, unknown> = {
      id: "sub-xyz",
      status: "active",
      current_period_end: null,
      canceled_at: null,
      customer: { id: "polar-cust-1", external_id: null },
      metadata: { cluster_id: "cluster-abc", user_id: "user-1" }, // ← from buildCheckoutUrl
      product: { name: "Indie" },
    };

    await service.handleWebhook({ type: "subscription.updated", data: payload }, db, makeKv());

    assert.equal(billing.upserted.length, 1, "DB must be updated via subscription metadata");
    assert.equal(billing.upserted[0].clusterId, "cluster-abc");
    assert.equal(billing.upserted[0].plan, "indie");
  });

  it("skips (does not throw) when no cluster can be resolved at all", async () => {
    const billing = makeBillingStore(); // empty store
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      {
        type: "subscription.updated",
        data: subPayload({ externalId: null, customerId: "unknown-cust", subscriptionId: "unknown-sub" }),
      },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted.length, 0, "Nothing should be written when cluster cannot be resolved");
  });

  it("resolves correct plan from product name (pro)", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc", polarCustomerId: "polar-cust-1" }));
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.created", data: subPayload({ externalId: "cluster-abc", productName: "Pro" }) },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted[0].plan, "pro");
  });

  it("sets status to past_due when polar status is past_due", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc" }));
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      {
        type: "subscription.updated",
        data: subPayload({ externalId: "cluster-abc", status: "past_due" }),
      },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted[0].status, "past_due");
  });
});

describe("BillingService.handleWebhook — subscription.canceled", () => {
  it("marks subscription canceled by polar_subscription_id", async () => {
    const existing = makeSubscription({
      clusterId: "cluster-abc",
      polarCustomerId: "polar-cust-1",
      polarSubscriptionId: "sub-xyz",
      plan: "indie",
    });
    const billing = makeBillingStore(existing);
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.canceled", data: subPayload({ subscriptionId: "sub-xyz", externalId: null }) },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted[0].status, "canceled");
    assert.equal(billing.upserted[0].clusterId, "cluster-abc");
  });

  it("marks subscription canceled by external_id when no subscription_id in payload", async () => {
    // onSubscriptionCanceled only uses the external_id branch when polarSubscriptionId is absent.
    // Build a payload with no `id` field so getPolarSubscriptionId returns null.
    const existing = makeSubscription({
      clusterId: "cluster-abc",
      polarCustomerId: "polar-cust-1",
      polarSubscriptionId: "sub-xyz",
    });
    const billing = makeBillingStore(existing);
    const db = makeDb(billing);
    const service = makeService();

    const payloadWithoutSubId: Record<string, unknown> = {
      // no `id` key — polarSubscriptionId resolves to null
      status: "active",
      current_period_end: null,
      canceled_at: null,
      customer: { id: "polar-cust-1", external_id: "cluster-abc" },
      product: { name: "Indie" },
    };

    await service.handleWebhook(
      { type: "subscription.canceled", data: payloadWithoutSubId },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted[0].status, "canceled");
    assert.equal(billing.upserted[0].clusterId, "cluster-abc");
  });
});

describe("BillingService.handleWebhook — subscription.revoked", () => {
  it("downgrades cluster to hobby on revocation", async () => {
    const existing = makeSubscription({
      clusterId: "cluster-abc",
      polarSubscriptionId: "sub-xyz",
      plan: "indie",
    });
    const billing = makeBillingStore(existing);
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.revoked", data: subPayload({ subscriptionId: "sub-xyz" }) },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted[0].plan, "hobby");
    assert.equal(billing.upserted[0].status, "active");
  });
});

describe("BillingService.handleWebhook — subscription.uncanceled", () => {
  it("restores subscription to active", async () => {
    const existing = makeSubscription({
      clusterId: "cluster-abc",
      polarSubscriptionId: "sub-xyz",
      plan: "indie",
      status: "canceled",
    });
    const billing = makeBillingStore(existing);
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.uncanceled", data: subPayload({ subscriptionId: "sub-xyz" }) },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted[0].status, "active");
    assert.equal(billing.upserted[0].plan, "indie");
    assert.equal(billing.upserted[0].canceledAt, null);
  });
});

describe("BillingService.handleWebhook — subscription.past_due", () => {
  it("marks subscription past_due via external_id", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc" }));
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.past_due", data: subPayload({ externalId: "cluster-abc" }) },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted[0].status, "past_due");
  });

  it("marks subscription past_due via polar_subscription_id fallback when external_id missing", async () => {
    const existing = makeSubscription({
      clusterId: "cluster-abc",
      polarSubscriptionId: "sub-xyz",
    });
    const billing = makeBillingStore(existing);
    const db = makeDb(billing);
    const service = makeService();

    await service.handleWebhook(
      {
        type: "subscription.past_due",
        data: subPayload({ externalId: null, subscriptionId: "sub-xyz" }),
      },
      db,
      makeKv(),
    );

    assert.equal(billing.upserted[0].status, "past_due");
    assert.equal(billing.upserted[0].clusterId, "cluster-abc");
  });
});

describe("BillingService — transitionPlan instance reallocation", () => {
  it("upgrade hobby→pro: releases pool and clears stale dedicated (no shared pool assignment)", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc", plan: "hobby" }));
    const { db, calledMethods } = makeTrackedDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.updated", data: subPayload({ externalId: "cluster-abc", productName: "Pro" }) },
      db,
      makeKv(),
    );

    assert.ok(calledMethods().includes("releasePoolInstance"), "must release pool slot");
    assert.ok(calledMethods().includes("releaseDedicatedInstance"), "must clear stale dedicated");
    assert.ok(!calledMethods().includes("assignPool"), "must not assign a shared pool on pro upgrade");
    assert.ok(!calledMethods().includes("transitionToSharedPool"), "must not call transitionToSharedPool on pro upgrade");
  });

  it("upgrade indie→pro: releases pool and clears stale dedicated", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc", plan: "indie" }));
    const { db, calledMethods } = makeTrackedDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.updated", data: subPayload({ externalId: "cluster-abc", productName: "Pro" }) },
      db,
      makeKv(),
    );

    assert.ok(calledMethods().includes("releasePoolInstance"), "must release pool slot");
    assert.ok(calledMethods().includes("releaseDedicatedInstance"), "must clear stale dedicated");
    assert.ok(!calledMethods().includes("transitionToSharedPool"), "must not call transitionToSharedPool on pro upgrade");
  });

  it("downgrade pro→indie: uses atomic transitionToSharedPool with indie tier", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc", plan: "pro", polarSubscriptionId: "sub-xyz" }));
    const { db, calledMethods, transitionTiers } = makeTrackedDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.updated", data: subPayload({ externalId: "cluster-abc", productName: "Indie" }) },
      db,
      makeKv(),
    );

    assert.ok(calledMethods().includes("transitionToSharedPool"), "must use atomic transitionToSharedPool");
    assert.equal(transitionTiers()[0], "indie", "must target indie tier pool");
    assert.ok(!calledMethods().includes("releasePoolInstance"), "must not call releasePoolInstance separately");
    assert.ok(!calledMethods().includes("releaseDedicatedInstance"), "must not call releaseDedicatedInstance separately");
    assert.ok(!calledMethods().includes("assignPool"), "must not call assignPool separately");
  });

  it("downgrade pro→hobby (revoked): uses atomic transitionToSharedPool with hobby tier", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc", plan: "pro", polarSubscriptionId: "sub-xyz" }));
    const { db, calledMethods, transitionTiers } = makeTrackedDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.revoked", data: subPayload({ subscriptionId: "sub-xyz" }) },
      db,
      makeKv(),
    );

    assert.ok(calledMethods().includes("transitionToSharedPool"), "must use atomic transitionToSharedPool");
    assert.equal(transitionTiers()[0], "hobby", "must target hobby tier pool");
    assert.ok(!calledMethods().includes("releaseDedicatedInstance"), "must not call releaseDedicatedInstance separately");
    assert.ok(!calledMethods().includes("assignPool"), "must not call assignPool separately");
  });

  it("hobby→indie swap: releases pool and assigns indie pool directly (no transitionToSharedPool)", async () => {
    const billing = makeBillingStore(makeSubscription({ clusterId: "cluster-abc", plan: "hobby" }));
    const { db, calledMethods, calls } = makeTrackedDb(billing);
    const service = makeService();

    await service.handleWebhook(
      { type: "subscription.updated", data: subPayload({ externalId: "cluster-abc", productName: "Indie" }) },
      db,
      makeKv(),
    );

    assert.ok(calledMethods().includes("releasePoolInstance"), "must release hobby pool slot");
    assert.ok(calledMethods().includes("assignPool"), "must assign to indie pool");
    assert.equal(calls.find((c) => c.method === "assignPool")?.args[1], "indie", "must assign to indie tier pool");
    assert.ok(!calledMethods().includes("transitionToSharedPool"), "must not use transitionToSharedPool for shared-tier swaps");
  });
});

describe("BillingService.handleWebhook — unhandled events", () => {
  it("does not throw on order.created", async () => {
    const billing = makeBillingStore();
    const db = makeDb(billing);
    const service = makeService();

    await assert.doesNotReject(
      service.handleWebhook({ type: "order.created", data: { id: "order-1" } }, db, makeKv()),
    );
    assert.equal(billing.upserted.length, 0);
  });

  it("does not throw on unknown event types", async () => {
    const billing = makeBillingStore();
    const db = makeDb(billing);
    const service = makeService();

    await assert.doesNotReject(
      service.handleWebhook({ type: "order.paid", data: {} }, db, makeKv()),
    );
  });
});
