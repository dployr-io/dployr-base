// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createDomainVerificationJob } from "@/services/background/jobs/domain-verification.js";

type FakeDomain = {
  domain: string;
  status: "pending" | "active";
  verificationToken: string;
  clusterId: string;
  serviceName: string | null;
};

function makeCtx({
  domains = [] as FakeDomain[],
  traefikEnabled = true,
}: {
  domains?: FakeDomain[];
  traefikEnabled?: boolean;
} = {}) {
  const activated: string[] = [];
  const traefikRegistered: { domain: string; service: string }[] = [];
  const notifications: { clusterId: string; entity: string }[] = [];
  let output: Record<string, unknown> = {};

  const db = {
    domains: {
      list: async () => ({ domains }),
      activate: async (domain: string) => { activated.push(domain); },
    },
  } as any;

  const traefik = traefikEnabled
    ? { registerCustomDomain: async (domain: string, service: string) => { traefikRegistered.push({ domain, service }); } }
    : null;

  const adapters = {
    traefik,
    ws: {
      clientNotifier: {
        notifyRefresh: (clusterId: string, entity: string) => { notifications.push({ clusterId, entity }); },
      },
    },
  } as any;

  const setOutput = (o: Record<string, unknown>) => { output = { ...output, ...o }; };

  return { db, adapters, setOutput, activated, traefikRegistered, notifications, output: () => output };
}

function pending(overrides: Partial<FakeDomain> = {}): FakeDomain {
  return {
    domain: "app.example.com",
    status: "pending",
    verificationToken: "tok-abc",
    clusterId: "cluster-1",
    serviceName: "my-service",
    ...overrides,
  };
}

describe("domainVerification job", () => {
  it("does nothing when there are no pending domains", async () => {
    const { db, adapters, setOutput, activated, notifications, output } = makeCtx({ domains: [] });
    const job = createDomainVerificationJob(async () => false);
    await job({ db, adapters, setOutput } as any);

    assert.equal(activated.length, 0);
    assert.equal(notifications.length, 0);
    assert.deepEqual(output(), { checked: 0, verified: 0 });
  });

  it("skips active domains", async () => {
    const dom: FakeDomain = { ...pending(), status: "active" };
    const { db, adapters, setOutput, activated, notifications, output } = makeCtx({ domains: [dom] });
    const job = createDomainVerificationJob(async () => true);
    await job({ db, adapters, setOutput } as any);

    assert.equal(activated.length, 0);
    assert.equal(notifications.length, 0);
    assert.deepEqual(output(), { checked: 0, verified: 0 });
  });

  it("does not activate when TXT record is not yet propagated", async () => {
    const { db, adapters, setOutput, activated, notifications, output } = makeCtx({
      domains: [pending()],
    });
    const job = createDomainVerificationJob(async () => false);
    await job({ db, adapters, setOutput } as any);

    assert.equal(activated.length, 0);
    assert.equal(notifications.length, 0);
    assert.deepEqual(output(), { checked: 1, verified: 0 });
  });

  it("activates domain and registers Traefik route when TXT record confirms", async () => {
    const { db, adapters, setOutput, activated, traefikRegistered, notifications, output } = makeCtx({
      domains: [pending({ domain: "app.example.com", serviceName: "my-service", clusterId: "cluster-1" })],
    });
    const job = createDomainVerificationJob(async () => true);
    await job({ db, adapters, setOutput } as any);

    assert.deepEqual(activated, ["app.example.com"]);
    assert.deepEqual(traefikRegistered, [{ domain: "app.example.com", service: "my-service" }]);
    assert.deepEqual(notifications, [{ clusterId: "cluster-1", entity: "domains" }]);
    assert.deepEqual(output(), { checked: 1, verified: 1 });
  });

  it("activates domain but skips Traefik when serviceName is null", async () => {
    const { db, adapters, setOutput, activated, traefikRegistered, notifications } = makeCtx({
      domains: [pending({ serviceName: null })],
    });
    const job = createDomainVerificationJob(async () => true);
    await job({ db, adapters, setOutput } as any);

    assert.deepEqual(activated, ["app.example.com"]);
    assert.equal(traefikRegistered.length, 0);
    assert.equal(notifications.length, 1);
  });

  it("activates domain but skips Traefik when traefik adapter is absent", async () => {
    const { db, adapters, setOutput, traefikRegistered, notifications } = makeCtx({
      domains: [pending()],
      traefikEnabled: false,
    });
    const job = createDomainVerificationJob(async () => true);
    await job({ db, adapters, setOutput } as any);

    assert.equal(traefikRegistered.length, 0);
    assert.equal(notifications.length, 1);
  });

  it("continues processing remaining domains when one check throws", async () => {
    const dom1 = pending({ domain: "bad.example.com", clusterId: "c1" });
    const dom2 = pending({ domain: "good.example.com", clusterId: "c2" });
    const { db, adapters, setOutput, activated, notifications, output } = makeCtx({ domains: [dom1, dom2] });

    const checkFn = async (domain: string) => {
      if (domain === "bad.example.com") throw new Error("DNS timeout");
      return true;
    };

    const job = createDomainVerificationJob(checkFn);
    await job({ db, adapters, setOutput } as any);

    assert.deepEqual(activated, ["good.example.com"]);
    assert.deepEqual(notifications, [{ clusterId: "c2", entity: "domains" }]);
    assert.deepEqual(output(), { checked: 2, verified: 1 });
  });

  it("sends one WS notification per cluster, not per domain", async () => {
    const domains = [
      pending({ domain: "a.example.com", clusterId: "cluster-x" }),
      pending({ domain: "b.example.com", clusterId: "cluster-x" }),
      pending({ domain: "c.other.com", clusterId: "cluster-y" }),
    ];
    const { db, adapters, setOutput, notifications, output } = makeCtx({ domains });
    const job = createDomainVerificationJob(async () => true);
    await job({ db, adapters, setOutput } as any);

    assert.deepEqual(output(), { checked: 3, verified: 3 });
    const clusterIds = notifications.map((n) => n.clusterId).sort();
    assert.deepEqual(clusterIds, ["cluster-x", "cluster-y"]);
  });

  it("passes the correct domain and token to the check function", async () => {
    const calls: { domain: string; token: string }[] = [];
    const dom = pending({ domain: "verify.me", verificationToken: "secret-tok" });
    const { db, adapters, setOutput } = makeCtx({ domains: [dom] });

    const checkFn = async (domain: string, token: string) => {
      calls.push({ domain, token });
      return false;
    };

    const job = createDomainVerificationJob(checkFn);
    await job({ db, adapters, setOutput } as any);

    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { domain: "verify.me", token: "secret-tok" });
  });
});
