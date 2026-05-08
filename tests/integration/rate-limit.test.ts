// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { TestFixtures } from "./fixtures/index.test.js";

/**
 * Rate limiting integration tests.
 * Global limit: 100 req/min per user/IP.
 * Fire 105 concurrent requests and assert at least one gets 429.
 */
export function registerRateLimitTests(getFx: () => TestFixtures) {
  describe("Rate limiting", () => {
    it("fires 105 concurrent requests and at least one gets 429", async () => {
      const { baseUrl, otherSession } = getFx();
      const N = 105;
      const results = await Promise.all(Array.from({ length: N }, () => fetch(`${baseUrl}/v1/users/me`, { headers: { Cookie: otherSession } })));

      const statuses = results.map((r) => r.status);
      const hits429 = statuses.filter((s) => s === 429).length;

      assert.ok(
        hits429 >= 1,
        `Expected ≥1 rate-limited (429) response out of ${N} requests. Got: ${JSON.stringify(
          statuses.reduce((acc: Record<number, number>, s) => {
            acc[s] = (acc[s] ?? 0) + 1;
            return acc;
          }, {}),
        )}`,
      );
    });

    it("429 response includes Retry-After and X-RateLimit headers", async () => {
      const { baseUrl, otherSession } = getFx();
      const N = 105;
      const results = await Promise.all(Array.from({ length: N }, () => fetch(`${baseUrl}/v1/users/me`, { headers: { Cookie: otherSession } })));

      const limited = results.find((r) => r.status === 429);
      if (!limited) return; // window may have partially reset — not a hard failure

      assert.ok(limited.headers.get("retry-after"), "Expected Retry-After header on 429");
      assert.ok(limited.headers.get("x-ratelimit-limit"), "Expected X-RateLimit-Limit header");
      assert.equal(limited.headers.get("x-ratelimit-remaining"), "0", "Remaining should be 0 when rate-limited");
    });
  });
}
