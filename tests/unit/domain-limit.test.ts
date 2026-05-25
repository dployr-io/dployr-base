// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DOMAIN_LIMIT_BY_TIER } from "@/lib/constants/instances.js";

describe("DOMAIN_LIMIT_BY_TIER", () => {
  it("hobby plan allows 2 domains per service", () => {
    assert.equal(DOMAIN_LIMIT_BY_TIER.hobby, 2);
  });

  it("indie plan allows 10 domains per service", () => {
    assert.equal(DOMAIN_LIMIT_BY_TIER.indie, 10);
  });

  it("pro plan allows 25 domains per service", () => {
    assert.equal(DOMAIN_LIMIT_BY_TIER.pro, 25);
  });

  it("limits increase with each tier", () => {
    assert.ok(DOMAIN_LIMIT_BY_TIER.hobby < DOMAIN_LIMIT_BY_TIER.indie, "indie should exceed hobby");
    assert.ok(DOMAIN_LIMIT_BY_TIER.indie < DOMAIN_LIMIT_BY_TIER.pro, "pro should exceed indie");
  });

  it("all plans have defined limits", () => {
    for (const plan of ["hobby", "indie", "pro"] as const) {
      assert.ok(typeof DOMAIN_LIMIT_BY_TIER[plan] === "number", `${plan} must have a numeric limit`);
      assert.ok(DOMAIN_LIMIT_BY_TIER[plan] > 0, `${plan} limit must be positive`);
    }
  });
});
