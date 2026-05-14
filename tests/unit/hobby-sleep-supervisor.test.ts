// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isGenuinelyIdle, type TrafficSignal } from "@/services/background/jobs/hobby-sleep-supervisor.js";

function sig(overrides: Partial<TrafficSignal> = {}): TrafficSignal {
  return {
    domain: "app.example.com",
    request_count: 10,
    unique_subnets: 5,
    cadence_cv: 0.8,
    unique_paths: 4,
    last_request_at: Date.now(),
    ...overrides,
  };
}

describe("isGenuinelyIdle — bot-detection", () => {
  it("returns true when request_count is 0", () => {
    assert.equal(isGenuinelyIdle(sig({ request_count: 0 })), true);
  });

  it("returns true when all three signals are bot-like", () => {
    assert.equal(
      isGenuinelyIdle(sig({ unique_subnets: 1, cadence_cv: 0.1, unique_paths: 1 })),
      true,
    );
  });

  it("returns false when subnets are human-like (≥3) even if other signals are bot-like", () => {
    assert.equal(
      isGenuinelyIdle(sig({ unique_subnets: 3, cadence_cv: 0.1, unique_paths: 1 })),
      false,
    );
  });

  it("returns false when cadence_cv is human-like (≥0.2) even if other signals are bot-like", () => {
    assert.equal(
      isGenuinelyIdle(sig({ unique_subnets: 1, cadence_cv: 0.2, unique_paths: 1 })),
      false,
    );
  });

  it("returns false when unique_paths is human-like (≥2) even if other signals are bot-like", () => {
    assert.equal(
      isGenuinelyIdle(sig({ unique_subnets: 1, cadence_cv: 0.1, unique_paths: 2 })),
      false,
    );
  });

  it("returns false when only subnets and cadence are bot-like but paths are human-like", () => {
    assert.equal(
      isGenuinelyIdle(sig({ unique_subnets: 2, cadence_cv: 0.1, unique_paths: 3 })),
      false,
    );
  });

  it("returns false when only subnets and paths are bot-like but cadence is human-like", () => {
    assert.equal(
      isGenuinelyIdle(sig({ unique_subnets: 2, cadence_cv: 0.5, unique_paths: 1 })),
      false,
    );
  });

  it("returns false for clearly human traffic across all signals", () => {
    assert.equal(
      isGenuinelyIdle(sig({ unique_subnets: 10, cadence_cv: 0.9, unique_paths: 12 })),
      false,
    );
  });

  it("treats threshold values as boundary: subnets=2 is still bot-like", () => {
    assert.equal(
      isGenuinelyIdle(sig({ unique_subnets: 2, cadence_cv: 0.1, unique_paths: 1 })),
      true,
    );
  });
});
