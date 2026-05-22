// Copyright 2025 Emmanuel Madehin
// SPDX-License-Identifier: Apache-2.0

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mergeSleepingServices } from "@/lib/node/sleeping.js";

const svc = (name: string, extra: Record<string, any> = {}) => ({ name, port: 3000, type: "web", ...extra });

describe("mergeSleepingServices", () => {
  it("returns data unchanged when no sleeping names", () => {
    const data = { services: [svc("api")], deployments: [] };
    const result = mergeSleepingServices(data, []);
    assert.deepEqual(result, data);
  });

  it("marks a service sleeping when it is in the sleeping list and present in workloads", () => {
    // This is the DB fallback bug case: service exists in DB data AND is sleeping
    const data = { services: [svc("ronaldo")], deployments: [] };
    const result = mergeSleepingServices(data, ["ronaldo"]);
    assert.equal(result.services[0].status, "sleeping");
  });

  it("preserves other fields on a sleeping service from DB", () => {
    const data = { services: [svc("ronaldo", { id: "svc-1", runtime: "node" })], deployments: [] };
    const result = mergeSleepingServices(data, ["ronaldo"]);
    assert.equal(result.services[0].id, "svc-1");
    assert.equal(result.services[0].runtime, "node");
    assert.equal(result.services[0].status, "sleeping");
  });

  it("adds stub entry for sleeping service absent from workloads (node-push path)", () => {
    // Node stopped the container — service is not in live workload report at all
    const data = { services: [], deployments: [] };
    const result = mergeSleepingServices(data, ["ronaldo"]);
    assert.equal(result.services.length, 1);
    assert.deepEqual(result.services[0], { name: "ronaldo", status: "sleeping" });
  });

  it("marks running services as running when other services are sleeping", () => {
    const data = { services: [svc("api"), svc("worker")], deployments: [] };
    const result = mergeSleepingServices(data, ["worker"]);
    const api = result.services.find((s: any) => s.name === "api");
    const worker = result.services.find((s: any) => s.name === "worker");
    assert.equal(api.status, "running");
    assert.equal(worker.status, "sleeping");
  });

  it("handles multiple sleeping services", () => {
    const data = { services: [svc("a"), svc("b"), svc("c")], deployments: [] };
    const result = mergeSleepingServices(data, ["a", "c"]);
    const statuses = Object.fromEntries(result.services.map((s: any) => [s.name, s.status]));
    assert.deepEqual(statuses, { a: "sleeping", b: "running", c: "sleeping" });
  });

  it("adds stubs for sleeping services absent from the list while marking present ones", () => {
    // Mixed: "api" is in workloads (running), "gone" is absent, "ronaldo" is in workloads but sleeping
    const data = { services: [svc("api"), svc("ronaldo")], deployments: [] };
    const result = mergeSleepingServices(data, ["ronaldo", "gone"]);
    const byName = Object.fromEntries(result.services.map((s: any) => [s.name, s.status]));
    assert.deepEqual(byName, { api: "running", ronaldo: "sleeping", gone: "sleeping" });
  });

  it("does not mutate the original workloads data", () => {
    const data = { services: [svc("api")], deployments: [] };
    const original = JSON.parse(JSON.stringify(data));
    mergeSleepingServices(data, ["api"]);
    assert.deepEqual(data, original);
  });

  it("handles missing services array gracefully", () => {
    const data = { deployments: [] };
    const result = mergeSleepingServices(data, ["ronaldo"]);
    assert.equal(result.services.length, 1);
    assert.equal(result.services[0].status, "sleeping");
  });
});
