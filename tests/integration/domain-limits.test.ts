// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";
import { DOMAIN_LIMIT_BY_TIER } from "@/lib/constants/instances.js";

export function registerDomainLimitTests(getFx: () => TestFixtures) {
  describe("Domain tier limits", () => {
    const ts = Date.now().toString(36);
    const serviceName = `ci-dom-svc-${ts}`;
    const domain1 = `ci-dom1-${ts}.example.com`;
    const domain2 = `ci-dom2-${ts}.example.com`;
    const domain3 = `ci-dom3-${ts}.example.com`;

    before(async () => {
      const { limitClusterId, insertServiceWithName, setClusterPlan } = getFx();
      // Start on hobby and seed the service the domains will attach to
      await setClusterPlan(limitClusterId, "hobby");
      await insertServiceWithName(limitClusterId, serviceName);
    });

    after(async () => {
      // Reset limit cluster back to hobby so service-limit tests are unaffected
      const { limitClusterId, setClusterPlan } = getFx();
      await setClusterPlan(limitClusterId, "hobby");
    });

    async function addDomain(domain: string) {
      const { baseUrl, limitSession, limitClusterId } = getFx();
      return fetch(`${baseUrl}/v1/domains`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: limitSession },
        body: JSON.stringify({ domain, clusterId: limitClusterId, serviceName }),
      });
    }

    it(`hobby plan (limit=${DOMAIN_LIMIT_BY_TIER.hobby}): first domain is accepted`, async () => {
      const res = await addDomain(domain1);
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    });

    it(`hobby plan (limit=${DOMAIN_LIMIT_BY_TIER.hobby}): second domain is accepted`, async () => {
      const res = await addDomain(domain2);
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200, got ${res.status}: ${JSON.stringify(body)}`);
    });

    it(`hobby plan (limit=${DOMAIN_LIMIT_BY_TIER.hobby}): third domain is blocked`, async () => {
      const res = await addDomain(domain3);
      const body = (await res.json()) as any;
      assert.equal(res.status, 400, `Expected 400 (domain limit), got ${res.status}: ${JSON.stringify(body)}`);
      const code = body.error?.code ?? body.code;
      assert.equal(code, "request.bad_request", `Expected request.bad_request, got ${code}`);
    });

    it(`re-adding an existing domain bypasses the limit check`, async () => {
      // domain1 already exists for this cluster — should return its setup details, not 400
      const res = await addDomain(domain1);
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200 for re-add, got ${res.status}: ${JSON.stringify(body)}`);
    });

    it(`upgrading to indie (limit=${DOMAIN_LIMIT_BY_TIER.indie}): third domain is now accepted`, async () => {
      const { limitClusterId, setClusterPlan } = getFx();
      await setClusterPlan(limitClusterId, "indie");

      const res = await addDomain(domain3);
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200 after indie upgrade, got ${res.status}: ${JSON.stringify(body)}`);
    });

    it(`indie plan (limit=${DOMAIN_LIMIT_BY_TIER.indie}): blocked when limit is reached`, async () => {
      const { limitClusterId, insertFakeDomains } = getFx();
      // domain1, domain2, domain3 already exist (3). Fill remaining slots to hit indie limit.
      await insertFakeDomains(limitClusterId, serviceName, DOMAIN_LIMIT_BY_TIER.indie - 3);

      const overflowDomain = `ci-dom-over-${ts}.example.com`;
      const res = await addDomain(overflowDomain);
      const body = (await res.json()) as any;
      assert.equal(res.status, 400, `Expected 400 at indie limit, got ${res.status}: ${JSON.stringify(body)}`);
      const code = body.error?.code ?? body.code;
      assert.equal(code, "request.bad_request", `Expected request.bad_request, got ${code}`);
    });

    it(`upgrading to pro (limit=${DOMAIN_LIMIT_BY_TIER.pro}): overflow domain is now accepted`, async () => {
      const { limitClusterId, setClusterPlan } = getFx();
      await setClusterPlan(limitClusterId, "pro");

      const overflowDomain = `ci-dom-over-${ts}.example.com`;
      const res = await addDomain(overflowDomain);
      const body = (await res.json()) as any;
      assert.equal(res.status, 200, `Expected 200 after pro upgrade, got ${res.status}: ${JSON.stringify(body)}`);
    });
  });
}
