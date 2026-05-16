// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { TraefikService } from "@/services/traefik-router.js";

// Minimal valid Prometheus text-format snippet using the real metric names
// Traefik emits (traefik_service_* with service="name@redis" labels).
const FIXTURE = `
# HELP traefik_service_requests_total Total requests processed.
# TYPE traefik_service_requests_total counter
traefik_service_requests_total{code="200",method="GET",protocol="http",service="ronaldo@redis"} 153
traefik_service_requests_total{code="304",method="GET",protocol="http",service="ronaldo@redis"} 76
traefik_service_requests_total{code="504",method="GET",protocol="http",service="ronaldo@redis"} 10
traefik_service_requests_total{code="200",method="GET",protocol="http",service="payper@redis"} 2
traefik_service_requests_total{code="504",method="GET",protocol="http",service="payper@redis"} 3
# HELP traefik_service_requests_bytes_total Total bytes received from clients.
# TYPE traefik_service_requests_bytes_total counter
traefik_service_requests_bytes_total{code="200",method="GET",protocol="http",service="ronaldo@redis"} 0
traefik_service_requests_bytes_total{code="200",method="POST",protocol="http",service="ronaldo@redis"} 1024
# HELP traefik_service_responses_bytes_total Total bytes sent to clients.
# TYPE traefik_service_responses_bytes_total counter
traefik_service_responses_bytes_total{code="200",method="GET",protocol="http",service="ronaldo@redis"} 312461
traefik_service_responses_bytes_total{code="304",method="GET",protocol="http",service="ronaldo@redis"} 0
traefik_service_responses_bytes_total{code="200",method="GET",protocol="http",service="payper@redis"} 4285
# Non-redis service — must be ignored
traefik_service_requests_total{code="200",method="POST",protocol="http",service="fw-registry@file"} 6
traefik_service_requests_total{code="200",method="GET",protocol="http",service="api@internal"} 99
`;

describe("TraefikService.parseMetrics", () => {
  it("returns one sample per @redis service", () => {
    const samples = TraefikService.parseMetrics(FIXTURE);
    assert.equal(samples.length, 2);
    const names = samples.map((s) => s.serviceName).sort();
    assert.deepEqual(names, ["payper", "ronaldo"]);
  });

  it("strips @redis suffix from service names", () => {
    const samples = TraefikService.parseMetrics(FIXTURE);
    assert.ok(samples.every((s) => !s.serviceName.includes("@")));
  });

  it("sums requests across all status codes", () => {
    const samples = TraefikService.parseMetrics(FIXTURE);
    const ronaldo = samples.find((s) => s.serviceName === "ronaldo")!;
    assert.equal(ronaldo.requests, 153 + 76 + 10); // 239
    const payper = samples.find((s) => s.serviceName === "payper")!;
    assert.equal(payper.requests, 2 + 3); // 5
  });

  it("sums bytesIn across all status codes and methods", () => {
    const samples = TraefikService.parseMetrics(FIXTURE);
    const ronaldo = samples.find((s) => s.serviceName === "ronaldo")!;
    assert.equal(ronaldo.bytesIn, 0 + 1024); // 1024
  });

  it("sums bytesOut across all status codes", () => {
    const samples = TraefikService.parseMetrics(FIXTURE);
    const ronaldo = samples.find((s) => s.serviceName === "ronaldo")!;
    assert.equal(ronaldo.bytesOut, 312461 + 0); // 312461
    const payper = samples.find((s) => s.serviceName === "payper")!;
    assert.equal(payper.bytesOut, 4285);
  });

  it("ignores @file and @internal services", () => {
    const samples = TraefikService.parseMetrics(FIXTURE);
    assert.ok(!samples.some((s) => s.serviceName === "fw-registry"));
    assert.ok(!samples.some((s) => s.serviceName === "api"));
  });

  it("returns empty array for empty input", () => {
    assert.deepEqual(TraefikService.parseMetrics(""), []);
  });

  it("skips comment and blank lines without throwing", () => {
    const input = "# HELP foo bar\n# TYPE foo counter\n\nfoo 1\n";
    assert.doesNotThrow(() => TraefikService.parseMetrics(input));
    assert.deepEqual(TraefikService.parseMetrics(input), []);
  });

  it("handles zero-value counters", () => {
    const input = `traefik_service_requests_total{code="200",method="GET",protocol="http",service="empty@redis"} 0\n`;
    const samples = TraefikService.parseMetrics(input);
    assert.equal(samples.length, 1);
    assert.equal(samples[0].requests, 0);
    assert.equal(samples[0].bytesIn, 0);
    assert.equal(samples[0].bytesOut, 0);
  });

  it("defaults bytesIn and bytesOut to 0 when byte metrics are absent", () => {
    const input = `traefik_service_requests_total{code="200",method="GET",protocol="http",service="minimal@redis"} 42\n`;
    const [sample] = TraefikService.parseMetrics(input);
    assert.equal(sample.serviceName, "minimal");
    assert.equal(sample.requests, 42);
    assert.equal(sample.bytesIn, 0);
    assert.equal(sample.bytesOut, 0);
  });
});
